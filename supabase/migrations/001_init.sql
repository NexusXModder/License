-- =====================================================================
-- Nexus License System - Migration 001 (link-safe version)
-- Schema, atomic license functions, Row Level Security
-- Non-destructive: only CREATE statements
-- =====================================================================

begin;

set local search_path = public, extensions;

-- ---------------------------------------------------------------------
-- Trigger helpers
-- ---------------------------------------------------------------------
create or replace function nexus_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object('updated_at', now()));
  return new;
end;
$$;

create or replace function nexus_license_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_new jsonb;
  v_old jsonb;
begin
  v_new := to_jsonb(new);
  v_old := to_jsonb(old);

  if (v_new ->> 'key_hash') is distinct from (v_old ->> 'key_hash') then
    raise exception 'key_hash is immutable' using errcode = 'P0001';
  end if;
  if (v_new ->> 'app_id') is distinct from (v_old ->> 'app_id') then
    raise exception 'app_id is immutable' using errcode = 'P0001';
  end if;
  if (v_old ->> 'status') = 'revoked' and (v_new ->> 'status') <> 'revoked' then
    raise exception 'revoked licenses cannot be reactivated' using errcode = 'P0001';
  end if;
  if (v_new ->> 'status') is distinct from (v_old ->> 'status') then
    new := jsonb_populate_record(new, jsonb_build_object('status_changed_at', now()));
  end if;
  return new;
end;
$$;

create or replace function nexus_audit_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------
-- admin_users: server-controlled admin allowlist
-- ---------------------------------------------------------------------
create table if not exists admin_users (
  user_id    uuid primary key references "auth"."users"(id) on delete cascade,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  created_by uuid null
);

-- ---------------------------------------------------------------------
-- client_apps: each website or project using Nexus
-- client_id is PUBLIC. secret_hash is optional.
-- ---------------------------------------------------------------------
create table if not exists client_apps (
  id                    uuid primary key default gen_random_uuid(),
  client_id             text not null unique
                        default ('app_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20))
                        check (client_id ~ '^app_[a-z0-9]{8,40}$'),
  name                  text not null check (char_length(name) between 1 and 80),
  description           text null check (description is null or char_length(description) <= 500),
  status                text not null default 'active' check (status in ('active', 'disabled')),
  default_duration_days integer not null default 30   check (default_duration_days between 1 and 3650),
  default_max_devices   integer not null default 1    check (default_max_devices between 1 and 100),
  max_devices_cap       integer not null default 10   check (max_devices_cap between 1 and 100),
  max_duration_days     integer not null default 3650 check (max_duration_days between 1 and 36500),
  allow_lifetime        boolean not null default false,
  secret_hash           text null check (secret_hash is null or secret_hash ~ '^[0-9a-f]{64}$'),
  secret_rotated_at     timestamptz null,
  metadata              jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint client_apps_defaults_within_caps
    check (default_max_devices <= max_devices_cap and default_duration_days <= max_duration_days)
);

-- ---------------------------------------------------------------------
-- licenses: plaintext keys are NEVER stored, only HMAC-SHA256 hex
-- ---------------------------------------------------------------------
create table if not exists licenses (
  id                uuid primary key default gen_random_uuid(),
  app_id            uuid not null references client_apps(id) on delete restrict,
  key_hash          text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_hint          text not null check (char_length(key_hint) between 1 and 16),
  label             text not null check (char_length(label) between 1 and 120),
  status            text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  status_reason     text null check (status_reason is null or char_length(status_reason) <= 300),
  status_changed_at timestamptz not null default now(),
  max_devices       integer not null default 1 check (max_devices between 1 and 100),
  expires_at        timestamptz null,
  metadata          jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096),
  created_by        uuid null references "auth"."users"(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_activated_at timestamptz null,
  last_verified_at  timestamptz null
);

create index if not exists licenses_app_id_idx     on licenses (app_id);
create index if not exists licenses_status_idx     on licenses (status);
create index if not exists licenses_created_at_idx on licenses (created_at desc);
create index if not exists licenses_expires_at_idx on licenses (expires_at);

-- ---------------------------------------------------------------------
-- devices: server-issued device tokens (hashed)
-- ---------------------------------------------------------------------
create table if not exists devices (
  id               uuid primary key default gen_random_uuid(),
  license_id       uuid not null references licenses(id) on delete cascade,
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  fingerprint_hash text null check (fingerprint_hash is null or fingerprint_hash ~ '^[0-9a-f]{64}$'),
  label            text null check (label is null or char_length(label) <= 80),
  status           text not null default 'active' check (status in ('active', 'removed')),
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  removed_at       timestamptz null,
  removed_reason   text null
                   check (removed_reason is null or removed_reason in ('admin', 'client', 'license_reset'))
);

create index if not exists devices_license_active_idx
  on devices (license_id) where status = 'active';
create unique index if not exists devices_license_fp_active_uidx
  on devices (license_id, fingerprint_hash)
  where status = 'active' and fingerprint_hash is not null;

-- ---------------------------------------------------------------------
-- audit_events: append-only security log
-- ---------------------------------------------------------------------
create table if not exists audit_events (
  id          bigint generated always as identity primary key,
  event_type  text not null check (char_length(event_type) <= 64 and event_type ~ '^[a-z_]+([.][a-z_]+)*$'),
  actor_type  text not null check (actor_type in ('admin', 'client', 'system', 'anonymous')),
  actor_id    uuid null,
  target_type text null check (target_type is null or target_type in ('license', 'device', 'app', 'admin')),
  target_id   uuid null,
  request_id  text null check (request_id is null or char_length(request_id) <= 64),
  ip_hash     text null check (ip_hash is null or ip_hash ~ '^[0-9a-f]{16,64}$'),
  metadata    jsonb not null default '{}'::jsonb
              check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096),
  created_at  timestamptz not null default now()
);

