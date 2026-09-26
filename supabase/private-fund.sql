-- Paper Trader: keep the AI fund private. Run once in Supabase → SQL Editor, after setup.sql.
-- Safe to run again.
--
-- The AI fund's state (its trades, positions and your Tiger account's holdings) is then stored here,
-- where only admins can read it, instead of on the public website and the public ai-state branch.
-- The scheduled GitHub job reads and writes it with a random token kept in Supabase Vault; the last
-- query below shows that token so you can add it to GitHub as the FUND_STATE_TOKEN secret.

create table if not exists public.fund_state (
  id int primary key default 1 check (id = 1), -- one fund
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.fund_state enable row level security;

drop policy if exists "admins read the fund" on public.fund_state;
create policy "admins read the fund" on public.fund_state for select to authenticated using (public.is_admin());

-- The job's token check. Constant work either way; the token is 64 random hex characters.
create or replace function public.fund_token_ok(token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'fund_state_token' and decrypted_secret = token);
$$;
revoke execute on function public.fund_token_ok(text) from anon, authenticated, public;

create or replace function public.load_fund_state(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.fund_token_ok(token) then
    raise exception 'Wrong fund state token.';
  end if;
  return (select data from public.fund_state where id = 1);
end;
$$;

create or replace function public.save_fund_state(token text, data jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  saved timestamptz := now();
begin
  if not public.fund_token_ok(token) then
    raise exception 'Wrong fund state token.';
  end if;
  insert into public.fund_state (id, data, updated_at) values (1, data, saved)
    on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at;
  return saved;
end;
$$;
revoke execute on function public.load_fund_state(text) from public;
revoke execute on function public.save_fund_state(text, jsonb) from public;
grant execute on function public.load_fund_state(text) to anon;
grant execute on function public.save_fund_state(text, jsonb) to anon;

-- Make the token once (running this file again keeps it).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'fund_state_token') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'fund_state_token');
  end if;
end;
$$;

-- LAST STEP: copy the value this shows into a GitHub repository secret named FUND_STATE_TOKEN
-- (repo → Settings → Secrets and variables → Actions → New repository secret).
select decrypted_secret as "Copy this into the FUND_STATE_TOKEN GitHub secret"
  from vault.decrypted_secrets where name = 'fund_state_token';
