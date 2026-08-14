begin;

alter table public.connector_oauth_states
  add column if not exists intended_connection_id uuid references public.connector_connections(id) on delete cascade,
  add column if not exists operation_key text;

create index if not exists connector_connections_google_account_idx
  on public.connector_connections(user_id, provider_family, external_account_id)
  where provider_family = 'google' and status <> 'revoked';

create index if not exists connector_subscriptions_google_renewal_idx
  on public.connector_subscriptions(connection_id, renew_after)
  where connector_id = 'google_gmail' and status = 'active';

-- Gmail Pub/Sub identifies the mailbox by email. Normalize labels once so the
-- runtime can use an exact comparison instead of a wildcard-capable ILIKE.
update public.connector_connections
set external_account_label = lower(external_account_label)
where provider_family = 'google' and external_account_label is not null;

-- Google OAuth state remains service-only. Browser roles must never choose another
-- user's connection by writing the owner-bound intended_connection_id directly.
revoke all on public.connector_oauth_states from public, anon, authenticated;
grant all on public.connector_oauth_states to service_role;

commit;
