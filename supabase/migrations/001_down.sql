-- =====================================================================
-- ⚠️ DESTRUCTIVE ROLLBACK — deletes ALL Nexus tables and data.
-- Only run if you intentionally want to undo migration 001.
-- Take a backup first (Dashboard → Database → Backups).
-- =====================================================================
begin;

drop function if exists public.nexus_activate_device(text, text, text, text, text);
drop function if exists public.nexus_verify_device(text, text);
drop function if exists public.nexus_deactivate_device(text, text);
drop function if exists public.nexus_admin_stats();
drop function if exists public.nexus_purge_old_records(integer, integer);

drop table if exists public.audit_events cascade;
drop table if exists public.devices      cascade;
drop table if exists public.licenses     cascade;
drop table if exists public.client_apps  cascade;
drop table if exists public.admin_users  cascade;

drop function if exists public.nexus_license_guard();
drop function if exists public.nexus_audit_immutable();
drop function if exists public.nexus_set_updated_at();

commit;