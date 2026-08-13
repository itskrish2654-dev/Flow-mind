begin;

-- Avoid collision with PostgreSQL's CURRENT_TIME (timetz) built-in.
create or replace function public.consume_security_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.security_rate_limits%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit configuration';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));
  select * into current_row
  from public.security_rate_limits
  where key_hash = p_key_hash
  for update;

  if not found or current_row.window_started_at + make_interval(secs => current_row.window_seconds) <= v_now then
    insert into public.security_rate_limits(key_hash, request_count, window_started_at, window_seconds, updated_at)
    values (p_key_hash, 1, v_now, p_window_seconds, v_now)
    on conflict (key_hash) do update
      set request_count = 1,
          window_started_at = excluded.window_started_at,
          window_seconds = excluded.window_seconds,
          updated_at = excluded.updated_at
    returning * into current_row;
  else
    update public.security_rate_limits
    set request_count = request_count + 1,
        updated_at = v_now
    where key_hash = p_key_hash
    returning * into current_row;
  end if;

  return query select
    current_row.request_count <= p_limit,
    greatest(p_limit - current_row.request_count, 0),
    current_row.window_started_at + make_interval(secs => current_row.window_seconds);
end;
$$;

revoke all on function public.consume_security_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_security_rate_limit(text, integer, integer) to service_role;

commit;
