-- Sales ledger tables for durable duplicate-check + rollback
-- Run this once in Supabase SQL Editor.

create table if not exists public.sales_batches (
  batch_id text primary key,
  owner_member_id bigint not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz null
);

create index if not exists sales_batches_owner_created_idx
  on public.sales_batches (owner_member_id, created_at desc);

create unique index if not exists sales_batches_owner_fingerprint_active_uidx
  on public.sales_batches (owner_member_id, fingerprint)
  where rolled_back_at is null;

create table if not exists public.sales_batch_entries (
  batch_id text not null references public.sales_batches(batch_id) on delete cascade,
  member_id bigint not null,
  pv integer not null,
  created_at timestamptz not null default now()
);

create index if not exists sales_batch_entries_batch_idx
  on public.sales_batch_entries (batch_id);

create table if not exists public.sales_batch_snapshots (
  batch_id text not null references public.sales_batches(batch_id) on delete cascade,
  member_id bigint not null,
  cumulative_pv integer not null default 0,
  left_line_pv integer not null default 0,
  right_line_pv integer not null default 0,
  tier_grade integer null,
  tier_points integer null,
  tier_title text null,
  created_at timestamptz not null default now(),
  primary key (batch_id, member_id)
);

create index if not exists sales_batch_snapshots_batch_idx
  on public.sales_batch_snapshots (batch_id);

