-- Crypto Journal · first Supabase migration
-- Scope: account ownership and safe storage boundaries only.
-- This migration does not import, delete or rewrite any Google Apps Script data.
-- Apply first to the separate development project.

begin;

create extension if not exists pgcrypto;

-- One profile per authenticated Supabase user.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Flexible settings container for the current app. The application can migrate
-- individual settings gradually without losing unknown/legacy fields.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Executed Journal rows. source_id preserves the current app's existing local id
-- such as t-123..., while the database uses its own UUID primary key.
create table if not exists public.journal_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text,
  trade_date date not null default current_date,
  opened_at timestamptz,
  coin text not null,
  side text not null default 'Buy',
  entry numeric,
  stop numeric,
  target numeric,
  size_gbp numeric,
  units numeric,
  exit_price numeric,
  fee_kind text,
  followed_stop text,
  notes text,
  setup text,
  limit_kind text,
  stage text,
  gate_stamp jsonb,
  decision1 jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint journal_trades_user_id_id_key unique (user_id, id)
);

create unique index if not exists journal_trades_user_source_id_idx
  on public.journal_trades (user_id, source_id)
  where source_id is not null;

-- Saved Plans remain separate from Journal trades. A plan only becomes a
-- Journal row through an explicit application action later.
create table if not exists public.saved_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text,
  coin text not null,
  coin_id text,
  vs_currency text not null default 'gbp',
  setup text,
  status text not null default 'WATCHING',
  entry numeric,
  stop numeric,
  target numeric,
  risk_gbp numeric,
  reward_risk numeric,
  position_gbp numeric,
  note text,
  snapshot jsonb,
  linked_trade_id uuid references public.journal_trades(id) on delete set null,
  converted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists saved_plans_user_source_id_idx
  on public.saved_plans (user_id, source_id)
  where source_id is not null;

create index if not exists saved_plans_user_updated_idx
  on public.saved_plans (user_id, updated_at desc);

-- Per-user saved/custom coin records. Shared market data is not stored here;
-- this table is only the user's library/watchlist metadata.
create table if not exists public.coin_library (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  coin_id text,
  vs_currency text not null default 'gbp',
  name text,
  sample_price numeric,
  is_favourite boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, ticker)
);

create index if not exists coin_library_user_updated_idx
  on public.coin_library (user_id, updated_at desc);

-- Shared timestamp trigger for application-owned tables.
create or replace function public.set_crypto_journal_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_crypto_journal_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_crypto_journal_updated_at();

drop trigger if exists journal_trades_set_updated_at on public.journal_trades;
create trigger journal_trades_set_updated_at
before update on public.journal_trades
for each row execute function public.set_crypto_journal_updated_at();

drop trigger if exists saved_plans_set_updated_at on public.saved_plans;
create trigger saved_plans_set_updated_at
before update on public.saved_plans
for each row execute function public.set_crypto_journal_updated_at();

drop trigger if exists coin_library_set_updated_at on public.coin_library;
create trigger coin_library_set_updated_at
before update on public.coin_library
for each row execute function public.set_crypto_journal_updated_at();

-- Create the profile and an empty settings document whenever a new Auth user
-- signs up. Existing users are backfilled without overwriting anything.
create or replace function public.handle_new_crypto_journal_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_crypto_journal on auth.users;
create trigger on_auth_user_created_crypto_journal
after insert on auth.users
for each row execute function public.handle_new_crypto_journal_user();

insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
from auth.users as u
on conflict (id) do nothing;

insert into public.user_settings (user_id)
select u.id
from auth.users as u
on conflict (user_id) do nothing;

-- Row Level Security: every private record belongs to exactly one Auth user.
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.journal_trades enable row level security;
alter table public.saved_plans enable row level security;
alter table public.coin_library enable row level security;

-- Profiles
 drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles for select
using (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles for insert
with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- Settings
 drop policy if exists user_settings_select_own on public.user_settings;
create policy user_settings_select_own
on public.user_settings for select
using (auth.uid() = user_id);

drop policy if exists user_settings_insert_own on public.user_settings;
create policy user_settings_insert_own
on public.user_settings for insert
with check (auth.uid() = user_id);

drop policy if exists user_settings_update_own on public.user_settings;
create policy user_settings_update_own
on public.user_settings for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists user_settings_delete_own on public.user_settings;
create policy user_settings_delete_own
on public.user_settings for delete
using (auth.uid() = user_id);

-- Journal trades
 drop policy if exists journal_trades_select_own on public.journal_trades;
create policy journal_trades_select_own
on public.journal_trades for select
using (auth.uid() = user_id);

drop policy if exists journal_trades_insert_own on public.journal_trades;
create policy journal_trades_insert_own
on public.journal_trades for insert
with check (auth.uid() = user_id);

drop policy if exists journal_trades_update_own on public.journal_trades;
create policy journal_trades_update_own
on public.journal_trades for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists journal_trades_delete_own on public.journal_trades;
create policy journal_trades_delete_own
on public.journal_trades for delete
using (auth.uid() = user_id);

-- Saved Plans
 drop policy if exists saved_plans_select_own on public.saved_plans;
create policy saved_plans_select_own
on public.saved_plans for select
using (auth.uid() = user_id);

drop policy if exists saved_plans_insert_own on public.saved_plans;
create policy saved_plans_insert_own
on public.saved_plans for insert
with check (auth.uid() = user_id);

drop policy if exists saved_plans_update_own on public.saved_plans;
create policy saved_plans_update_own
on public.saved_plans for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists saved_plans_delete_own on public.saved_plans;
create policy saved_plans_delete_own
on public.saved_plans for delete
using (auth.uid() = user_id);

-- Coin library
 drop policy if exists coin_library_select_own on public.coin_library;
create policy coin_library_select_own
on public.coin_library for select
using (auth.uid() = user_id);

drop policy if exists coin_library_insert_own on public.coin_library;
create policy coin_library_insert_own
on public.coin_library for insert
with check (auth.uid() = user_id);

drop policy if exists coin_library_update_own on public.coin_library;
create policy coin_library_update_own
on public.coin_library for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists coin_library_delete_own on public.coin_library;
create policy coin_library_delete_own
on public.coin_library for delete
using (auth.uid() = user_id);

commit;
