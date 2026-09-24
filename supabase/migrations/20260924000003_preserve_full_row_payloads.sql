-- Crypto Journal · preserve complete application row payloads
-- The current Apps Script Journal and Saved Plan objects contain fields that
-- are not all useful as relational columns (for example volume evidence,
-- decision evidence and future advisory fields). Keep the complete object in
-- raw_data while retaining stable columns for querying and indexing.
-- This is additive and does not import, delete or rewrite any production data.

begin;

alter table public.journal_trades
  add column if not exists raw_data jsonb not null default '{}'::jsonb;

alter table public.saved_plans
  add column if not exists raw_data jsonb not null default '{}'::jsonb;

alter table public.coin_library
  add column if not exists raw_data jsonb not null default '{}'::jsonb;

comment on column public.journal_trades.raw_data is
  'Complete client Journal object for lossless staged migration; normalized columns remain available for queries.';

comment on column public.saved_plans.raw_data is
  'Complete client Saved Plan object for lossless staged migration; normalized columns remain available for queries.';

comment on column public.coin_library.raw_data is
  'Complete client coin-library object for lossless staged migration.';

commit;
