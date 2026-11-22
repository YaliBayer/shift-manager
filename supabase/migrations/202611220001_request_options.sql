-- Run after 202611200001_week_publishing.sql.
begin;

alter table public.sm_requests drop constraint sm_requests_kind_check;
alter table public.sm_requests
  add constraint sm_requests_kind_check check (kind in ('constraint', 'holiday', 'leave', 'day_shift', 'night_shift', 'custom')),
  add column custom_status_id text,
  add column custom_status jsonb,
  add column assigned_shift_id text,
  add constraint sm_request_custom_status check (
    (kind <> 'custom' and custom_status_id is null and custom_status is null) or
    (kind = 'custom' and custom_status_id is not null and length(custom_status_id) > 0 and coalesce(
      jsonb_typeof(custom_status) = 'object' and
      jsonb_typeof(custom_status->'label') = 'string' and length(btrim(custom_status->>'label')) > 0 and
      (custom_status->>'color') ~ '^#[0-9a-fA-F]{6}$' and
      jsonb_typeof(custom_status->'blocksShifts') = 'boolean', false))
  ),
  add constraint sm_request_assigned_shift check (
    (assigned_shift_id is null or (kind in ('day_shift', 'night_shift') and length(assigned_shift_id) > 0)) and
    (status <> 'approved' or kind not in ('day_shift', 'night_shift') or assigned_shift_id is not null)
  );

