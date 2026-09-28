-- Paper Trader: a dependable timer for the scheduled job.
-- Run once in Supabase → SQL Editor, after fund-control.sql (it uses the GitHub token stored there). Safe to run again.
--
-- Why: GitHub starts scheduled workflows late, and at busy times skips them altogether. This asks
-- GitHub to run the Update prices, AI picks and AI fund workflow on the same timetable as its own
-- schedule in .github/workflows/prices.yml (times in UTC): every 15 minutes on weekdays while SGX
-- (01:00-09:00) or US markets (13:30-21:00) trade, plus once after the US close. When both timers fire,
-- GitHub runs the job once and drops the spare (the workflow keeps at most one run waiting).
-- A run started this way behaves exactly like a scheduled one: it carries no command.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_scheduled_run() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_actions_token';
  if token is null then
    raise exception 'The GitHub token is missing from Supabase Vault (see supabase/fund-control.sql).';
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/kenneth-cheong/paper-trader/actions/workflows/prices.yml/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      'User-Agent', 'paper-trader'),
    timeout_milliseconds := 10000
  );
end;
$$;

-- Only the timer may call it (not signed-in users, who could otherwise start runs at will).
revoke all on function public.dispatch_scheduled_run() from public, anon, authenticated;

-- Scheduling a job under an existing name replaces it, so running this file again doesn't add copies.
select cron.schedule('paper-trader-market-hours', '*/15 1-9,13-21 * * 1-5', 'select public.dispatch_scheduled_run()');
select cron.schedule('paper-trader-after-us-close', '30 22 * * 1-5', 'select public.dispatch_scheduled_run()');

-- To check it's working: the timer's recent runs (status 'succeeded' means GitHub was asked)...
--   select jobname, status, start_time from cron.job_run_details join cron.job using (jobid) order by start_time desc limit 10;
-- ...and GitHub's answers (201 or 204 means a run was started; 401/403 means the token needs the Actions permission).
--   select status_code, created from net._http_response order by created desc limit 10;
-- To turn it off:
--   select cron.unschedule('paper-trader-market-hours'); select cron.unschedule('paper-trader-after-us-close');
