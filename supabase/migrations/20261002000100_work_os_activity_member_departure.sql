begin;

-- Membership changes revoke visibility through RLS; they must not erase
-- historical company activity. Account deletion still cascades for privacy.
alter table public.activity_events
  drop constraint activity_events_owner_membership_fkey;

alter table public.activity_events
  add constraint activity_events_owner_user_fkey
  foreign key (owner_user_id) references auth.users(id) on delete cascade;

create index activity_events_owner_user_idx
  on public.activity_events(owner_user_id);

commit;
