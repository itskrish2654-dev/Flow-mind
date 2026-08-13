begin;

-- Internal product maintenance, not a user-facing scheduling capability.
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname in ('flowmind-operational-maintenance', 'flowmind-cron-log-retention');

  perform cron.schedule(
    'flowmind-operational-maintenance',
    '*/10 * * * *',
    $command$
      select public.run_operational_maintenance(
        clock_timestamp() - interval '15 minutes',
        clock_timestamp() - interval '24 hours',
        clock_timestamp() - interval '15 minutes'
      );
    $command$
  );

  -- pg_cron does not prune its own run history. These rows are operational
  -- scheduler diagnostics, not customer workflow or execution history.
  perform cron.schedule(
    'flowmind-cron-log-retention',
    '17 2 * * *',
    $command$
      delete from cron.job_run_details
      where end_time < clock_timestamp() - interval '14 days';
    $command$
  );
end;
$$;

commit;
