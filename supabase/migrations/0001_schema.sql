-- Creator Affiliate Desk schema. Isolated tables in public (prefix outreach_), RLS locked to owner.
-- Touches no existing Compliyo tables. Applied to project aiyfpbyrvpgtuuenrfph.
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.outreach_is_owner() returns boolean
  language sql stable as $$
  select coalesce((auth.jwt() ->> 'email') = 'jallohosmanamadu311@gmail.com', false)
$$;

create or replace function public.outreach_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create table if not exists public.outreach_settings(
  id smallint primary key default 1 check (id = 1),
  from_name text not null default 'Osman',
  from_email text not null default 'jallohosmanamadu311@gmail.com',
  product text not null default 'Money Reset',
  address text not null default '[Add your mailing address — required for cold email]',
  footer text not null default 'You are getting this note because of your work in personal finance. If you would prefer I not reach out again, just reply and I will remove you.',
  subject_named text not null default 'quick idea for you, {name}',
  subject_generic text not null default 'a quick partnership idea',
  body_template text not null,
  followup_max int not null default 5,
  followup_window_days int not null default 14,
  daily_send_cap int not null default 25,
  updated_at timestamptz not null default now()
);

create table if not exists public.outreach_followup_templates(
  step int primary key, delay_days int not null, subject text not null, body text not null, active boolean not null default true
);

create table if not exists public.outreach_creators(
  id uuid primary key default gen_random_uuid(),
  handle text unique not null, url text, name text, followers_num int, niche text,
  content_style text, link text, email text, ig_dm_sent boolean default false,
  audience_problem text, evidence text, fit int, compliment text, problem text,
  status text not null default 'New' check (status in ('New','Approved','Queued','Sent','Replied','Won','Lost','Declined')),
  subject_override text default '', email_override text default '',
  first_email_approved boolean not null default false,
  first_sent_at timestamptz, next_followup_at timestamptz, followups_sent int not null default 0,
  last_touch_at timestamptz, reply_text text default '', reply_at timestamptz,
  reply_draft text default '', reply_status text default '', gmail_thread_id text,
  archived boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists ix_outreach_creators_status on public.outreach_creators(status) where archived = false;
create index if not exists ix_outreach_creators_due on public.outreach_creators(next_followup_at) where archived = false;
create trigger trg_outreach_creators_touch before update on public.outreach_creators
  for each row execute function public.outreach_touch();

create table if not exists public.outreach_accepted(
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references public.outreach_creators(id) on delete set null,
  handle text, name text, email text, accepted_at timestamptz not null default now(),
  deal_terms text default '50% affiliate revenue share', affiliate_link text, notes text, status text not null default 'Active'
);

create table if not exists public.outreach_suppression(
  email text primary key, handle text, reason text not null, created_at timestamptz not null default now()
);

create table if not exists public.outreach_messages(
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references public.outreach_creators(id) on delete cascade,
  handle text, direction text not null check (direction in ('out','in')), kind text not null,
  subject text, body text, gmail_message_id text, created_at timestamptz not null default now()
);
create index if not exists ix_outreach_messages_creator on public.outreach_messages(creator_id);

create table if not exists public.outreach_archive(
  id uuid primary key, handle text, data jsonb not null, reason text not null, archived_at timestamptz not null default now()
);

-- RLS: owner-only (edge functions use the service role and bypass RLS)
do $$
declare t text;
begin
  foreach t in array array['outreach_settings','outreach_followup_templates','outreach_creators','outreach_accepted','outreach_suppression','outreach_messages','outreach_archive']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_owner on public.%I', t);
    execute format('create policy p_owner on public.%I for all to authenticated using (public.outreach_is_owner()) with check (public.outreach_is_owner())', t);
  end loop;
end $$;
