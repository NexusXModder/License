begin;

-- ---------------------------------------------------------------------
-- Global license API maintenance mode
-- ---------------------------------------------------------------------
create table if not exists system_settings (
  id integer primary key check (id = 1),
  maintenance_mode boolean not null default false,
  maintenance_message text not null default 'System is under maintenance. Please try again later.',
  updated_at timestamptz not null default now(),
  constraint system_settings_message_len check (char_length(maintenance_message) between 1 and 500)
);

insert into system_settings (id)
values (1)
on conflict (id) do nothing;

alter table system_settings enable row level security;
revoke all on table system_settings from anon, authenticated;
grant select, insert, update, delete on table system_settings to service_role;

commit;
