-- Run after 202611190001_workspaces.sql. Existing installations run only this file.
begin;

-- Tag existing approved blocks so cancellation can remove only its own status.
do $$
declare workspace public.sm_workspaces; request public.sm_requests; updated jsonb; cell jsonb;
begin
  for workspace in select * from public.sm_workspaces for update loop
    updated := workspace.data;
    for request in select * from public.sm_requests where workspace_id = workspace.id and status = 'approved' loop
      cell := updated->'dailyStatuses'->request.request_date::text->request.worker_id;
      if cell->>'blocksShifts' = 'true' and cell->>'label' = (case request.kind when 'holiday' then 'חג' else 'אילוץ' end) then
        updated := jsonb_set(updated, array['dailyStatuses', request.request_date::text, request.worker_id],
          cell || jsonb_build_object('requestId', request.id::text));
      end if;
    end loop;
    if updated is distinct from workspace.data then
      update public.sm_workspaces set data = updated, revision = revision + 1 where id = workspace.id;
    end if;
  end loop;
end $$;

-- Metadata remains available for workspace selection. All schedule reads must go
-- through the caller-specific RPC; hiding cells only in React would leak the JSON.
revoke select on public.sm_workspaces from public, anon, authenticated;
revoke select (data) on public.sm_workspaces from public, anon, authenticated;
grant select (id, name, revision, created_at) on public.sm_workspaces to authenticated;

create or replace function public.sm_get_workspace(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare workspace public.sm_workspaces; membership public.sm_members;
  statuses jsonb; day record; cell record; owned boolean; requested_constraint boolean;
begin
  select * into membership from public.sm_members where workspace_id = p_workspace and user_id = auth.uid();
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into workspace from public.sm_workspaces where id = p_workspace;
  if membership.role = 'manager' then return to_jsonb(workspace); end if;
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
  return to_jsonb(workspace);
end $$;

create or replace function public.sm_save_workspace(p_workspace uuid, p_revision bigint, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.sm_workspaces; request public.sm_requests; cell jsonb;
begin
  select * into result from public.sm_workspaces where id = p_workspace for update;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  if result.revision is distinct from p_revision then raise exception 'STALE_REVISION'; end if;
  perform shift_private.validate_data(p_data);
  for request in select * from public.sm_requests where workspace_id = p_workspace and status = 'approved' loop
    if not exists (select 1 from jsonb_array_elements(p_data->'workers') w where w->>'id' = request.worker_id) then continue; end if;
    cell := p_data->'dailyStatuses'->request.request_date::text->request.worker_id;
    if cell->>'blocksShifts' is distinct from 'true'
      or cell->>'label' is distinct from (case request.kind when 'holiday' then 'חג' else 'אילוץ' end) then
      raise exception 'APPROVED_REQUEST_PROTECTED';
    end if;
    if shift_private.has_assignment(p_data, request.worker_id, request.request_date) then raise exception 'REQUEST_SHIFT_CONFLICT'; end if;
    p_data := jsonb_set(p_data, array['dailyStatuses', request.request_date::text, request.worker_id],
      cell || jsonb_build_object('requestId', request.id::text));
  end loop;
  update public.sm_workspaces set data = p_data, revision = revision + 1 where id = p_workspace returning * into result;
  update public.sm_members m set worker_id = null where m.workspace_id = p_workspace and m.worker_id is not null
    and not exists (select 1 from jsonb_array_elements(p_data->'workers') w where w->>'id' = m.worker_id);
  return to_jsonb(result);
end $$;

create or replace function public.sm_decide_request(p_request uuid, p_decision text, p_note text, p_revision bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare request public.sm_requests; workspace public.sm_workspaces; cell jsonb; statuses jsonb;
begin
  select * into request from public.sm_requests where id = p_request;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  select * into workspace from public.sm_workspaces where id = request.workspace_id for update;
  if public.sm_role(request.workspace_id) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  if workspace.revision is distinct from p_revision then raise exception 'STALE_REVISION'; end if;
  select * into request from public.sm_requests where id = p_request for update;
  if request.status <> 'pending' then raise exception 'REQUEST_ALREADY_DECIDED'; end if;
  if p_decision not in ('approved', 'denied') or p_decision is null then raise exception 'INVALID_DECISION'; end if;
  if p_decision = 'approved' then
    if not exists (select 1 from jsonb_array_elements(workspace.data->'workers') w where w->>'id' = request.worker_id) then
      raise exception 'UNKNOWN_WORKER';
    end if;
    if shift_private.has_assignment(workspace.data, request.worker_id, request.request_date) then raise exception 'REQUEST_SHIFT_CONFLICT'; end if;
    if workspace.data->'dailyStatuses'->request.request_date::text->request.worker_id is not null then raise exception 'REQUEST_STATUS_CONFLICT'; end if;
    cell := jsonb_build_object('label', case request.kind when 'holiday' then 'חג' else 'אילוץ' end,
      'color', case request.kind when 'holiday' then '#ffd9df' else '#ff9999' end,
      'blocksShifts', true, 'note', 'בקשה מאושרת', 'requestId', request.id::text);
    statuses := workspace.data->'dailyStatuses';
    statuses := jsonb_set(statuses, array[request.request_date::text],
      coalesce(statuses->request.request_date::text, '{}'::jsonb) || jsonb_build_object(request.worker_id, cell));
    update public.sm_workspaces set data = jsonb_set(data, '{dailyStatuses}', statuses),
      revision = revision + 1 where id = workspace.id;
  end if;
  update public.sm_requests set status = p_decision, decision_note = btrim(p_note),
    decided_by = auth.uid(), decided_at = now() where id = p_request;
end $$;

create or replace function public.sm_revoke_request_approval(p_request uuid, p_revision bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare request public.sm_requests; workspace public.sm_workspaces; statuses jsonb; cell jsonb;
begin
  select * into request from public.sm_requests where id = p_request;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  select * into workspace from public.sm_workspaces where id = request.workspace_id for update;
  if public.sm_role(request.workspace_id) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  if workspace.revision is distinct from p_revision then raise exception 'STALE_REVISION'; end if;
  select * into request from public.sm_requests where id = p_request for update;
  if request.kind <> 'constraint' or request.status <> 'approved' then raise exception 'REQUEST_NOT_APPROVED_CONSTRAINT'; end if;
  statuses := workspace.data->'dailyStatuses';
  cell := statuses->request.request_date::text->request.worker_id;
  if cell is not null then
    if cell->>'requestId' is distinct from request.id::text then raise exception 'REQUEST_STATUS_CHANGED'; end if;
    statuses := statuses #- array[request.request_date::text, request.worker_id];
    if statuses->request.request_date::text = '{}'::jsonb then statuses := statuses - request.request_date::text; end if;
  end if;
  update public.sm_workspaces set data = jsonb_set(data, '{dailyStatuses}', statuses),
    revision = revision + 1 where id = workspace.id;
  update public.sm_requests set status = 'pending', decision_note = '',
    decided_by = null, decided_at = null where id = p_request;
end $$;

revoke all on function public.sm_get_workspace(uuid), public.sm_revoke_request_approval(uuid, bigint),
  public.sm_save_workspace(uuid, bigint, jsonb), public.sm_decide_request(uuid, text, text, bigint) from public, anon;
grant execute on function public.sm_get_workspace(uuid), public.sm_revoke_request_approval(uuid, bigint),
  public.sm_save_workspace(uuid, bigint, jsonb), public.sm_decide_request(uuid, text, text, bigint) to authenticated;

notify pgrst, 'reload schema';
commit;
