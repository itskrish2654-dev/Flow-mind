begin;

-- Provider webhooks resolve an installation by its exact external workspace ID,
-- then bind only owner-scoped subscriptions for that exact connection.
create index if not exists connector_connections_provider_workspace_idx
  on public.connector_connections(provider_family, external_account_id, status)
  where provider_family in ('slack', 'notion') and status = 'connected';

create index if not exists connector_subscriptions_provider_event_idx
  on public.connector_subscriptions(connector_id, operation_key, connection_id, status)
  where connector_id in ('slack', 'notion') and status = 'active';

-- Preserve the Phase 7A boundary: browser roles may inspect safe connection
-- labels through owner RLS, but cannot invoke or mutate subscriptions/receipts.
revoke all on public.connector_subscriptions, public.connector_event_receipts
  from public, anon, authenticated;
grant all on public.connector_subscriptions, public.connector_event_receipts
  to service_role;

commit;
