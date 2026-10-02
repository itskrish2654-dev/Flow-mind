begin;

-- Cover the composite references used by Goal plan and Work Item cleanup.
create index goal_plan_items_workspace_goal_plan_fk_idx
  on public.goal_plan_items(workspace_id, goal_id, plan_id);
create index goals_current_plan_fk_idx
  on public.goals(workspace_id, id, current_plan_id);
create index goals_approved_plan_fk_idx
  on public.goals(workspace_id, id, approved_plan_id);
create index work_items_goal_plan_item_fk_idx
  on public.work_items(workspace_id, goal_id, goal_plan_item_id);

commit;
