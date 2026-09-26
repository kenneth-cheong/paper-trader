-- Paper Trader: start and stop the AI fund (and refresh AI picks) from the app.
-- Run once in Supabase → SQL Editor, after setup.sql. Safe to run again.
--
-- How it works: an admin presses a button in the app, which adds a row to fund_commands. A trigger
-- then asks GitHub to run the "Update prices, AI picks and AI fund" workflow with the matching inputs,
-- using a GitHub token kept encrypted in Supabase Vault. Only admins can add or see commands.
--
-- One more step after running this file: store your GitHub token in Vault (see the end of this file).

create extension if not exists pg_net with schema extensions;

create table if not exists public.fund_commands (
  id bigint generated always as identity primary key,
  action text not null,
  amount numeric check (amount is null or amount > 0),
  currency text check (currency is null or currency in ('USD', 'SGD')),
  decisions_per_day int check (decisions_per_day is null or decisions_per_day in (1, 2, 4)),
  requested_by text not null default lower(auth.jwt() ->> 'email'),
  created_at timestamptz not null default now(),
  request_id bigint,
  check (action <> 'start' or (amount is not null and currency is not null and decisions_per_day is not null))
);
alter table public.fund_commands enable row level security;

-- Commands added later (Tiger trading): approvals, pausing and settings carry a JSON payload.
alter table public.fund_commands add column if not exists payload jsonb;
alter table public.fund_commands drop constraint if exists fund_commands_action_check;
alter table public.fund_commands add constraint fund_commands_action_check
  check (action in ('start', 'stop', 'refresh_picks', 'approve', 'reject', 'pause', 'resume', 'settings'));

drop policy if exists "admins see commands" on public.fund_commands;
create policy "admins see commands" on public.fund_commands for select to authenticated using (public.is_admin());
drop policy if exists "admins send commands" on public.fund_commands;
create policy "admins send commands" on public.fund_commands for insert to authenticated with check (public.is_admin());

-- Sends each new command to GitHub as a workflow run.
create or replace function public.dispatch_fund_command() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  token text;
  inputs jsonb;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_actions_token';
  if token is null then
    raise exception 'Fund control is not set up yet: the GitHub token is missing from Supabase Vault (see supabase/fund-control.sql).';
  end if;
  inputs := case new.action
    when 'start' then jsonb_build_object(
      'fund_start_amount', new.amount::text, 'fund_currency', new.currency, 'fund_decisions_per_day', new.decisions_per_day::text,
      'fund_command', coalesce(new.payload, '{}'::jsonb)::text)
    when 'stop' then jsonb_build_object('fund_stop', 'true')
    when 'refresh_picks' then jsonb_build_object('refresh_picks', 'true')
    when 'approve' then jsonb_build_object('fund_command', jsonb_build_object('approve', coalesce(new.payload -> 'ids', '[]'::jsonb))::text)
    when 'reject' then jsonb_build_object('fund_command', jsonb_build_object('reject', coalesce(new.payload -> 'ids', '[]'::jsonb))::text)
    when 'pause' then jsonb_build_object('fund_command', '{"pause":true}')
    when 'resume' then jsonb_build_object('fund_command', '{"resume":true}')
    else jsonb_build_object('fund_command', jsonb_build_object('settings', coalesce(new.payload, '{}'::jsonb))::text)
  end;
  new.request_id := net.http_post(
    url := 'https://api.github.com/repos/kenneth-cheong/paper-trader/actions/workflows/prices.yml/dispatches',
    body := jsonb_build_object('ref', 'main', 'inputs', inputs),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      'User-Agent', 'paper-trader'),
    timeout_milliseconds := 10000
  );
  return new;
end;
$$;

drop trigger if exists fund_command_dispatch on public.fund_commands;
create trigger fund_command_dispatch before insert on public.fund_commands
  for each row execute function public.dispatch_fund_command();

-- Whether GitHub accepted a command: 'pending', 'accepted' (HTTP 204) or 'failed' with the reason.
create or replace function public.fund_command_status(command_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
begin
  if not public.is_admin() then
    raise exception 'Only admins can check fund commands.';
  end if;
  select resp.status_code, resp.content, resp.error_msg, resp.timed_out into r
    from public.fund_commands c join net._http_response resp on resp.id = c.request_id
    where c.id = command_id;
  if not found then
    return jsonb_build_object('state', 'pending');
  end if;
  return jsonb_build_object(
    'state', case when r.status_code = 204 then 'accepted' else 'failed' end,
    'status', r.status_code,
    'detail', coalesce(r.error_msg, case when r.timed_out then 'timed out' end, left(r.content, 300)));
end;
$$;
revoke execute on function public.fund_command_status(bigint) from anon, public;
grant execute on function public.fund_command_status(bigint) to authenticated;

-- LAST STEP: store the GitHub token. Create it at github.com → Settings → Developer settings →
-- Fine-grained tokens → Generate new token: "Only select repositories" → paper-trader, and under
-- Repository permissions set "Actions" to "Read and write". Then run this line with your token:
--
--   select vault.create_secret('github_pat_PASTE_YOUR_TOKEN_HERE', 'github_actions_token');
--
-- To replace it later (for example when it expires):
--
--   select vault.update_secret((select id from vault.secrets where name = 'github_actions_token'), 'github_pat_NEW_TOKEN');
