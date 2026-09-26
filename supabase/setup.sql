-- Paper Trader: accounts and invites.
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- It is safe to run again.

-- Who may use the app. Admins can invite and remove people from inside the app.
create table if not exists public.invites (
  email text primary key check (email = lower(email)),
  is_admin boolean not null default false,
  invited_at timestamptz not null default now()
);

-- Each user's portfolio, rules and trade history (the same JSON the app exports).
create table if not exists public.portfolios (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.invites enable row level security;
alter table public.portfolios enable row level security;

create or replace function public.is_invited() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites where email = lower(auth.jwt() ->> 'email'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites where email = lower(auth.jwt() ->> 'email') and is_admin);
$$;

drop policy if exists "see own invite; admins see all" on public.invites;
create policy "see own invite; admins see all" on public.invites for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists "admins invite" on public.invites;
create policy "admins invite" on public.invites for insert to authenticated
  with check (public.is_admin());

drop policy if exists "admins remove others" on public.invites;
create policy "admins remove others" on public.invites for delete to authenticated
  using (public.is_admin() and email <> lower(auth.jwt() ->> 'email'));

-- Only invited users can read or write their own portfolio; nobody can see anyone else's.
drop policy if exists "own portfolio, invited only" on public.portfolios;
create policy "own portfolio, invited only" on public.portfolios for all to authenticated
  using (user_id = auth.uid() and public.is_invited())
  with check (user_id = auth.uid() and public.is_invited());

-- Stops uninvited emails from creating an account at all (email and Google sign-ups alike).
-- Turn it on in Authentication → Hooks → "Before User Created" → Postgres → public.hook_before_user_created.
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.invites where email = lower(event -> 'user' ->> 'email')) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email has not been invited to Paper Trader. Ask the owner for an invite.'));
end;
$$;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;

-- Make yourself the first admin: replace the address with the one you'll sign in with, then run.
insert into public.invites (email, is_admin) values (lower('you@example.com'), true)
  on conflict (email) do update set is_admin = true;
