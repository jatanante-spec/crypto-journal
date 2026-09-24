-- Crypto Journal · stable source-id upserts for the staged application adapter
-- The current client preserves its own string ids (for example t-123...).
-- Explicit unique constraints let the Supabase REST API upsert those rows
-- without replacing the complete raw_data payload.
-- This is additive and affects only the development schema.

begin;

alter table public.journal_trades
  add constraint journal_trades_user_source_id_key
  unique (user_id, source_id);

alter table public.saved_plans
  add constraint saved_plans_user_source_id_key
  unique (user_id, source_id);

commit;
