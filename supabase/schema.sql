-- Creator Tracker database layout (REFERENCE ONLY).
-- This mirrors what is live in the Supabase project. Running this file does nothing to the live database,
-- and it must never be run against it. Changes go through Supabase: Dashboard -> SQL editor, reviewed by the owner.
-- Snapshot taken 2026-10-24.

-- ============ Access control ============

-- The one login allowed to use the app, by Supabase auth user id. Not readable from the app.
create table public.app_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- Legacy allow-list by email. No longer used by is_owner(); kept only for history.
create table public.app_users (email text primary key);

-- Server-only values (holds the daily cron job's token). Not readable from the app.
create table public.app_secrets (name text primary key, value text not null);

-- True only for the owner's login. Every table policy calls this.
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_owners where user_id = (select auth.uid()))
$$;

-- ============ Data ============

-- Single row (id = 1): default pay rules and the campaign new links go into.
create table public.settings (
  id int primary key default 1 check (id = 1),
  default_rate numeric not null default 0,          -- flat $ per video
  default_cpm numeric not null default 0,           -- $ per 1,000 views
  default_bonus_tiers text not null default '',     -- e.g. '100k=25, 1m=150' (highest tier reached, not cumulative)
  default_max numeric not null default 0,           -- cap per video, 0 = no cap
  track_stats_days int not null default 30,         -- refresh stats for videos posted within this many days
  current_campaign_id uuid references public.campaigns(id) on delete set null,
  last_stats_run timestamptz
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default 'blue',               -- blue, red, green, orange, purple, pink, teal, black
  started_at timestamptz not null default now(),
  archived boolean not null default false,          -- hidden from the switcher
  notes text not null default ''
);

create table public.creators (
  handle text primary key check (handle = lower(handle)),   -- TikTok handle without @
  name text not null default '',
  contact text not null default '',
  payout_method text not null default '',
  payout_details text not null default '',
  rate_per_video numeric,            -- null = use settings default
  cpm numeric,                       -- null = use settings default
  bonus_tiers text,                  -- null/blank = use settings default
  max_per_video numeric,             -- null = use settings default
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table public.videos (
  id text primary key,               -- TikTok video id; its top 32 bits are the post time
  creator text not null references public.creators(handle) on update cascade,
  campaign_id uuid not null references public.campaigns(id),
  url text not null,                 -- canonical https://www.tiktok.com/@handle/video/<id>
  posted_at timestamptz,
  status text not null default 'Submitted' check (status in ('Submitted', 'Approved', 'Rejected', 'Paid')),
  views bigint, likes bigint, comments bigint, shares bigint,
  stats_updated_at timestamptz,
  amount_override numeric,           -- fixed $ for this video, replaces the formula
  notes text not null default '',
  created_at timestamptz not null default now()
);

create sequence public.payout_seq;
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('P-' || lpad(nextval('public.payout_seq')::text, 4, '0')),
  creator text not null references public.creators(handle) on update cascade,
  amount numeric not null,
  method text not null default '',
  reference text not null default '',
  notes text not null default '',
  paid_at timestamptz not null default now()
);

-- One row per video per payout. A deliberate second payment is just another row.
create table public.payout_items (
  payout_id uuid not null references public.payouts(id) on delete cascade,
  video_id text not null references public.videos(id),
  amount numeric not null,
  primary key (payout_id, video_id)
);

