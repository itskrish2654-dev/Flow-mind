begin;

-- RLS limits which turn rows an employee may see, while these literal column
-- grants limit what a browser role may read from an owned row. Keeping the
-- allowlist explicit also prevents future lifecycle columns from becoming
-- browser-readable automatically.
revoke select on table public.ask_turns from public, anon, authenticated;

grant select (
  workspace_id,
  user_id,
  request_id,
  thread_id,
  state,
  failure_category
) on table public.ask_turns to authenticated;

commit;