create index if not exists audit_created_at_idx on audit_events (created_at desc);
create index if not exists audit_type_idx       on audit_events (event_type, created_at desc);
create index if not exists audit_target_idx     on audit_events (target_id) where target_id is not null;
create index if not exists audit_actor_idx      on audit_events (actor_id)  where actor_id is not null;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace trigger client_apps_updated_at
  before update on client_apps
  for each row execute function nexus_set_updated_at();

create or replace trigger licenses_guard
  before update on licenses
  for each row execute function nexus_license_guard();

create or replace trigger licenses_updated_at
  before update on licenses
  for each row execute function nexus_set_updated_at();

create or replace trigger audit_events_no_update
  before update on audit_events
  for each row execute function nexus_audit_immutable();

-- ---------------------------------------------------------------------
-- ATOMIC ACTIVATION: FOR UPDATE lock prevents exceeding device limit
-- ---------------------------------------------------------------------
create or replace function nexus_activate_device(
  p_client_id        text,
  p_key_hash         text,
  p_token_hash       text,
  p_fingerprint_hash text default null,
  p_label            text default null
)
returns table (
  r_result       text,
  r_license_id   uuid,
  r_device_id    uuid,
  r_expires_at   timestamptz,
  r_devices_used integer,
  r_max_devices  integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_app_id      uuid;
  v_app_status  text;
  v_lic_id      uuid;
  v_lic_status  text;
  v_lic_expires timestamptz;
  v_lic_max     integer;
  v_dev_id      uuid;
  v_used        integer;
begin
  if coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
     or (p_fingerprint_hash is not null and p_fingerprint_hash !~ '^[0-9a-f]{64}$') then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz, null::integer, null::integer;
    return;
  end if;

  select id, status into v_app_id, v_app_status
    from client_apps
   where client_id = p_client_id;

  if v_app_id is null or v_app_status <> 'active' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz, null::integer, null::integer;
    return;
  end if;

  select id, status, expires_at, max_devices
    into v_lic_id, v_lic_status, v_lic_expires, v_lic_max
    from licenses
   where key_hash = p_key_hash and app_id = v_app_id
   for update;

  if v_lic_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz, null::integer, null::integer;
    return;
  end if;

  if v_lic_status <> 'active' then
    return query select v_lic_status, v_lic_id, null::uuid, v_lic_expires, null::integer, v_lic_max;
    return;
  end if;

  if v_lic_expires is not null and v_lic_expires <= now() then
    return query select 'expired'::text, v_lic_id, null::uuid, v_lic_expires, null::integer, v_lic_max;
    return;
  end if;

  if p_fingerprint_hash is not null then
    update devices
       set token_hash   = p_token_hash,
           last_seen_at = now(),
           label        = coalesce(p_label, label)
     where license_id = v_lic_id
       and fingerprint_hash = p_fingerprint_hash
       and status = 'active'
    returning id into v_dev_id;
  end if;

  if v_dev_id is null then
    select count(*)::integer into v_used
      from devices
     where license_id = v_lic_id and status = 'active';

    if v_used >= v_lic_max then
      return query select 'device_limit'::text, v_lic_id, null::uuid, v_lic_expires, v_used, v_lic_max;
      return;
    end if;

    insert into devices (license_id, token_hash, fingerprint_hash, label)
    values (v_lic_id, p_token_hash, p_fingerprint_hash, p_label)
    returning id into v_dev_id;
  end if;

  update licenses set last_activated_at = now() where id = v_lic_id;

  select count(*)::integer into v_used
    from devices
   where license_id = v_lic_id and status = 'active';

  return query select 'ok'::text, v_lic_id, v_dev_id, v_lic_expires, v_used, v_lic_max;
end;
$$;

-- ---------------------------------------------------------------------
-- VERIFY: device token + license + app checked on every call
-- ---------------------------------------------------------------------
create or replace function nexus_verify_device(
  p_client_id  text,
  p_token_hash text
)
returns table (
  r_result     text,
  r_license_id uuid,
  r_device_id  uuid,
  r_expires_at timestamptz
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_dev_id      uuid;
  v_dev_status  text;
  v_last_seen   timestamptz;
  v_lic_id      uuid;
  v_lic_status  text;
  v_lic_expires timestamptz;
  v_app_id      uuid;
  v_app_status  text;
  v_client_id   text;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  select id, license_id, status, last_seen_at
    into v_dev_id, v_lic_id, v_dev_status, v_last_seen
    from devices
   where token_hash = p_token_hash;

  if v_dev_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  select app_id, status, expires_at
    into v_app_id, v_lic_status, v_lic_expires
    from licenses
   where id = v_lic_id;

  select client_id, status
    into v_client_id, v_app_status
    from client_apps
   where id = v_app_id;

  if v_client_id is distinct from p_client_id or v_app_status <> 'active' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  if v_dev_status <> 'active' then
    return query select 'device_removed'::text, v_lic_id, v_dev_id, v_lic_expires;
    return;
  end if;

  if v_lic_status <> 'active' then
    return query select v_lic_status, v_lic_id, v_dev_id, v_lic_expires;
    return;
  end if;

  if v_lic_expires is not null and v_lic_expires <= now() then
    return query select 'expired'::text, v_lic_id, v_dev_id, v_lic_expires;
    return;
  end if;

  if v_last_seen < now() - interval '5 minutes' then
    update devices  set last_seen_at = now()     where id = v_dev_id;
    update licenses set last_verified_at = now() where id = v_lic_id;
  end if;

  return query select 'ok'::text, v_lic_id, v_dev_id, v_lic_expires;
end;
$$;

-- ---------------------------------------------------------------------
-- DEACTIVATE: client frees its own device slot
-- ---------------------------------------------------------------------
create or replace function nexus_deactivate_device(
  p_client_id  text,
  p_token_hash text
)
returns table (r_result text, r_license_id uuid, r_device_id uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_dev_id uuid;
  v_lic_id uuid;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid, null::uuid;
    return;
  end if;

  update devices
     set status = 'removed', removed_at = now(), removed_reason = 'client'
   where token_hash = p_token_hash
     and status = 'active'
     and license_id in (
       select id from licenses
        where app_id in (select id from client_apps where client_id = p_client_id)
     )
  returning id, license_id into v_dev_id, v_lic_id;

  if v_dev_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid;
    return;
  end if;

  return query select 'ok'::text, v_lic_id, v_dev_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Dashboard stats
-- ---------------------------------------------------------------------
create or replace function nexus_admin_stats()
returns table (
  r_total          bigint,
  r_active         bigint,
  r_suspended      bigint,
  r_revoked        bigint,
  r_expired        bigint,
  r_active_devices bigint,
  r_apps           bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    (select count(*) from licenses),
    (select count(*) from licenses where status = 'active' and (expires_at is null or expires_at > now())),
    (select count(*) from licenses where status = 'suspended'),
    (select count(*) from licenses where status = 'revoked'),
    (select count(*) from licenses where status = 'active' and expires_at <= now()),
    (select count(*) from devices  where status = 'active'),
    (select count(*) from client_apps);
$$;

-- ---------------------------------------------------------------------
-- Retention cleanup (minimum 30 days)
-- ---------------------------------------------------------------------
create or replace function nexus_purge_old_records(
  p_audit_days  integer default 365,
  p_device_days integer default 180
)
returns table (r_audit_deleted bigint, r_devices_deleted bigint)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_a bigint;
  v_d bigint;
begin
  if p_audit_days < 30 or p_device_days < 30 then
    raise exception 'retention must be at least 30 days' using errcode = 'P0001';
  end if;

  delete from audit_events
   where created_at < now() - make_interval(days => p_audit_days);
  get diagnostics v_a = row_count;

  delete from devices
   where status = 'removed'
     and removed_at < now() - make_interval(days => p_device_days);
  get diagnostics v_d = row_count;

  return query select v_a, v_d;
end;
$$;

-- =====================================================================
-- ROW LEVEL SECURITY: deny by default (no policies on purpose)
-- =====================================================================
alter table admin_users  enable row level security;
alter table client_apps  enable row level security;
alter table licenses     enable row level security;
alter table devices      enable row level security;
alter table audit_events enable row level security;

revoke all on table admin_users, client_apps, licenses, devices, audit_events
  from anon, authenticated;

grant select, insert, update, delete on table
  admin_users, client_apps, licenses, devices, audit_events
  to service_role;

grant usage, select on sequence audit_events_id_seq to service_role;

revoke execute on function nexus_activate_device(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function nexus_verify_device(text, text)                     from public, anon, authenticated;
revoke execute on function nexus_deactivate_device(text, text)                 from public, anon, authenticated;
revoke execute on function nexus_admin_stats()                                 from public, anon, authenticated;
revoke execute on function nexus_purge_old_records(integer, integer)           from public, anon, authenticated;
revoke execute on function nexus_set_updated_at()                              from public, anon, authenticated;
revoke execute on function nexus_license_guard()                               from public, anon, authenticated;
revoke execute on function nexus_audit_immutable()                             from public, anon, authenticated;

grant execute on function nexus_activate_device(text, text, text, text, text) to service_role;
grant execute on function nexus_verify_device(text, text)                     to service_role;
grant execute on function nexus_deactivate_device(text, text)                 to service_role;
grant execute on function nexus_admin_stats()                                 to service_role;
grant execute on function nexus_purge_old_records(integer, integer)           to service_role;

-- ---------------------------------------------------------------------
-- Seed: one default app (only if none exist)
-- ---------------------------------------------------------------------
insert into client_apps (name, description)
select 'Default Website', 'Created by migration 001'
where not exists (select 1 from client_apps);

commit;