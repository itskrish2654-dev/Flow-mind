begin;

-- Map the active domain state to the approved Activity event vocabulary.
create or replace function public.record_goal_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text;
declare v_owner uuid;
declare v_actor uuid;
declare v_goal_id uuid;
declare v_source_id uuid;
begin
  if tg_table_name = 'goal_plans' then
    if tg_op = 'INSERT' then v_type := 'goal_plan_proposed';
    elsif new.status = 'approved' and old.status = 'proposed' then v_type := 'goal_plan_approved';
    else return new; end if;
    v_actor := case when v_type = 'goal_plan_approved'
      then new.approved_by_user_id else new.proposed_by_user_id end;
    v_goal_id := new.goal_id;
    v_source_id := new.id;
    select g.owner_user_id into v_owner from public.goals g where g.id = v_goal_id;
  else
    if tg_op = 'INSERT' then v_type := 'goal_created';
    elsif new.status is distinct from old.status then
      case new.status
        when 'active' then v_type := 'goal_activated';
        when 'completed' then v_type := 'goal_completed';
        when 'cancelled' then v_type := 'goal_cancelled';
        else return new;
      end case;
    else return new; end if;
    v_owner := new.owner_user_id;
    v_actor := coalesce(new.last_actor_user_id, new.created_by_user_id);
    v_goal_id := new.id;
    v_source_id := new.id;
  end if;
  if not exists (select 1 from public.workspace_memberships m
    where m.workspace_id = new.workspace_id and m.user_id = v_owner) then
    v_owner := v_actor;
  end if;
  if v_owner is null then return new; end if;
  insert into public.activity_events(workspace_id, owner_user_id, actor_user_id,
    visibility, event_type, source_type, source_id, goal_id, event_key)
  values (new.workspace_id, v_owner, v_actor, 'private', v_type, 'goal',
    v_source_id, v_goal_id, 'goal:' || v_source_id::text || ':' || v_type)
  on conflict (workspace_id, event_key) do nothing;
  insert into public.activity_events(workspace_id, owner_user_id, actor_user_id,
    visibility, event_type, source_type, source_id, goal_id, event_key)
  values (new.workspace_id, v_owner, v_actor, 'workspace', v_type, 'goal',
    v_source_id, v_goal_id, 'shared-goal:' || v_source_id::text || ':' || v_type)
  on conflict (workspace_id, event_key) do nothing;
  return new;
end;
$$;

revoke all on function public.record_goal_activity() from public, anon, authenticated;

commit;
