begin;

-- D3.1 allows one non-revoked customer Airtable connection per owner.
-- The application pre-check improves UX; this index is the race-safe boundary.
create unique index if not exists connector_connections_one_active_airtable_per_user
  on public.connector_connections (user_id)
  where connector_id = 'airtable'
    and provider_family = 'airtable'
    and status <> 'revoked';

commit;
