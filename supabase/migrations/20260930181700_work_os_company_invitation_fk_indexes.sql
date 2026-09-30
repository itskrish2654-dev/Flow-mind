begin;

create index workspace_invitations_created_by_idx
  on public.workspace_invitations(created_by);
create index workspace_invitations_accepted_by_idx
  on public.workspace_invitations(accepted_by)
  where accepted_by is not null;
create index workspace_invitations_revoked_by_idx
  on public.workspace_invitations(revoked_by)
  where revoked_by is not null;

commit;
