begin;
create or replace function public.run_connector_maintenance()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_oauth_states integer := 0; v_receipts integer := 0; v_expired_subscriptions integer := 0; v_expired_connections integer := 0;
begin
  delete from public.connector_oauth_states where expires_at < clock_timestamp() - interval '1 day'; get diagnostics v_oauth_states = row_count;
  delete from public.connector_event_receipts where expires_at < clock_timestamp(); get diagnostics v_receipts = row_count;
  update public.connector_subscriptions set status = 'expired', updated_at = clock_timestamp() where status = 'active' and expires_at is not null and expires_at < clock_timestamp(); get diagnostics v_expired_subscriptions = row_count;
  update public.connector_connections set status = 'expired', updated_at = clock_timestamp() where status = 'connected' and token_expires_at is not null and token_expires_at < clock_timestamp() - interval '5 minutes'; get diagnostics v_expired_connections = row_count;
  return jsonb_build_object('expiredOauthStates', v_oauth_states, 'expiredEventReceipts', v_receipts, 'expiredSubscriptions', v_expired_subscriptions, 'expiredConnections', v_expired_connections);
end;
$$;
revoke all on function public.run_connector_maintenance() from public, anon, authenticated;
grant execute on function public.run_connector_maintenance() to service_role;
commit;