-- Daily stats snapshots written by the refresh-stats function.
create table public.video_stats (
  id bigint generated always as identity primary key,
  video_id text not null references public.videos(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint, likes bigint, comments bigint, shares bigint
);

-- Row level security is ON for every table. Each data table has one policy:
--   create policy owner_all on <table> for all to authenticated
--     using ((select public.is_owner())) with check ((select public.is_owner()));
-- app_owners, app_users and app_secrets have no policies, so the app can't read them at all.

-- ============ Pay math ============

create or replace function public.tier_bonus(p_views bigint, p_tiers text) returns numeric
language plpgsql immutable set search_path = public as $$
declare part text; m text[]; best numeric := 0; threshold numeric;
begin
  if p_tiers is null or btrim(p_tiers) = '' then return 0; end if;
  foreach part in array regexp_split_to_array(p_tiers, '[,;\n]+') loop
    m := regexp_match(btrim(part), '^([0-9.]+)\s*([kKmM]?)\s*[=:]\s*\$?([0-9.]+)$');
    continue when m is null;
    threshold := m[1]::numeric * case lower(m[2]) when 'k' then 1000 when 'm' then 1000000 else 1 end;
    if coalesce(p_views, 0) >= threshold and m[3]::numeric > best then best := m[3]::numeric; end if;
  end loop;
  return best;
end $$;

-- What a video earns: flat + views/1000 * CPM + tier bonus, capped. Creator values override defaults.
create or replace function public.video_owed(v public.videos) returns numeric
language sql stable set search_path = public as $$
  select case
    when v.status = 'Rejected' then 0
    when v.amount_override is not null then v.amount_override
    else round(least(
      coalesce(c.rate_per_video, s.default_rate)
        + coalesce(v.views, 0) / 1000.0 * coalesce(c.cpm, s.default_cpm)
        + public.tier_bonus(v.views, coalesce(nullif(btrim(c.bonus_tiers), ''), s.default_bonus_tiers)),
      case when coalesce(c.max_per_video, s.default_max) > 0
           then coalesce(c.max_per_video, s.default_max) else 'infinity'::numeric end
    ), 2)
  end
  from public.settings s
  left join public.creators c on c.handle = v.creator
  where s.id = 1
$$;

-- ============ Views the app reads ============

create view public.videos_v with (security_invoker = true) as
select v.*,
  public.video_owed(v) as owed,
  coalesce((select sum(pi.amount) from public.payout_items pi where pi.video_id = v.id), 0) as paid_total,
  (select string_agg(p.code, ', ' order by p.paid_at)
     from public.payout_items pi join public.payouts p on p.id = pi.payout_id
    where pi.video_id = v.id) as payout_codes
from public.videos v;

create view public.campaign_totals with (security_invoker = true) as
select c.*,
  (select count(*) from public.videos v where v.campaign_id = c.id) as videos_count,
  (select coalesce(sum(pi.amount), 0) from public.payout_items pi
     join public.videos v on v.id = pi.video_id where v.campaign_id = c.id) as total_spent,
  (select coalesce(sum(public.video_owed(v)), 0) from public.videos v
    where v.campaign_id = c.id and v.status = 'Approved') as still_owed
from public.campaigns c;

-- ============ Recording a payment ============

-- Called by the app as rpc('create_payout', {...}). Refuses already-paid videos with 'ALREADY_PAID:<ids>'
-- unless p_pay_again is true. Spreads the amount across videos by what each earns, marks them Paid.
create or replace function public.create_payout(
  p_creator text, p_video_ids text[], p_amount numeric default null,
  p_method text default '', p_reference text default '', p_notes text default '',
  p_pay_again boolean default false
) returns public.payouts
language plpgsql security invoker set search_path = public as $$
declare
  vids public.videos[]; v public.videos; already text[] := '{}';
  weights numeric := 0; amt numeric; n int; w numeric; p public.payouts;
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  if coalesce(array_length(p_video_ids, 1), 0) = 0 then raise exception 'Pick at least one video.'; end if;

  select array_agg(x order by x.posted_at) into vids from public.videos x where x.id = any(p_video_ids);
  if coalesce(array_length(vids, 1), 0) <> (select count(distinct u) from unnest(p_video_ids) u) then
    raise exception 'Some selected videos were not found. Refresh and try again.';
  end if;

  foreach v in array vids loop
    if v.creator <> lower(p_creator) then raise exception 'Video % belongs to @%', v.id, v.creator; end if;
    if v.status = 'Rejected' then raise exception 'Video % is rejected', v.id; end if;
    if v.status = 'Paid' then already := already || v.id; end if;
    weights := weights + public.video_owed(v);
  end loop;

  if array_length(already, 1) > 0 and not coalesce(p_pay_again, false) then
    raise exception 'ALREADY_PAID:%', array_to_string(already, ',');
  end if;

  amt := round(coalesce(p_amount, weights), 2);
  if amt < 0 then raise exception 'Invalid amount'; end if;

  insert into public.payouts (creator, amount, method, reference, notes)
  values (lower(p_creator), amt, coalesce(p_method, ''), coalesce(p_reference, ''), coalesce(p_notes, ''))
  returning * into p;

  n := array_length(vids, 1);
  foreach v in array vids loop
    w := public.video_owed(v);
    insert into public.payout_items (payout_id, video_id, amount)
    values (p.id, v.id, case when weights > 0 then round(amt * w / weights, 2) else round(amt / n, 2) end);
    update public.videos set status = 'Paid' where id = v.id;
  end loop;
  return p;
end $$;

-- ============ Daily job ============
-- pg_cron job 'daily-refresh-stats' runs at 14:00 UTC (7am Pacific) and POSTs to the refresh-stats
-- edge function with an x-cron-token header read from app_secrets.
