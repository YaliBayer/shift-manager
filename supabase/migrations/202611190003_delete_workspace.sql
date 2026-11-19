-- Run after 202611190002_constraint_privacy.sql.
begin;

create function public.sm_delete_workspace(p_workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.sm_workspaces where id = p_workspace for update;
  if not found then raise exception 'WORKSPACE_NOT_FOUND'; end if;
  if public.sm_role(p_workspace) is distinct from 'manager' then raise exception 'MANAGER_REQUIRED'; end if;
  delete from public.sm_workspaces where id = p_workspace;
end $$;

revoke all on function public.sm_delete_workspace(uuid) from public, anon;
grant execute on function public.sm_delete_workspace(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
