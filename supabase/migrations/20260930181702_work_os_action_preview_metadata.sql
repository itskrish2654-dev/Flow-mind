begin;

alter table public.ask_messages
  drop constraint ask_messages_metadata_check,
  add constraint ask_messages_metadata_check check (
    (role = 'user' and response_metadata is null)
    or (
      role = 'assistant'
      and coalesce(jsonb_typeof(response_metadata) = 'object', false)
      and response_metadata @> '{"version":1}'::jsonb
      and response_metadata ->> 'responseType' in ('answer', 'clarification', 'unsupported', 'action_preview')
      and jsonb_typeof(response_metadata -> 'clarificationRequired') = 'boolean'
      and jsonb_typeof(response_metadata -> 'references') = 'array'
      and jsonb_array_length(response_metadata -> 'references') <= 12
      and (
        (response_metadata ->> 'responseType' = 'action_preview'
          and jsonb_typeof(response_metadata -> 'actionPreview') = 'object')
        or
        (response_metadata ->> 'responseType' <> 'action_preview'
          and not response_metadata ? 'actionPreview')
      )
      and (
        response_metadata
          - array[
            'version', 'responseType', 'clarificationRequired', 'references',
            'suggestedAction', 'unsupportedReason', 'actionPreview'
          ]
      ) = '{}'::jsonb
      and octet_length(response_metadata::text) <= 8192
    )
  );

-- Connector deletion uses the table's ON DELETE SET NULL action. Permit only
-- that one database-managed identity transition so a historical action cannot
-- block credential/account cleanup; all other action identity remains frozen.
create or replace function public.guard_action_execution_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if row(new.id, new.workspace_id, new.requester_user_id, new.approval_request_id,
    new.work_item_id, new.source_message_id, new.capability_id,
    new.connector_id, new.operation_key, new.operation_version, new.idempotency_key,
    new.created_at)
    is distinct from
    row(old.id, old.workspace_id, old.requester_user_id, old.approval_request_id,
    old.work_item_id, old.source_message_id, old.capability_id,
    old.connector_id, old.operation_key, old.operation_version, old.idempotency_key,
    old.created_at)
  then raise exception 'Action execution identity is immutable'; end if;
  if new.connection_id is distinct from old.connection_id
    and not (old.connection_id is not null and new.connection_id is null)
  then raise exception 'Action execution connection identity is immutable'; end if;
  return new;
end;
$$;

commit;
