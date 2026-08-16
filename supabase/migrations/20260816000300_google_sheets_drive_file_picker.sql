begin;

create table if not exists public.google_selected_spreadsheets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connector_connections(id) on delete cascade,
  spreadsheet_id text not null,
  display_name text not null,
  mime_type text not null default 'application/vnd.google-apps.spreadsheet'
    check (mime_type = 'application/vnd.google-apps.spreadsheet'),
  selected_at timestamptz not null default clock_timestamp(),
  last_validated_at timestamptz not null default clock_timestamp(),
  unique (connection_id, spreadsheet_id),
  check (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  check (char_length(display_name) between 1 and 255)
);

create index if not exists google_selected_spreadsheets_owner_idx
  on public.google_selected_spreadsheets(user_id, connection_id);

alter table public.google_selected_spreadsheets enable row level security;
alter table public.google_selected_spreadsheets force row level security;
revoke all on public.google_selected_spreadsheets from public, anon, authenticated;
grant all on public.google_selected_spreadsheets to service_role;

-- Every existing Google grant predates the per-file Picker boundary. Expire it
-- fail-closed; the reconnect route revokes the remote grant before issuing new
-- drive.file or Gmail authorization.
update public.connector_connections
set status = 'expired',
    last_error_category = 'authorization',
    safe_metadata = safe_metadata || jsonb_build_object(
      'drive_file_reconnect_required', true,
      'scope_migration', 'google_sheets_drive_file_v1'
    ),
    updated_at = clock_timestamp()
where provider_family = 'google' and status <> 'revoked';

commit;
