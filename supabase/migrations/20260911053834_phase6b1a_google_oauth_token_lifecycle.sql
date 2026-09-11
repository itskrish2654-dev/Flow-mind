begin;

-- Validate and publish a Google OAuth connection and both encrypted vault rows
-- in one database transaction. This function deliberately remains SECURITY
-- INVOKER: only the service role has table privileges and EXECUTE permission.
create or replace function public.finalize_google_oauth_connection(
  p_connection_id uuid,
  p_user_id uuid,
  p_external_account_id text,
  p_external_account_label text,
  p_granted_scopes text[],
  p_token_expires_at timestamptz,
  p_safe_metadata jsonb,
  p_access_credential jsonb,
  p_refresh_credential jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_connection public.connector_connections%rowtype;
  v_exists boolean := false;
  v_has_refresh boolean := false;
  v_refreshable boolean := false;
begin
  if p_connection_id is null
     or p_user_id is null
     or coalesce(char_length(p_external_account_id), 0) not between 1 and 255
     or p_granted_scopes is null
     or p_token_expires_at is null
     or p_token_expires_at <= clock_timestamp()
     or p_safe_metadata is null
     or jsonb_typeof(p_safe_metadata) <> 'object'
     or p_access_credential is null
     or 'https://www.googleapis.com/auth/spreadsheets' = any(p_granted_scopes) then
    raise exception 'invalid Google OAuth finalization';
  end if;

  if jsonb_typeof(p_access_credential) <> 'object'
     or p_access_credential->>'credential_key' <> 'access_token'
     or p_access_credential->>'credential_type' <> 'oauth_access_token'
     or coalesce(p_access_credential->>'ciphertext', '') = ''
     or coalesce(p_access_credential->>'nonce', '') = ''
     or coalesce(p_access_credential->>'auth_tag', '') = ''
     or p_access_credential->>'algorithm' <> 'aes-256-gcm'
     or p_access_credential->>'encryption_version' <> '1' then
    raise exception 'invalid Google access credential';
  end if;

  if p_refresh_credential is not null and (
       jsonb_typeof(p_refresh_credential) <> 'object'
       or p_refresh_credential->>'credential_key' <> 'refresh_token'
       or p_refresh_credential->>'credential_type' <> 'oauth_refresh_token'
       or coalesce(p_refresh_credential->>'ciphertext', '') = ''
       or coalesce(p_refresh_credential->>'nonce', '') = ''
       or coalesce(p_refresh_credential->>'auth_tag', '') = ''
       or p_refresh_credential->>'algorithm' <> 'aes-256-gcm'
       or p_refresh_credential->>'encryption_version' <> '1'
     ) then
    raise exception 'invalid Google refresh credential';
  end if;

  select * into v_connection
  from public.connector_connections
  where id = p_connection_id and user_id = p_user_id
  for update;
  v_exists := found;

  if v_exists then
    if v_connection.connector_id <> 'google'
       or v_connection.provider_family <> 'google'
       or v_connection.auth_type <> 'oauth2'
       or v_connection.external_account_id <> p_external_account_id then
      raise exception 'Google connection identity mismatch';
    end if;
    if coalesce((v_connection.safe_metadata->>'refresh_lease_until')::timestamptz, '-infinity'::timestamptz) > clock_timestamp() then
      raise exception 'Google token refresh is in progress';
    end if;
    select exists(
      select 1
      from public.connector_connection_credentials credential
      where credential.connection_id = p_connection_id
        and credential.user_id = p_user_id
        and credential.credential_key = 'refresh_token'
        and credential.credential_type = 'oauth_refresh_token'
        and credential.ciphertext <> ''
        and credential.nonce <> ''
        and credential.auth_tag <> ''
        and credential.algorithm = 'aes-256-gcm'
        and credential.encryption_version = 1
    ) into v_has_refresh;
    v_refreshable := v_connection.status = 'connected'
      or (v_connection.status = 'expired' and v_connection.last_error_category is null);
    if p_refresh_credential is null and not (v_refreshable and v_has_refresh) then
      raise exception 'durable Google refresh credential required';
    end if;
  else
    if p_refresh_credential is null then
      raise exception 'durable Google refresh credential required';
    end if;
    if exists(
      select 1 from public.connector_connections
      where user_id = p_user_id
        and connector_id = 'google'
        and external_account_id = p_external_account_id
        and id <> p_connection_id
    ) then
      raise exception 'Google connection already exists';
    end if;
    insert into public.connector_connections (
      id, user_id, connector_id, provider_family, external_account_id,
      external_account_label, auth_type, status, granted_scopes,
      token_expires_at, last_refreshed_at, last_error_category,
      safe_metadata, updated_at
    ) values (
      p_connection_id, p_user_id, 'google', 'google', p_external_account_id,
      p_external_account_label, 'oauth2', 'error', '{}', null, null,
      'credential_finalization', '{}'::jsonb, clock_timestamp()
    );
  end if;

  insert into public.connector_connection_credentials (
    connection_id, user_id, credential_key, credential_type, ciphertext,
    nonce, auth_tag, algorithm, encryption_version, updated_at
  ) values (
    p_connection_id, p_user_id, 'access_token', 'oauth_access_token',
    p_access_credential->>'ciphertext', p_access_credential->>'nonce',
    p_access_credential->>'auth_tag', p_access_credential->>'algorithm',
    (p_access_credential->>'encryption_version')::smallint, clock_timestamp()
  )
  on conflict (connection_id, credential_key) do update set
    user_id = excluded.user_id,
    credential_type = excluded.credential_type,
    ciphertext = excluded.ciphertext,
    nonce = excluded.nonce,
    auth_tag = excluded.auth_tag,
    algorithm = excluded.algorithm,
    encryption_version = excluded.encryption_version,
    updated_at = clock_timestamp();

  if p_refresh_credential is not null then
    insert into public.connector_connection_credentials (
      connection_id, user_id, credential_key, credential_type, ciphertext,
      nonce, auth_tag, algorithm, encryption_version, updated_at
    ) values (
      p_connection_id, p_user_id, 'refresh_token', 'oauth_refresh_token',
      p_refresh_credential->>'ciphertext', p_refresh_credential->>'nonce',
      p_refresh_credential->>'auth_tag', p_refresh_credential->>'algorithm',
      (p_refresh_credential->>'encryption_version')::smallint, clock_timestamp()
    )
    on conflict (connection_id, credential_key) do update set
      user_id = excluded.user_id,
      credential_type = excluded.credential_type,
      ciphertext = excluded.ciphertext,
      nonce = excluded.nonce,
      auth_tag = excluded.auth_tag,
      algorithm = excluded.algorithm,
      encryption_version = excluded.encryption_version,
      updated_at = clock_timestamp();
  end if;

  update public.connector_connections set
    external_account_label = p_external_account_label,
    status = 'connected',
    granted_scopes = p_granted_scopes,
    token_expires_at = p_token_expires_at,
    last_refreshed_at = clock_timestamp(),
    last_error_category = null,
    safe_metadata = p_safe_metadata,
    updated_at = clock_timestamp()
  where id = p_connection_id and user_id = p_user_id;

  if not found then
    raise exception 'Google connection finalization failed';
  end if;
  return p_connection_id;
end;
$$;

revoke all on function public.finalize_google_oauth_connection(uuid, uuid, text, text, text[], timestamptz, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_google_oauth_connection(uuid, uuid, text, text, text[], timestamptz, jsonb, jsonb, jsonb) to service_role;

-- Commit a refreshed access token, an optional rotated refresh token, and the
-- healthy connection metadata atomically while the owner-bound lease is live.
create or replace function public.finalize_google_token_refresh(
  p_connection_id uuid,
  p_user_id uuid,
  p_token_expires_at timestamptz,
  p_granted_scopes text[],
  p_access_credential jsonb,
  p_refresh_credential jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_connection public.connector_connections%rowtype;
begin
  if p_connection_id is null
     or p_user_id is null
     or p_token_expires_at is null
     or p_token_expires_at <= clock_timestamp()
     or p_access_credential is null
     or (p_granted_scopes is not null and 'https://www.googleapis.com/auth/spreadsheets' = any(p_granted_scopes)) then
    raise exception 'invalid Google token refresh finalization';
  end if;
  if jsonb_typeof(p_access_credential) <> 'object'
     or p_access_credential->>'credential_key' <> 'access_token'
     or p_access_credential->>'credential_type' <> 'oauth_access_token'
     or coalesce(p_access_credential->>'ciphertext', '') = ''
     or coalesce(p_access_credential->>'nonce', '') = ''
     or coalesce(p_access_credential->>'auth_tag', '') = ''
     or p_access_credential->>'algorithm' <> 'aes-256-gcm'
     or p_access_credential->>'encryption_version' <> '1' then
    raise exception 'invalid Google access credential';
  end if;
  if p_refresh_credential is not null and (
       jsonb_typeof(p_refresh_credential) <> 'object'
       or p_refresh_credential->>'credential_key' <> 'refresh_token'
       or p_refresh_credential->>'credential_type' <> 'oauth_refresh_token'
       or coalesce(p_refresh_credential->>'ciphertext', '') = ''
       or coalesce(p_refresh_credential->>'nonce', '') = ''
       or coalesce(p_refresh_credential->>'auth_tag', '') = ''
       or p_refresh_credential->>'algorithm' <> 'aes-256-gcm'
       or p_refresh_credential->>'encryption_version' <> '1'
     ) then
    raise exception 'invalid rotated Google refresh credential';
  end if;

  select * into v_connection
  from public.connector_connections
  where id = p_connection_id
    and user_id = p_user_id
    and connector_id = 'google'
    and provider_family = 'google'
    and auth_type = 'oauth2'
    and status in ('connected', 'expired')
  for update;
  if not found then
    raise exception 'Google connection is unavailable';
  end if;
  if coalesce((v_connection.safe_metadata->>'refresh_lease_until')::timestamptz, '-infinity'::timestamptz) <= clock_timestamp() then
    raise exception 'Google token refresh lease is unavailable';
  end if;
  if not exists(
    select 1 from public.connector_connection_credentials credential
    where credential.connection_id = p_connection_id
      and credential.user_id = p_user_id
      and credential.credential_key = 'refresh_token'
      and credential.credential_type = 'oauth_refresh_token'
  ) then
    raise exception 'Google refresh credential is unavailable';
  end if;

  insert into public.connector_connection_credentials (
    connection_id, user_id, credential_key, credential_type, ciphertext,
    nonce, auth_tag, algorithm, encryption_version, updated_at
  ) values (
    p_connection_id, p_user_id, 'access_token', 'oauth_access_token',
    p_access_credential->>'ciphertext', p_access_credential->>'nonce',
    p_access_credential->>'auth_tag', p_access_credential->>'algorithm',
    (p_access_credential->>'encryption_version')::smallint, clock_timestamp()
  )
  on conflict (connection_id, credential_key) do update set
    user_id = excluded.user_id,
    credential_type = excluded.credential_type,
    ciphertext = excluded.ciphertext,
    nonce = excluded.nonce,
    auth_tag = excluded.auth_tag,
    algorithm = excluded.algorithm,
    encryption_version = excluded.encryption_version,
    updated_at = clock_timestamp();

  if p_refresh_credential is not null then
    insert into public.connector_connection_credentials (
      connection_id, user_id, credential_key, credential_type, ciphertext,
      nonce, auth_tag, algorithm, encryption_version, updated_at
    ) values (
      p_connection_id, p_user_id, 'refresh_token', 'oauth_refresh_token',
      p_refresh_credential->>'ciphertext', p_refresh_credential->>'nonce',
      p_refresh_credential->>'auth_tag', p_refresh_credential->>'algorithm',
      (p_refresh_credential->>'encryption_version')::smallint, clock_timestamp()
    )
    on conflict (connection_id, credential_key) do update set
      user_id = excluded.user_id,
      credential_type = excluded.credential_type,
      ciphertext = excluded.ciphertext,
      nonce = excluded.nonce,
      auth_tag = excluded.auth_tag,
      algorithm = excluded.algorithm,
      encryption_version = excluded.encryption_version,
      updated_at = clock_timestamp();
  end if;

  update public.connector_connections set
    status = 'connected',
    granted_scopes = coalesce(p_granted_scopes, granted_scopes),
    token_expires_at = p_token_expires_at,
    last_refreshed_at = clock_timestamp(),
    last_error_category = null,
    updated_at = clock_timestamp()
  where id = p_connection_id and user_id = p_user_id;
  return found;
end;
$$;

revoke all on function public.finalize_google_token_refresh(uuid, uuid, timestamptz, text[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_google_token_refresh(uuid, uuid, timestamptz, text[], jsonb, jsonb) to service_role;

-- Ordinary Google access-token expiry is refreshable while an owner-bound
-- durable refresh credential exists. Other OAuth providers retain the prior
-- maintenance behavior.
create or replace function public.run_connector_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_oauth_states integer := 0;
  v_receipts integer := 0;
  v_expired_subscriptions integer := 0;
  v_expired_connections integer := 0;
begin
  delete from public.connector_oauth_states
  where expires_at < clock_timestamp() - interval '1 day';
  get diagnostics v_oauth_states = row_count;

  delete from public.connector_event_receipts
  where expires_at < clock_timestamp();
  get diagnostics v_receipts = row_count;

  update public.connector_subscriptions
  set status = 'expired', updated_at = clock_timestamp()
  where status = 'active'
    and expires_at is not null
    and expires_at < clock_timestamp();
  get diagnostics v_expired_subscriptions = row_count;

  update public.connector_connections connection
  set status = 'expired', updated_at = clock_timestamp()
  where connection.status = 'connected'
    and connection.token_expires_at is not null
    and connection.token_expires_at < clock_timestamp() - interval '5 minutes'
    and not (
      connection.provider_family = 'google'
      and connection.connector_id = 'google'
      and connection.auth_type = 'oauth2'
      and exists(
        select 1
        from public.connector_connection_credentials credential
        where credential.connection_id = connection.id
          and credential.user_id = connection.user_id
          and credential.credential_key = 'refresh_token'
          and credential.credential_type = 'oauth_refresh_token'
          and credential.ciphertext <> ''
          and credential.nonce <> ''
          and credential.auth_tag <> ''
          and credential.algorithm = 'aes-256-gcm'
          and credential.encryption_version = 1
      )
    );
  get diagnostics v_expired_connections = row_count;

  return jsonb_build_object(
    'expiredOauthStates', v_oauth_states,
    'expiredEventReceipts', v_receipts,
    'expiredSubscriptions', v_expired_subscriptions,
    'expiredConnections', v_expired_connections
  );
end;
$$;

revoke all on function public.run_connector_maintenance() from public, anon, authenticated;
grant execute on function public.run_connector_maintenance() to service_role;

commit;