create function shift_private.shift_period(p_shift jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when p_shift->>'period' in ('day', 'night') then p_shift->>'period'
    when (p_shift->>'end')::time <= (p_shift->>'start')::time
      or (p_shift->>'start')::time >= time '18:00' or (p_shift->>'start')::time < time '06:00'
    then 'night' else 'day' end
$$;

create function shift_private.occurrence_window(p_week date, p_day integer, p_shift jsonb)
returns table (starts timestamp, ends timestamp, rest_ends timestamp)
language plpgsql immutable set search_path = '' as $$
declare span integer; grouped boolean := p_shift ? 'grouping' and p_shift->'grouping' <> 'null'::jsonb;
begin
  if grouped then
    span := ((p_shift->'grouping'->>'endDay')::integer - (p_shift->'grouping'->>'startDay')::integer + 7) % 7;
    if span = 0 and (p_shift->>'end')::time <= (p_shift->>'start')::time then span := 7; end if;
  else
    span := case when (p_shift->>'end')::time <= (p_shift->>'start')::time then 1 else 0 end;
  end if;
  starts := (p_week + p_day) + (p_shift->>'start')::time;
  ends := (p_week + p_day + span) + (p_shift->>'end')::time;
  rest_ends := case when grouped or shift_private.shift_period(p_shift) = 'night'
    then ends::date + interval '1 day' else ends end;
  return next;
end $$;

create or replace function shift_private.has_assignment(p_data jsonb, p_worker text, p_date date) returns boolean
language plpgsql stable set search_path = '' as $$
declare week record; slot record; s jsonb; occurrence record;
begin
  for week in select * from jsonb_each(p_data->'assignments') loop
    for slot in select * from jsonb_each(week.value) loop
      if not (slot.value ? p_worker) then continue; end if;
      select value into s from jsonb_array_elements(p_data->'shifts') where value->>'id' = substring(slot.key from 3);
      if s is null then raise exception 'UNKNOWN_SHIFT'; end if;
      select * into occurrence from shift_private.occurrence_window(week.key::date, left(slot.key, 1)::integer, s);
      if occurrence.starts < p_date + interval '1 day' and occurrence.ends > p_date::timestamp then return true; end if;
    end loop;
  end loop;
  return false;
end $$;

create function shift_private.request_status(p_request public.sm_requests) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare result jsonb;
begin
  if p_request.kind in ('day_shift', 'night_shift') then return null; end if;
  if p_request.kind = 'custom' then
    result := p_request.custom_status;
  else
    result := jsonb_build_object(
      'label', case p_request.kind when 'constraint' then 'אילוץ' when 'holiday' then 'חג' when 'leave' then 'חופש' end,
      'color', case p_request.kind when 'constraint' then '#ff9999' when 'holiday' then '#ffd9df' when 'leave' then '#ad86f5' end,
      'blocksShifts', true);
  end if;
  return result || jsonb_build_object('note', 'בקשה מאושרת', 'requestId', p_request.id::text);
end $$;

-- Manager approval is a manual assignment, using the same coverage, symmetric
-- rest and weekly-count rules as the browser scheduler. Never displace a worker.
create function shift_private.assign_requested_shift(p_data jsonb, p_worker text, p_date date, p_kind text, p_shift text)
returns jsonb language plpgsql set search_path = '' as $$
declare worker jsonb; s jsonb; other_shift jsonb; target record; other record; day record;
  week record; slot record; start_week date; start_day integer; other_day integer; target_key text;
  ids jsonb; assignments jsonb; locks jsonb; count_in_week integer := 0;
begin
  if p_shift is null or p_shift = '' then raise exception 'REQUEST_SHIFT_REQUIRED'; end if;
  select value into worker from jsonb_array_elements(p_data->'workers') where value->>'id' = p_worker;
  if worker is null then raise exception 'UNKNOWN_WORKER'; end if;
  select value into s from jsonb_array_elements(p_data->'shifts') where value->>'id' = p_shift;
  start_day := extract(dow from p_date)::integer;
  start_week := p_date - start_day;
  if s is null or (s ? 'grouping' and s->'grouping' <> 'null'::jsonb)
    or not coalesce(s->'activeDays' @> jsonb_build_array(start_day), false)
    or shift_private.shift_period(s) is distinct from (case p_kind when 'day_shift' then 'day' when 'night_shift' then 'night' end) then
    raise exception 'REQUEST_SHIFT_MISMATCH';
  end if;
  if worker->>'groupedOnly' = 'true'
    or (worker->>'allowNightShifts' = 'false' and shift_private.shift_period(s) = 'night')
    or (s ? 'eligibleWorkerIds' and not coalesce(s->'eligibleWorkerIds' ? p_worker, false)) then
    raise exception 'REQUEST_WORKER_INELIGIBLE';
  end if;
  target_key := start_day::text || ':' || p_shift;
  ids := coalesce(p_data->'assignments'->start_week::text->target_key, '[]'::jsonb);
  if not (ids ? p_worker) and jsonb_array_length(ids) >= (s->>'requiredWorkers')::integer then raise exception 'REQUEST_SHIFT_FULL'; end if;
  select * into target from shift_private.occurrence_window(start_week, start_day, s);
  for day in select d::date as value from generate_series(target.starts::date::timestamp,
    (target.ends - interval '1 microsecond')::date::timestamp, interval '1 day') as dates(d) loop
    if worker->'excludedDays' @> jsonb_build_array(extract(dow from day.value)::integer) then raise exception 'REQUEST_WORKER_UNAVAILABLE'; end if;
    if p_data->'dailyStatuses'->day.value::text->p_worker->>'blocksShifts' = 'true' then raise exception 'REQUEST_DAILY_STATUS'; end if;
  end loop;
  for week in select * from jsonb_each(p_data->'assignments') loop
    for slot in select * from jsonb_each(week.value) loop
      if not (slot.value ? p_worker) or (week.key = start_week::text and slot.key = target_key) then continue; end if;
      select value into other_shift from jsonb_array_elements(p_data->'shifts') where value->>'id' = substring(slot.key from 3);
      if other_shift is null then raise exception 'UNKNOWN_SHIFT'; end if;
      other_day := left(slot.key, 1)::integer;
      if other_shift ? 'grouping' and other_shift->'grouping' <> 'null'::jsonb then
        if other_day <> (other_shift->'grouping'->>'startDay')::integer then continue; end if;
      elsif not (other_shift->'activeDays' @> jsonb_build_array(other_day)) then continue;
      end if;
      if week.key = start_week::text then count_in_week := count_in_week + 1; end if;
      select * into other from shift_private.occurrence_window(week.key::date, other_day, other_shift);
      if target.starts < other.ends and other.starts < target.ends then raise exception 'REQUEST_OVERLAP'; end if;
      if target.starts < other.rest_ends and other.starts < target.rest_ends then raise exception 'REQUEST_REST'; end if;
    end loop;
  end loop;
  if count_in_week >= (worker->>'maxShifts')::integer then raise exception 'REQUEST_LIMIT'; end if;
  if not (ids ? p_worker) then ids := ids || jsonb_build_array(p_worker); end if;
  assignments := jsonb_set(p_data->'assignments', array[start_week::text],
    coalesce(p_data->'assignments'->start_week::text, '{}'::jsonb) || jsonb_build_object(target_key, ids));
  locks := coalesce(p_data->'lockedSlots'->start_week::text, '[]'::jsonb);
  if not (locks ? target_key) then locks := locks || jsonb_build_array(target_key); end if;
  return jsonb_set(jsonb_set(p_data, '{assignments}', assignments), '{lockedSlots}',
    jsonb_set(p_data->'lockedSlots', array[start_week::text], locks));
end $$;

drop function public.sm_submit_request(uuid, date, text, text);
create function public.sm_submit_request(p_workspace uuid, p_date date, p_kind text, p_reason text, p_custom_status_id text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare worker text; result uuid; current_data jsonb; definition jsonb; snapshot jsonb;
begin
  select data into current_data from public.sm_workspaces where id = p_workspace for update;
  select worker_id into worker from public.sm_members where workspace_id = p_workspace and user_id = auth.uid();
  if worker is null then raise exception 'WORKER_LINK_REQUIRED'; end if;
  if not exists (select 1 from jsonb_array_elements(current_data->'workers') w where w->>'id' = worker) then raise exception 'UNKNOWN_WORKER'; end if;
  if p_kind = 'custom' then
    select value into definition from jsonb_array_elements(public.sm_get_workspace(p_workspace)->'data'->'customStatuses')
      where value->>'id' = p_custom_status_id;
    if definition is null then raise exception 'INVALID_CUSTOM_STATUS'; end if;
    snapshot := jsonb_build_object('label', definition->>'label', 'color', definition->>'color',
      'blocksShifts', definition->'blocksShifts', 'note', '');
  elsif p_custom_status_id is not null then raise exception 'INVALID_CUSTOM_STATUS';
  end if;
  insert into public.sm_requests(workspace_id, user_id, worker_id, request_date, kind, reason, custom_status_id, custom_status)
    values (p_workspace, auth.uid(), worker, p_date, p_kind, btrim(p_reason), p_custom_status_id, snapshot) returning id into result;
  return result;
end $$;

drop function public.sm_decide_request(uuid, text, text, bigint);
create function public.sm_decide_request(p_request uuid, p_decision text, p_note text, p_revision bigint, p_shift_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare request public.sm_requests; workspace public.sm_workspaces; cell jsonb; statuses jsonb; updated jsonb;
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
    if not exists (select 1 from jsonb_array_elements(workspace.data->'workers') w where w->>'id' = request.worker_id) then raise exception 'UNKNOWN_WORKER'; end if;
    if request.kind in ('day_shift', 'night_shift') then
      updated := shift_private.assign_requested_shift(workspace.data, request.worker_id, request.request_date, request.kind, p_shift_id);
    else
      if p_shift_id is not null then raise exception 'REQUEST_SHIFT_MISMATCH'; end if;
      cell := shift_private.request_status(request);
      if cell->>'blocksShifts' = 'true' and shift_private.has_assignment(workspace.data, request.worker_id, request.request_date) then
        raise exception 'REQUEST_SHIFT_CONFLICT';
      end if;
      if workspace.data->'dailyStatuses'->request.request_date::text->request.worker_id is not null then raise exception 'REQUEST_STATUS_CONFLICT'; end if;
      statuses := jsonb_set(workspace.data->'dailyStatuses', array[request.request_date::text],
        coalesce(workspace.data->'dailyStatuses'->request.request_date::text, '{}'::jsonb) || jsonb_build_object(request.worker_id, cell));
      updated := jsonb_set(workspace.data, '{dailyStatuses}', statuses);
    end if;
    update public.sm_workspaces set data = updated, revision = revision + 1 where id = workspace.id;
  end if;
  update public.sm_requests set status = p_decision, decision_note = btrim(p_note),
    assigned_shift_id = case when p_decision = 'approved' and kind in ('day_shift', 'night_shift') then p_shift_id else null end,
    decided_by = auth.uid(), decided_at = now() where id = p_request;
end $$;

create or replace function public.sm_save_workspace(p_workspace uuid, p_revision bigint, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.sm_workspaces; request public.sm_requests; cell jsonb; expected jsonb;
begin
  select * into result from public.sm_workspaces where id = p_workspace for update;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  if result.revision is distinct from p_revision then raise exception 'STALE_REVISION'; end if;
  perform shift_private.validate_data(p_data);
  for request in select * from public.sm_requests where workspace_id = p_workspace and status = 'approved'
    and kind not in ('day_shift', 'night_shift') loop
    if not exists (select 1 from jsonb_array_elements(p_data->'workers') w where w->>'id' = request.worker_id) then continue; end if;
    cell := p_data->'dailyStatuses'->request.request_date::text->request.worker_id;
    expected := shift_private.request_status(request);
    if cell->>'blocksShifts' is distinct from expected->>'blocksShifts' or cell->>'label' is distinct from expected->>'label'
      or (request.kind = 'custom' and cell->>'color' is distinct from expected->>'color') then
      raise exception 'APPROVED_REQUEST_PROTECTED';
    end if;
    if expected->>'blocksShifts' = 'true' and shift_private.has_assignment(p_data, request.worker_id, request.request_date) then raise exception 'REQUEST_SHIFT_CONFLICT'; end if;
    p_data := jsonb_set(p_data, array['dailyStatuses', request.request_date::text, request.worker_id],
      cell || jsonb_build_object('requestId', request.id::text));
  end loop;
  update public.sm_workspaces set data = p_data, revision = revision + 1 where id = p_workspace returning * into result;
  update public.sm_members m set worker_id = null where m.workspace_id = p_workspace and m.worker_id is not null
    and not exists (select 1 from jsonb_array_elements(p_data->'workers') w where w->>'id' = m.worker_id);
  return to_jsonb(result);
end $$;

revoke all on function public.sm_submit_request(uuid, date, text, text, text),
  public.sm_decide_request(uuid, text, text, bigint, text) from public, anon;
grant execute on function public.sm_submit_request(uuid, date, text, text, text),
  public.sm_decide_request(uuid, text, text, bigint, text) to authenticated;

notify pgrst, 'reload schema';
commit;
