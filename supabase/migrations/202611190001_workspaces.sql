-- Run once in the Supabase SQL Editor. No service-role key is needed by the app.
create schema if not exists shift_private;
revoke all on schema shift_private from public, anon, authenticated;

create table public.sm_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  data jsonb not null default '{"workers":[],"shifts":[],"assignments":{},"lockedSlots":{},"dailyStatuses":{},"customStatuses":[]}'::jsonb,
  revision bigint not null default 0,
  created_at timestamptz not null default now()
);
create table public.sm_members (
  workspace_id uuid not null references public.sm_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null,
  role text not null default 'member' check (role in ('manager', 'member')),
  worker_id text,
  primary key (workspace_id, user_id),
  unique (workspace_id, worker_id)
);
create table public.sm_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sm_workspaces(id) on delete cascade,
  token text not null unique default (gen_random_uuid()::text || gen_random_uuid()::text),
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked boolean not null default false
);
create table public.sm_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sm_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  worker_id text not null,
  request_date date not null,
  kind text not null check (kind in ('constraint', 'holiday')),
  reason text not null default '' check (length(reason) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decision_note text not null default '' check (length(decision_note) <= 2000),
  decided_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index sm_active_request on public.sm_requests(workspace_id, user_id, request_date)
  where status in ('pending', 'approved');
create index sm_requests_week on public.sm_requests(workspace_id, request_date);
create index sm_members_user on public.sm_members(user_id);

create function public.sm_role(p_workspace uuid) returns text
language sql stable security definer set search_path = ''
as $$ select role from public.sm_members where workspace_id = p_workspace and user_id = auth.uid() $$;

alter table public.sm_workspaces enable row level security;
alter table public.sm_members enable row level security;
alter table public.sm_invites enable row level security;
alter table public.sm_requests enable row level security;
create policy workspace_read on public.sm_workspaces for select to authenticated
  using (public.sm_role(id) is not null);
create policy member_read on public.sm_members for select to authenticated
  using (user_id = auth.uid() or public.sm_role(workspace_id) = 'manager');
create policy invite_read on public.sm_invites for select to authenticated
  using (public.sm_role(workspace_id) = 'manager');
create policy request_read on public.sm_requests for select to authenticated
  using (public.sm_role(workspace_id) = 'manager' or
    (user_id = auth.uid() and public.sm_role(workspace_id) is not null));
revoke all on public.sm_workspaces, public.sm_members, public.sm_invites, public.sm_requests from anon, authenticated;
grant select on public.sm_workspaces, public.sm_members, public.sm_invites, public.sm_requests to authenticated;

create function shift_private.validate_data(p_data jsonb) returns void
language plpgsql set search_path = '' as $$
declare item jsonb; slot record; week record;
begin
  if jsonb_typeof(p_data) is distinct from 'object'
    or jsonb_typeof(p_data->'workers') is distinct from 'array'
    or jsonb_typeof(p_data->'shifts') is distinct from 'array'
    or jsonb_typeof(p_data->'assignments') is distinct from 'object'
    or jsonb_typeof(p_data->'lockedSlots') is distinct from 'object'
    or jsonb_typeof(p_data->'dailyStatuses') is distinct from 'object'
    or jsonb_typeof(p_data->'customStatuses') is distinct from 'array' then
    raise exception 'INVALID_SCHEDULE';
  end if;
  for item in select value from jsonb_array_elements(p_data->'workers') loop
    if jsonb_typeof(item->'id') is distinct from 'string' or length(item->>'id') = 0
      or jsonb_typeof(item->'name') is distinct from 'string' then raise exception 'INVALID_WORKER'; end if;
  end loop;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_data->'workers')) then
    raise exception 'DUPLICATE_WORKER';
  end if;
  for item in select value from jsonb_array_elements(p_data->'shifts') loop
    if jsonb_typeof(item->'id') is distinct from 'string' or length(item->>'id') = 0
      or coalesce(item->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(item->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'INVALID_SHIFT';
    end if;
    if item ? 'grouping' and item->'grouping' <> 'null'::jsonb then
      if coalesce(item->'grouping'->>'startDay', '') !~ '^[0-6]$'
        or coalesce(item->'grouping'->>'endDay', '') !~ '^[0-6]$' then raise exception 'INVALID_GROUPING'; end if;
    end if;
  end loop;
  for week in select * from jsonb_each(p_data->'assignments') loop
    if week.key !~ '^\d{4}-\d{2}-\d{2}$' or extract(dow from week.key::date) <> 0
      or jsonb_typeof(week.value) <> 'object' then raise exception 'INVALID_WEEK'; end if;
    for slot in select * from jsonb_each(week.value) loop
      if slot.key !~ '^[0-6]:' or jsonb_typeof(slot.value) <> 'array' then raise exception 'INVALID_ASSIGNMENT'; end if;
      if not exists (select 1 from jsonb_array_elements(p_data->'shifts') s where s->>'id' = substring(slot.key from 3)) then
        raise exception 'UNKNOWN_SHIFT';
      end if;
    end loop;
  end loop;
end $$;

-- Match the scheduler's end-exclusive, timezone-independent calendar coverage,
-- including ordinary overnight shifts and groups spanning into another week.
create function shift_private.has_assignment(p_data jsonb, p_worker text, p_date date) returns boolean
language plpgsql stable set search_path = '' as $$
declare week record; slot record; s jsonb; first_day integer; span integer;
  start_time time; end_time time; starts timestamp; ends timestamp;
begin
  for week in select * from jsonb_each(p_data->'assignments') loop
    for slot in select * from jsonb_each(week.value) loop
      if not (slot.value ? p_worker) then continue; end if;
      select value into s from jsonb_array_elements(p_data->'shifts') where value->>'id' = substring(slot.key from 3);
      if s is null then raise exception 'UNKNOWN_SHIFT'; end if;
      first_day := left(slot.key, 1)::integer;
      start_time := (s->>'start')::time;
      end_time := (s->>'end')::time;
      if s ? 'grouping' and s->'grouping' <> 'null'::jsonb then
        span := ((s->'grouping'->>'endDay')::integer - (s->'grouping'->>'startDay')::integer + 7) % 7;
        if span = 0 and end_time <= start_time then span := 7; end if;
      else
        span := case when end_time <= start_time then 1 else 0 end;
      end if;
      starts := (week.key::date + first_day) + start_time;
      ends := (week.key::date + first_day + span) + end_time;
      if starts < p_date + interval '1 day' and ends > p_date::timestamp then return true; end if;
    end loop;
  end loop;
  return false;
end $$;

create function public.sm_create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  insert into public.sm_workspaces(name) values (btrim(p_name)) returning id into result;
  insert into public.sm_members(workspace_id, user_id, display_name, email, role)
    values (result, auth.uid(), coalesce(nullif(auth.jwt()->'user_metadata'->>'display_name', ''), auth.jwt()->>'email'),
      auth.jwt()->>'email', 'manager');
  return result;
end $$;

create function public.sm_create_invite(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.sm_invites;
begin
  perform 1 from public.sm_workspaces where id = p_workspace for update;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  insert into public.sm_invites(workspace_id) values (p_workspace) returning * into result;
  return to_jsonb(result);
end $$;

create function public.sm_revoke_invite(p_workspace uuid, p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.sm_workspaces where id = p_workspace for update;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  update public.sm_invites set revoked = true where workspace_id = p_workspace and id = p_invite;
end $$;

create function public.sm_join_workspace(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare invitation public.sm_invites;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  select * into invitation from public.sm_invites where token = p_token;
  if not found then raise exception 'INVALID_INVITE'; end if;
  perform 1 from public.sm_workspaces where id = invitation.workspace_id for update;
  select * into invitation from public.sm_invites where token = p_token;
  if invitation.revoked or invitation.expires_at <= now() then raise exception 'INVALID_INVITE'; end if;
  insert into public.sm_members(workspace_id, user_id, display_name, email)
    values (invitation.workspace_id, auth.uid(),
      coalesce(nullif(auth.jwt()->'user_metadata'->>'display_name', ''), auth.jwt()->>'email'), auth.jwt()->>'email')
    on conflict (workspace_id, user_id) do nothing;
  return invitation.workspace_id;
end $$;

create function public.sm_update_member(p_workspace uuid, p_user uuid, p_role text, p_worker text) returns void
language plpgsql security definer set search_path = '' as $$
declare current_data jsonb;
begin
  select data into current_data from public.sm_workspaces where id = p_workspace for update;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  if p_role not in ('manager', 'member') or p_role is null then raise exception 'INVALID_ROLE'; end if;
  if p_worker is not null and not exists
    (select 1 from jsonb_array_elements(current_data->'workers') w where w->>'id' = p_worker) then raise exception 'UNKNOWN_WORKER'; end if;
  if p_role <> 'manager' and exists (
    select 1 from public.sm_members where workspace_id = p_workspace and user_id = p_user and role = 'manager'
  ) and (select count(*) from public.sm_members where workspace_id = p_workspace and role = 'manager') <= 1 then
    raise exception 'LAST_MANAGER';
  end if;
  update public.sm_members set role = p_role, worker_id = p_worker where workspace_id = p_workspace and user_id = p_user;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
end $$;

create function public.sm_save_workspace(p_workspace uuid, p_revision bigint, p_data jsonb) returns jsonb
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
  end loop;
  update public.sm_workspaces set data = p_data, revision = revision + 1 where id = p_workspace returning * into result;
  update public.sm_members m set worker_id = null where m.workspace_id = p_workspace and m.worker_id is not null
    and not exists (select 1 from jsonb_array_elements(p_data->'workers') w where w->>'id' = m.worker_id);
  return to_jsonb(result);
end $$;

create function public.sm_submit_request(p_workspace uuid, p_date date, p_kind text, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare worker text; result uuid; current_data jsonb;
begin
  select data into current_data from public.sm_workspaces where id = p_workspace for update;
  select worker_id into worker from public.sm_members where workspace_id = p_workspace and user_id = auth.uid();
  if worker is null then raise exception 'WORKER_LINK_REQUIRED'; end if;
  if not exists (select 1 from jsonb_array_elements(current_data->'workers') w where w->>'id' = worker) then raise exception 'UNKNOWN_WORKER'; end if;
  insert into public.sm_requests(workspace_id, user_id, worker_id, request_date, kind, reason)
    values (p_workspace, auth.uid(), worker, p_date, p_kind, btrim(p_reason)) returning id into result;
  return result;
end $$;

create function public.sm_decide_request(p_request uuid, p_decision text, p_note text, p_revision bigint) returns void
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
    if shift_private.has_assignment(workspace.data, request.worker_id, request.request_date) then
      raise exception 'REQUEST_SHIFT_CONFLICT';
    end if;
    if workspace.data->'dailyStatuses'->request.request_date::text->request.worker_id is not null then
      raise exception 'REQUEST_STATUS_CONFLICT';
    end if;
    cell := jsonb_build_object('label', case request.kind when 'holiday' then 'חג' else 'אילוץ' end,
      'color', case request.kind when 'holiday' then '#ffd9df' else '#ff9999' end,
      'blocksShifts', true, 'note', 'בקשה מאושרת');
    statuses := workspace.data->'dailyStatuses';
    statuses := jsonb_set(statuses, array[request.request_date::text],
      coalesce(statuses->request.request_date::text, '{}'::jsonb) || jsonb_build_object(request.worker_id, cell));
    update public.sm_workspaces set data = jsonb_set(data, '{dailyStatuses}', statuses),
      revision = revision + 1 where id = workspace.id;
  end if;
  update public.sm_requests set status = p_decision, decision_note = btrim(p_note),
    decided_by = auth.uid(), decided_at = now() where id = p_request;
end $$;

revoke all on function public.sm_role(uuid), public.sm_create_workspace(text),
  public.sm_create_invite(uuid), public.sm_revoke_invite(uuid, uuid), public.sm_join_workspace(text),
  public.sm_update_member(uuid, uuid, text, text), public.sm_save_workspace(uuid, bigint, jsonb),
  public.sm_submit_request(uuid, date, text, text), public.sm_decide_request(uuid, text, text, bigint)
  from public, anon;
grant execute on function public.sm_role(uuid), public.sm_create_workspace(text),
  public.sm_create_invite(uuid), public.sm_revoke_invite(uuid, uuid), public.sm_join_workspace(text),
  public.sm_update_member(uuid, uuid, text, text), public.sm_save_workspace(uuid, bigint, jsonb),
  public.sm_submit_request(uuid, date, text, text), public.sm_decide_request(uuid, text, text, bigint)
  to authenticated;

notify pgrst, 'reload schema';
