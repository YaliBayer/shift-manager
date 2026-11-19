import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { assignmentConflict, coveredDates, createOccurrence, generateWeek } from '../src/scheduling.ts'
import { parseScheduleData } from '../src/schedule-data.ts'

const manager = '00000000-0000-4000-8000-000000000001'
const employee = '00000000-0000-4000-8000-000000000002'
const outsider = '00000000-0000-4000-8000-000000000003'
const week = '2026-11-15'
const worker = { id: 'a', name: 'Alpha', role: '', phone: '', maxShifts: 5, preferredDays: [], excludedDays: [] }
const shift = { id: 'night', name: 'Night', start: '20:00', end: '09:00', activeDays: [0], requiredWorkers: 1 }
const grouped = { ...shift, id: 'group', name: 'Weekend', start: '18:00', end: '09:00', activeDays: [4], grouping: { startDay: 4, endDay: 0 } }
const initial = {
  workers: [worker, { ...worker, id: 'b', name: 'Beta' }], shifts: [shift, grouped],
  assignments: { [week]: { '0:night': ['a'], '4:group': ['a'] } },
  lockedSlots: { [week]: ['0:night', '4:group'] }, dailyStatuses: {}, customStatuses: [],
}

test('workspace RPCs enforce identity, roles, invitations, concurrency and approved requests in PostgreSQL', { timeout: 120000 }, async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
      $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select nullif(current_setting('request.jwt.claims', true), '')::jsonb
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
      insert into auth.users values ('${manager}'), ('${employee}'), ('${outsider}');
    `)
    for (const name of ['202611190001_workspaces.sql', '202611190002_constraint_privacy.sql']) {
      const migration = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
      try { await db.exec(migration) } catch (error) {
        const line = migration.slice(0, Number(error.position)).split('\n').length
        throw new Error(`${name} line ${line}: ${error.message}; ${error.where ?? ''}`, { cause: error })
      }
    }
    async function login(id) {
      await db.exec('reset role')
      await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({
        sub: id, email: `${id.slice(-1)}@example.test`, user_metadata: { display_name: `Test ${id.slice(-1)}`, role: 'manager' },
      })])
      await db.exec('set role authenticated')
    }
    async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0].result }
    async function state() { return scalar('select public.sm_get_workspace($1) as result', [workspace]) }
    async function save(data, revision) {
      const current = revision ?? (await state()).revision
      return scalar('select public.sm_save_workspace($1,$2,$3) as result', [workspace, current, data])
    }
    async function submit(date, kind = 'constraint') {
      await login(employee)
      return scalar('select public.sm_submit_request($1,$2,$3,$4) as result', [workspace, date, kind, 'Requested'])
    }
    async function decide(id, decision, revision) {
      await login(manager)
      return scalar('select public.sm_decide_request($1,$2,$3,$4) as result', [id, decision, 'Reviewed', revision ?? (await state()).revision])
    }
    await login(manager)
    const workspace = await scalar("select public.sm_create_workspace('Team') as result")
    let invitation
    await t.test('creator becomes manager, outsiders cannot read workspace data', async () => {
      assert.equal(await scalar('select public.sm_role($1) as result', [workspace]), 'manager')
      await save(initial)
      await login(outsider)
      assert.equal((await db.query('select id,name from public.sm_workspaces where id = $1', [workspace])).rows.length, 0)
      await assert.rejects(() => state(), /MEMBERSHIP_REQUIRED/)
      assert.equal((await db.query('select * from public.sm_members where workspace_id = $1', [workspace])).rows.length, 0)
      await assert.rejects(() => scalar('select public.sm_create_invite($1) as result', [workspace]), /MANAGER_REQUIRED/)
      await assert.rejects(() => scalar('select public.sm_join_workspace($1) as result', ['invented']), /INVALID_INVITE/)
    })
    await t.test('invitation joins only as a member despite user metadata, cannot elevate or directly write', async () => {
      await login(manager)
      invitation = await scalar('select public.sm_create_invite($1) as result', [workspace])
      await login(employee)
      assert.equal(await scalar('select public.sm_join_workspace($1) as result', [invitation.token]), workspace)
      assert.equal(await scalar('select public.sm_join_workspace($1) as result', [invitation.token]), workspace)
      assert.equal(await scalar('select public.sm_role($1) as result', [workspace]), 'member')
      assert.deepEqual((await state()).data, initial)
      await assert.rejects(() => db.query('select data from public.sm_workspaces where id = $1', [workspace]), /permission denied/)
      await assert.rejects(() => db.query('select to_jsonb(w) from public.sm_workspaces w where id = $1', [workspace]), /permission denied/)
      await assert.rejects(() => save(initial, 1), /MANAGER_REQUIRED/)
      await assert.rejects(() => db.query("update public.sm_workspaces set revision = 99 where id = $1", [workspace]), /permission denied/)
      await assert.rejects(() => db.query("insert into public.sm_requests(workspace_id,user_id,worker_id,request_date,kind,status) values($1,$2,'b','2026-11-16','holiday','approved')", [workspace, employee]), /permission denied/)
      await assert.rejects(() => scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, employee, 'manager', 'b']), /MANAGER_REQUIRED/)
      assert.equal((await db.query('select * from public.sm_invites')).rows.length, 0)
      assert.equal((await db.query('select * from public.sm_members')).rows.length, 1)
    })
    await t.test('manager links accounts, cannot remove last manager or link two accounts to one worker', async () => {
      await assert.rejects(() => submit('2026-11-16'), /WORKER_LINK_REQUIRED/)
      await login(manager)
      await scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, employee, 'member', 'a'])
      await assert.rejects(() => scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, manager, 'member', null]), /LAST_MANAGER/)
      await assert.rejects(() => scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, manager, 'manager', 'a']), /duplicate key/)
    })
    let monday, sunday
    await t.test('requests use the signed-in linked worker and cannot be self-approved or duplicated', async () => {
      monday = await submit('2026-11-16')
      sunday = await submit('2026-11-22', 'holiday')
      const requests = (await db.query('select * from public.sm_requests')).rows
      assert.ok(requests.every((request) => request.worker_id === 'a' && request.user_id === employee && request.status === 'pending'))
      await assert.rejects(() => submit('2026-11-16', 'holiday'), /duplicate key/)
      await assert.rejects(() => scalar("select public.sm_decide_request($1,'approved','',1) as result", [monday]), /MANAGER_REQUIRED/)
      await login(outsider)
      assert.equal((await db.query('select * from public.sm_requests')).rows.length, 0)
      await login(manager)
      assert.deepEqual((await state()).data, initial)
    })
    await t.test('approval checks overnight and previous-week group coverage and leaves locks untouched', async () => {
      await assert.rejects(() => decide(monday, 'approved'), /REQUEST_SHIFT_CONFLICT/)
      await assert.rejects(() => decide(sunday, 'approved'), /REQUEST_SHIFT_CONFLICT/)
      assert.deepEqual((await state()).data, initial)
      const changed = structuredClone(initial)
      changed.assignments[week]['0:night'] = []
      changed.assignments[week]['4:group'] = []
      await save(changed)
      await decide(monday, 'approved')
      const after = await state()
      assert.equal(after.data.dailyStatuses['2026-11-16'].a.label, 'אילוץ')
      assert.equal(after.data.dailyStatuses['2026-11-16'].a.blocksShifts, true)
      assert.equal(after.data.dailyStatuses['2026-11-16'].a.note, 'בקשה מאושרת')
      assert.equal(after.data.dailyStatuses['2026-11-16'].a.requestId, monday)
      assert.ok(!JSON.stringify(after.data).includes('Requested'))
      assert.deepEqual(after.data.lockedSlots, initial.lockedSlots)
      await decide(sunday, 'denied')
      assert.equal((await state()).data.dailyStatuses['2026-11-22'], undefined)
      await assert.rejects(() => decide(monday, 'denied'), /REQUEST_ALREADY_DECIDED/)
    })
    await t.test('approved dates block generation and manual assignment, cannot be removed by a forged save', async () => {
      const saved = await state()
      const parsed = parseScheduleData(saved.data)
      const night = { ...shift, activeDays: [1] }
      assert.equal(assignmentConflict(worker, createOccurrence(week, 1, night), [night], {}, parsed.dailyStatuses), 'daily-status')
      assert.deepEqual(generateWeek(week, [worker], [night], {}, {}, parsed.dailyStatuses)['1:night'], [])
      const changed = structuredClone(saved.data)
      changed.dailyStatuses = {}
      await assert.rejects(() => save(changed), /APPROVED_REQUEST_PROTECTED/)
      changed.dailyStatuses = saved.data.dailyStatuses
      changed.assignments[week]['0:night'] = ['a']
      await assert.rejects(() => save(changed), /REQUEST_SHIFT_CONFLICT/)
      assert.deepEqual((await state()).data, saved.data)
    })
    await t.test('concurrent manager saves and stale request decisions fail without overwriting', async () => {
      const saved = await state()
      const changed = structuredClone(saved.data)
      changed.workers[0].name = 'Updated'
      await save(changed, saved.revision)
      await assert.rejects(() => save(saved.data, saved.revision), /STALE_REVISION/)
      await assert.rejects(() => scalar('select public.sm_save_workspace($1,null,$2) as result', [workspace, saved.data]), /STALE_REVISION/)
      const request = await submit('2026-11-18')
      await assert.rejects(() => decide(request, 'approved', saved.revision), /STALE_REVISION/)
      assert.equal((await state()).data.workers[0].name, 'Updated')
      await decide(request, 'approved')
    })
    await t.test('existing date statuses are never overwritten by approval', async () => {
      const request = await submit('2026-11-19')
      await login(manager)
      const saved = await state()
      saved.data.dailyStatuses['2026-11-19'] = { a: { label: 'Office', color: '#123456', note: 'Keep', blocksShifts: false } }
      await save(saved.data)
      await assert.rejects(() => decide(request, 'approved'), /REQUEST_STATUS_CONFLICT/)
      assert.equal((await state()).data.dailyStatuses['2026-11-19'].a.note, 'Keep')
      await decide(request, 'denied')
    })
    await t.test('revoked and expired links reject new members; anonymous callers have no data or RPC access', async () => {
      await login(manager)
      await scalar('select public.sm_revoke_invite($1,$2) as result', [workspace, invitation.id])
      await login(outsider)
      await assert.rejects(() => scalar('select public.sm_join_workspace($1) as result', [invitation.token]), /INVALID_INVITE/)
      await login(manager)
      const expired = await scalar('select public.sm_create_invite($1) as result', [workspace])
      await db.exec('reset role')
      await db.query("update public.sm_invites set expires_at = now() - interval '1 minute' where id = $1", [expired.id])
      await login(outsider)
      await assert.rejects(() => scalar('select public.sm_join_workspace($1) as result', [expired.token]), /INVALID_INVITE/)
      await db.exec('reset role; set role anon')
      await assert.rejects(() => db.query('select * from public.sm_workspaces'), /permission denied/)
      await assert.rejects(() => scalar("select public.sm_create_workspace('Anonymous') as result"), /permission denied/)
      await assert.rejects(() => state(), /permission denied/)
      await assert.rejects(() => scalar('select public.sm_revoke_request_approval($1,$2) as result', [monday, 0]), /permission denied/)
    })
    await t.test('database conflict coverage matches the scheduler for midnight and multi-day boundaries', async () => {
      await db.exec('reset role')
      for (const [day, template] of [
        [0, shift], [6, { ...shift, end: '00:00' }], [4, grouped], [4, { ...grouped, end: '00:00' }],
        [0, { ...shift, start: '09:00', end: '09:00' }],
        [0, { ...grouped, grouping: { startDay: 0, endDay: 0 }, start: '09:00', end: '09:00' }],
      ]) {
        const occurrence = createOccurrence(week, day, template)
        const covered = coveredDates(occurrence)
        const schedule = { ...initial, shifts: [template], assignments: { [week]: { [occurrence.key]: ['a'] } } }
        for (let offset = 0; offset < 9; offset++) {
          const date = new Date(`${week}T12:00:00Z`)
          date.setUTCDate(date.getUTCDate() + offset)
          const key = date.toISOString().slice(0, 10)
          assert.equal(await scalar('select shift_private.has_assignment($1,$2,$3) as result', [schedule, 'a', key]),
            covered.includes(key), `${template.id}: ${template.start}-${template.end}, ${key}`)
          assert.equal(await scalar('select shift_private.has_assignment($1,$2,$3) as result', [schedule, 'b', key]), false)
        }
      }
    })
    await t.test('constraints and requests are private to the requester and managers, including raw JSON access', async () => {
      await login(manager)
      const invite = await scalar('select public.sm_create_invite($1) as result', [workspace])
      await login(outsider)
      await scalar('select public.sm_join_workspace($1) as result', [invite.token])
      await login(manager)
      await scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, outsider, 'member', 'b'])
      const before = await state()
      before.data.workers[0].excludedDays = [5]
      before.data.workers[1].excludedDays = [6]
      before.data.dailyStatuses['2026-11-20'] = {
        a: { label: 'אילוץ', color: '#ff9999', blocksShifts: true, note: 'Private manual note' },
        b: { label: 'חג', color: '#ffd9df', blocksShifts: true, note: '' },
      }
      await save(before.data)
      assert.ok((await state()).data.dailyStatuses['2026-11-16'].a)
      await login(employee)
      const own = await state()
      assert.ok(own.data.dailyStatuses['2026-11-16'].a)
      assert.deepEqual(own.data.workers[0].excludedDays, [5])
      assert.deepEqual(own.data.workers[1].excludedDays, [])
      assert.ok((await db.query('select id from public.sm_requests where id = $1', [monday])).rows.length)
      await login(outsider)
      const other = await state()
      assert.equal(other.data.dailyStatuses['2026-11-16'], undefined)
      assert.equal(other.data.dailyStatuses['2026-11-20'].a, undefined)
      assert.ok(other.data.dailyStatuses['2026-11-20'].b)
      assert.deepEqual(other.data.workers[0].excludedDays, [])
      assert.deepEqual(other.data.workers[1].excludedDays, [6])
      assert.deepEqual(other.data.assignments, before.data.assignments)
      assert.equal((await db.query('select * from public.sm_requests')).rows.length, 0)
      await assert.rejects(() => db.query("select data->'dailyStatuses' from public.sm_workspaces"), /permission denied/)
      assert.equal((await db.query('select id,name,revision,created_at from public.sm_workspaces')).rows.length, 1)
      assert.ok(!JSON.stringify(other).includes('Private manual note'))
      // Changing account-to-worker links must not transfer ownership of requests.
      await login(manager)
      await scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, employee, 'member', null])
      await scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, outsider, 'member', 'a'])
      await login(outsider)
      assert.equal((await state()).data.dailyStatuses['2026-11-16'], undefined)
      await login(employee)
      assert.ok((await state()).data.dailyStatuses['2026-11-16'].a)
      await login(manager)
      await scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, outsider, 'member', 'b'])
      await scalar('select public.sm_update_member($1,$2,$3,$4) as result', [workspace, employee, 'member', 'a'])
    })
    await t.test('cancelling approval is manager-only, versioned, preserves shifts and returns to pending', async () => {
      await login(employee)
      const ownRevision = (await state()).revision
      await assert.rejects(() => scalar('select public.sm_revoke_request_approval($1,$2) as result', [monday, ownRevision]), /MANAGER_REQUIRED/)
      await login(manager)
      const before = await state()
      await assert.rejects(() => scalar('select public.sm_revoke_request_approval($1,$2) as result', [monday, before.revision - 1]), /STALE_REVISION/)
      await scalar('select public.sm_revoke_request_approval($1,$2) as result', [monday, before.revision])
      const after = await state()
      assert.equal(after.revision, before.revision + 1)
      assert.equal(after.data.dailyStatuses['2026-11-16'], undefined)
      assert.deepEqual(after.data.assignments, before.data.assignments)
      assert.deepEqual(after.data.lockedSlots, before.data.lockedSlots)
      assert.deepEqual(after.data.dailyStatuses['2026-11-20'], before.data.dailyStatuses['2026-11-20'])
      const request = (await db.query('select * from public.sm_requests where id = $1', [monday])).rows[0]
      assert.equal(request.status, 'pending')
      assert.equal(request.decided_by, null)
      assert.equal(request.decided_at, null)
      const target = createOccurrence(week, 0, shift)
      assert.equal(assignmentConflict(worker, target, [shift], {}, before.data.dailyStatuses), 'daily-status')
      assert.equal(assignmentConflict(worker, target, [shift], {}, after.data.dailyStatuses), null)
      await assert.rejects(() => scalar('select public.sm_revoke_request_approval($1,$2) as result', [monday, after.revision]), /REQUEST_NOT_APPROVED_CONSTRAINT/)
      await decide(monday, 'approved')
      assert.equal((await state()).data.dailyStatuses['2026-11-16'].a.requestId, monday)
    })
    await t.test('upgrade backfills legacy approvals and cancellation never removes an unrelated cell', async () => {
      await db.exec('reset role')
      await db.query("update public.sm_workspaces set data = data #- array['dailyStatuses','2026-11-16','a','requestId'] where id = $1", [workspace])
      await db.exec(await readFile(new URL('../supabase/migrations/202611190002_constraint_privacy.sql', import.meta.url), 'utf8'))
      await login(manager)
      assert.equal((await state()).data.dailyStatuses['2026-11-16'].a.requestId, monday)
      const data = (await state()).data
      data.dailyStatuses['2026-11-16'].a = { label: 'Office', color: '#123456', note: 'Keep', blocksShifts: false }
      await db.exec('reset role')
      await db.query('update public.sm_workspaces set data = $1 where id = $2', [data, workspace])
      await login(manager)
      const revision = (await state()).revision
      await assert.rejects(() => scalar('select public.sm_revoke_request_approval($1,$2) as result', [monday, revision]), /REQUEST_STATUS_CHANGED/)
      assert.equal((await state()).data.dailyStatuses['2026-11-16'].a.note, 'Keep')
      assert.equal((await db.query('select status from public.sm_requests where id = $1', [monday])).rows[0].status, 'approved')
    })
  } finally { await db.close() }
})

test('old backups normalize while malformed shared schedule data is rejected', () => {
  const legacy = { workers: [worker], shifts: [shift], assignments: { [week]: { '0:night': ['a'] } } }
  const parsed = parseScheduleData(legacy)
  assert.deepEqual(parsed.lockedSlots, { [week]: ['0:night'] })
  assert.deepEqual(parsed.dailyStatuses, {})
  assert.deepEqual(parsed.customStatuses, [])
  for (const invalid of [null, {}, { ...initial, workers: [null] }, { ...initial, shifts: [{ ...shift, start: 'oops' }] },
    { ...initial, assignments: { '2026-02-30': {} } }, { ...initial, dailyStatuses: null }, { ...initial, lockedSlots: { [week]: [5] } }]) {
    assert.throws(() => parseScheduleData(invalid))
  }
})
