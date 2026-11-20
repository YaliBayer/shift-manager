-- Run after 202611190003_delete_workspace.sql.
begin;

alter table public.sm_workspaces
  add column published_weeks jsonb not null default '{}'::jsonb
  check (jsonb_typeof(published_weeks) = 'object');

create or replace function public.sm_get_workspace(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare workspace public.sm_workspaces; membership public.sm_members;
  statuses jsonb; day record; cell record; owned boolean; requested_constraint boolean;
  published_list jsonb; latest_snapshot jsonb;
begin
  select * into membership from public.sm_members where workspace_id = p_workspace and user_id = auth.uid();
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into workspace from public.sm_workspaces where id = p_workspace;
  select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into published_list
    from jsonb_object_keys(workspace.published_weeks) as weeks(key);
  if membership.role = 'manager' then
    return (to_jsonb(workspace) - 'published_weeks') || jsonb_build_object('publishedWeeks', published_list);
  end if;
  select week.value into latest_snapshot
    from jsonb_each(workspace.published_weeks) as week(key, value)
    order by week.value->>'publishedAt' desc limit 1;
  workspace.data := jsonb_set(workspace.data, '{shifts}', coalesce(latest_snapshot->'shifts', '[]'::jsonb));
  workspace.data := jsonb_set(workspace.data, '{customStatuses}', coalesce(latest_snapshot->'customStatuses', '[]'::jsonb));
  workspace.data := jsonb_set(workspace.data, '{assignments}', coalesce((
    select jsonb_object_agg(week.key, coalesce(week.value->'assignments', '{}'::jsonb))
    from jsonb_each(workspace.published_weeks) as week(key, value)
  ), '{}'::jsonb));
  workspace.data := jsonb_set(workspace.data, '{lockedSlots}', coalesce((
    select jsonb_object_agg(week.key, coalesce(week.value->'lockedSlots', '[]'::jsonb))
    from jsonb_each(workspace.published_weeks) as week(key, value)
  ), '{}'::jsonb));
  statuses := workspace.data->'dailyStatuses';
  for day in select * from jsonb_each(statuses) loop
    for cell in select * from jsonb_each(day.value) loop
      select exists (
        select 1 from public.sm_requests r where r.workspace_id = p_workspace
          and r.worker_id = cell.key and r.request_date::text = day.key
          and r.kind = 'constraint' and r.status = 'approved'
      ) into requested_constraint;
      if requested_constraint then
        select exists (
          select 1 from public.sm_requests r where r.workspace_id = p_workspace
            and r.worker_id = cell.key and r.request_date::text = day.key
            and r.kind = 'constraint' and r.status = 'approved' and r.user_id = auth.uid()
        ) into owned;
      else
        owned := membership.worker_id is not distinct from cell.key;
      end if;
      if (requested_constraint or cell.value->>'label' = 'אילוץ' or cell.value->>'id' = 'constraint')
        and not owned then
        statuses := statuses #- array[day.key, cell.key];
      end if;
    end loop;
    if statuses->day.key = '{}'::jsonb then statuses := statuses - day.key; end if;
  end loop;
  workspace.data := jsonb_set(workspace.data, '{dailyStatuses}', statuses);
  workspace.data := jsonb_set(workspace.data, '{workers}', coalesce((
    select jsonb_agg(case when w->>'id' = membership.worker_id then w
      else jsonb_set(w, '{excludedDays}', '[]'::jsonb) end order by position)
    from jsonb_array_elements(workspace.data->'workers') with ordinality as workers(w, position)
  ), '[]'::jsonb));
  return (to_jsonb(workspace) - 'published_weeks') || jsonb_build_object('publishedWeeks', published_list);
end $$;

create function public.sm_publish_week(p_workspace uuid, p_week date, p_revision bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare workspace public.sm_workspaces; snapshot jsonb; published_list jsonb;
begin
  select * into workspace from public.sm_workspaces where id = p_workspace for update;
  if not found then raise exception 'WORKSPACE_NOT_FOUND'; end if;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  if workspace.revision is distinct from p_revision then raise exception 'STALE_REVISION'; end if;
  if extract(dow from p_week) <> 0 then raise exception 'INVALID_WEEK'; end if;
  snapshot := jsonb_build_object(
    'shifts', workspace.data->'shifts',
    'customStatuses', workspace.data->'customStatuses',
    'assignments', coalesce(workspace.data->'assignments'->p_week::text, '{}'::jsonb),
    'lockedSlots', coalesce(workspace.data->'lockedSlots'->p_week::text, '[]'::jsonb),
    'publishedAt', to_jsonb(now())
  );
  update public.sm_workspaces
    set published_weeks = jsonb_set(published_weeks, array[p_week::text], snapshot),
      revision = revision + 1
    where id = p_workspace returning * into workspace;
  select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into published_list
    from jsonb_object_keys(workspace.published_weeks) as weeks(key);
  return (to_jsonb(workspace) - 'published_weeks') || jsonb_build_object('publishedWeeks', published_list);
end $$;

revoke all on function public.sm_publish_week(uuid, date, bigint) from public, anon;
grant execute on function public.sm_publish_week(uuid, date, bigint) to authenticated;

notify pgrst, 'reload schema';
commit;
