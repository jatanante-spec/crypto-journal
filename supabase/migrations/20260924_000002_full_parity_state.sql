-- Crypto Journal · preserve current cloud-state parity during development
-- This adds a per-user container for non-trade state that the current Apps
-- Script app synchronises today: sizer, market snapshot, closes, hourly
-- evidence, per-coin books and deleted markers.
-- Journal trades and Saved Plans remain in their dedicated tables.
-- No production data is imported or changed by this migration.

begin;

alter table public.user_settings
  add column if not exists legacy_state jsonb not null default '{}'::jsonb,
  add column if not exists state_version integer not null default 1,
  add column if not exists app_state_updated_at timestamptz;

comment on column public.user_settings.legacy_state is
  'Development parity container for non-trade app state. Do not treat market snapshots as current without checking their timestamps.';

comment on column public.user_settings.state_version is
  'Version of the application state envelope stored in legacy_state.';

comment on column public.user_settings.app_state_updated_at is
  'Application state timestamp used for conflict handling; distinct from the database row updated_at timestamp.';

commit;
