import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_STATUSES, customStatusError, isCustomStatuses, isDailyStatuses, migrateDailyStatuses, updateDailyStatus, updateDailyStatusRange } from '../src/daily-status.ts'
import { isShiftStatusConfiguration, shiftAppearance } from '../src/shift-status.ts'
import {
  assignmentConflict, createOccurrence, coveredDates, generateWeek,
  protectedAssignmentProblems, workerRestOnDate,
  isVisibleInWorkerCell, isVisibleOnDay, occursOnDay,
} from '../src/scheduling.ts'

const week = '2026-11-15'
const nextWeek = '2026-11-22'
const worker = { id: 'a', name: 'A', role: '', phone: '', maxShifts: 5, excludedDays: [], preferredDays: [] }
const shift = { id: 'day', name: 'Day', start: '09:00', end: '17:00', activeDays: [0, 1], requiredWorkers: 1 }
const leave = { label: 'Leave', color: '#ad86f5', blocksShifts: true, note: 'Away' }
const weekend = { ...shift, id: 'weekend', start: '18:00', end: '09:00', activeDays: [4], grouping: { startDay: 4, endDay: 0 } }

test('status ranges include both endpoints across weeks and years, preserving other cells', () => {
  const original = { '2026-12-31': { b: leave }, '2027-01-03': { a: leave } }
  const before = structuredClone(original)
  const result = updateDailyStatusRange(original, '2026-12-31', '2027-01-02', 'a', leave, () => null)
  assert.equal(result.error, null)
  for (const date of ['2026-12-31', '2027-01-01', '2027-01-02']) assert.deepEqual(result.statuses[date].a, leave)
  assert.deepEqual(result.statuses['2026-12-31'].b, leave)
  assert.deepEqual(result.statuses['2027-01-03'], original['2027-01-03'])
  assert.deepEqual(original, before)
  assert.ok(isDailyStatuses(JSON.parse(JSON.stringify(result.statuses))))
  const single = updateDailyStatusRange({}, week, week, 'a', leave, () => null)
  assert.deepEqual(single.statuses, { [week]: { a: leave } })
})

test('invalid status ranges and protected later dates reject the entire change', () => {
  for (const end of ['', '2026-11-14', '2026-02-30', 'not-a-date']) {
    assert.ok(updateDailyStatusRange({}, week, end, 'a', leave, () => null).error)
  }
  const original = { [nextWeek]: { a: { ...leave, requestId: 'approved-request' } } }
  const before = structuredClone(original)
  const result = updateDailyStatusRange(original, week, nextWeek, 'a', leave, () => null)
  assert.match(result.error, /2026-11-22/)
  assert.equal('statuses' in result, false)
  assert.deepEqual(original, before)
})

test('range validation checks the final day for an incoming grouped shift before saving', () => {
  const occurrence = createOccurrence(week, 4, weekend)
  const original = { [week]: { b: leave } }
  const result = updateDailyStatusRange(original, '2026-11-18', '2026-11-19', 'a', leave,
    (date) => coveredDates(occurrence).includes(date) ? 'Shift conflict' : null)
  assert.match(result.error, /2026-11-19: Shift conflict/)
  assert.equal('statuses' in result, false)
  assert.deepEqual(original, { [week]: { b: leave } })
})

test('daily blocking is date- and worker-specific for both manual and automatic assignment', () => {
  const statuses = { [week]: { a: leave } }
  const target = createOccurrence(week, 0, shift)
  assert.equal(assignmentConflict(worker, target, [shift], {}, statuses), 'daily-status')
  assert.equal(assignmentConflict({ ...worker, id: 'b' }, target, [shift], {}, statuses), null)
  const generated = generateWeek(week, [worker], [shift], {}, {}, statuses)
  assert.deepEqual(generated['0:day'], [])
  assert.deepEqual(generated['1:day'], ['a'])
  assert.deepEqual(generateWeek(nextWeek, [worker], [shift], {}, {}, statuses)['0:day'], ['a'])
})

test('a visual status never blocks or counts as an assigned shift', () => {
  const statuses = { [week]: { a: { ...leave, label: 'Office', blocksShifts: false } } }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 0, shift), [shift], {}, statuses), null)
  assert.deepEqual(generateWeek(week, [worker], [shift], {}, {}, statuses)['0:day'], ['a'])
  assert.deepEqual(generateWeek(week, [worker], [], {}, {}, statuses), {})
})

test('overnight and grouped shifts check every covered date, including the next week', () => {
  const night = { ...shift, start: '17:00', end: '09:00' }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 0, night), [night], {},
    { '2026-11-16': { a: leave } }), 'daily-status')
  const grouped = createOccurrence(week, 4, weekend)
  assert.deepEqual(coveredDates(grouped), ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'])
  const statuses = { [nextWeek]: { a: leave } }
  assert.equal(assignmentConflict(worker, grouped, [weekend], {}, statuses), 'daily-status')
  assert.deepEqual(generateWeek(week, [worker], [weekend], {}, {}, statuses)['4:weekend'], [])
  const midnight = { ...weekend, end: '00:00' }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 4, midnight), [midnight], {}, statuses), null)
})

test('blocking statuses cannot silently replace protected assignments', () => {
  const assignments = { [week]: { '0:day': ['a'] } }
  const locks = { [week]: ['0:day'] }
  const statuses = { [week]: { a: leave } }
  assert.deepEqual(protectedAssignmentProblems(week, [worker], [shift], assignments, locks, statuses), ['0:day'])
  assert.throws(() => generateWeek(week, [worker], [shift], assignments, locks, statuses), /Invalid protected/)
  assert.deepEqual(assignments[week]['0:day'], ['a'])
})

test('derived rest follows assigned nights and groups across weeks and disappears after removal', () => {
  const assignments = { [week]: { '4:weekend': ['a'] } }
  assert.equal(workerRestOnDate('a', nextWeek, [weekend], assignments).length, 1)
  assert.equal(workerRestOnDate('b', nextWeek, [weekend], assignments).length, 0)
  assert.equal(workerRestOnDate('a', '2026-11-23', [weekend], assignments).length, 0)
  assert.equal(workerRestOnDate('a', nextWeek, [weekend], {}).length, 0)
  const night = { ...shift, id: 'night', start: '20:00', end: '00:00', activeDays: [6] }
  assert.equal(workerRestOnDate('a', nextWeek, [night], { [week]: { '6:night': ['a'] } }).length, 1)
})

test('Sunday worker cells hide only the ending Saturday continuation without changing its coverage or rest', () => {
  const occurrence = createOccurrence(week, 4, weekend)
  const assignments = { [week]: { [occurrence.key]: ['a'] } }
  assert.equal(isVisibleInWorkerCell(occurrence, nextWeek, 0), false)
  assert.equal(isVisibleInWorkerCell(occurrence, week, 6), true)
  assert.equal(isVisibleOnDay(occurrence, nextWeek, 0), true)
  assert.equal(occursOnDay(occurrence, nextWeek, 0), true)
  assert.equal(workerRestOnDate('a', nextWeek, [weekend], assignments).length, 1)
  const mondayEnd = createOccurrence(week, 4, { ...weekend, grouping: { startDay: 4, endDay: 1 } })
  assert.equal(isVisibleInWorkerCell(mondayEnd, nextWeek, 0), true)
  const newSundayShift = createOccurrence(nextWeek, 0, { ...weekend, grouping: { startDay: 0, endDay: 0 } })
  assert.equal(isVisibleInWorkerCell(newSundayShift, nextWeek, 0), true)
  assert.equal(isVisibleInWorkerCell(createOccurrence(nextWeek, 0, shift), nextWeek, 0), true)
})

test('cell edits and clearing preserve other workers and dates and backup fields round trip', () => {
  const original = { [week]: { a: leave, b: leave }, [nextWeek]: { a: leave } }
  const edited = updateDailyStatus(original, week, 'a', { ...leave, color: '#123456', note: 'Changed' })
  assert.equal(original[week].a.note, 'Away')
  assert.equal(edited[week].b.note, 'Away')
  const cleared = updateDailyStatus(edited, week, 'a', null)
  assert.equal(cleared[week].a, undefined)
  assert.ok(cleared[week].b)
  assert.deepEqual(updateDailyStatus(cleared, week, 'b', null), { [nextWeek]: { a: leave } })
  const restored = JSON.parse(JSON.stringify(edited))
  assert.ok(isDailyStatuses(restored))
  assert.deepEqual(restored, edited)
})

test('backup validation rejects malformed dates and invalid cell configuration', () => {
  assert.ok(isDailyStatuses({}))
  for (const invalid of [
    null, [], { '2026-02-30': { a: leave } },
    { [week]: { a: { ...leave, blocksShifts: 'false' } } },
    { [week]: { a: { ...leave, color: 'red' } } },
    { [week]: { a: { ...leave, label: ' ' } } },
  ]) assert.equal(isDailyStatuses(invalid), false)
})

test('assigned shifts resolve built-in and custom display statuses while legacy shifts keep their appearance', () => {
  const custom = { ...leave, id: 'training', label: 'Training', color: '#123456' }
  assert.deepEqual(shiftAppearance({ ...shift, statusId: custom.id }, [custom]), { label: 'Training', color: '#123456' })
  assert.deepEqual(shiftAppearance({ ...weekend, statusId: custom.id }, [custom]), { label: 'Training', color: '#123456' })
  const holiday = BUILTIN_STATUSES.find((item) => item.id === 'holiday')
  assert.deepEqual(shiftAppearance({ ...shift, statusId: holiday.id }, []), { label: holiday.label, color: holiday.color })
  assert.equal(shiftAppearance(shift, []).label, 'יום')
  assert.equal(shiftAppearance({ ...shift, start: '20:00', end: '09:00' }, []).label, 'לילה')
  assert.equal(shiftAppearance(weekend, []).label, 'שבת')
})

test('shift status labels do not change eligibility, protected assignments or required rest', () => {
  const night = { ...shift, start: '20:00', end: '09:00', statusId: 'day' }
  const assignments = { [week]: { '0:day': ['a'] } }
  const locks = { [week]: ['0:day'] }
  assert.deepEqual(generateWeek(week, [worker], [night], assignments, locks), { '0:day': ['a'], '1:day': [] })
  assert.equal(workerRestOnDate('a', '2026-11-16', [night], assignments).length, 1)
  assert.equal(assignmentConflict({ ...worker, allowNightShifts: false },
    createOccurrence(week, 0, night), [night], {}), 'night-not-allowed')
  const dayWithBlockingLabel = { ...shift, statusId: 'leave' }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 0, dayWithBlockingLabel), [dayWithBlockingLabel], {}), null)
  assert.deepEqual(generateWeek(week, [worker], [dayWithBlockingLabel], assignments, locks), { '0:day': ['a'], '1:day': ['a'] })
  assert.equal(workerRestOnDate('a', '2026-11-16', [{ ...shift, statusId: 'night' }], assignments).length, 0)
})

test('custom statuses and shift references survive backup round trips and reject invalid definitions', () => {
  const custom = { ...leave, id: 'custom-leave', label: 'Annual leave' }
  const backup = JSON.parse(JSON.stringify({ customStatuses: [custom], shifts: [{ ...shift, statusId: custom.id }] }))
  assert.ok(isShiftStatusConfiguration(backup.shifts, backup.customStatuses))
  assert.ok(isShiftStatusConfiguration([shift]))
  assert.ok(isShiftStatusConfiguration([{ ...shift, statusId: 'holiday' }]))
  assert.equal(isShiftStatusConfiguration(backup.shifts), false)
  assert.equal(isShiftStatusConfiguration([{ ...shift, statusId: null }], [custom]), false)
  for (const invalid of [
    null, {}, [{ ...custom, color: 'red' }], [{ ...custom, blocksShifts: 'false' }],
    [{ ...custom, label: ' ' }], [{ ...custom, id: ' ' }], [{ ...custom, id: 'day' }],
    [{ ...custom, label: BUILTIN_STATUSES[0].label }], [custom, custom],
    [custom, { ...custom, id: 'different-id', label: ' ANNUAL LEAVE ' }],
  ]) {
    assert.equal(isCustomStatuses(invalid), false)
    assert.equal(isShiftStatusConfiguration([shift], invalid), false)
  }
  assert.ok(customStatusError({ ...custom, label: ' ' }, []))
  assert.ok(customStatusError({ ...custom, label: ' ANNUAL LEAVE ' }, [custom]))
  assert.ok(customStatusError({ ...custom, color: 'red' }, []))
  assert.equal(customStatusError(custom, []), null)
})

test('legacy preset cells use the corrected label without losing their settings or changing custom definitions', () => {
  const original = { [week]: {
    a: { label: 'חברה', color: '#123456', note: 'Location', blocksShifts: false },
    b: { ...leave, label: 'חברה', id: 'company' },
    c: { ...leave, label: 'חברה', id: 'user-defined' },
    d: leave,
  } }
  const migrated = migrateDailyStatuses(JSON.parse(JSON.stringify(original)))
  assert.deepEqual(migrated[week].a, { ...original[week].a, label: 'חבירה' })
  assert.equal(migrated[week].b.label, 'חבירה')
  assert.deepEqual(migrated[week].c, original[week].c)
  assert.deepEqual(migrated[week].d, leave)
  assert.equal(original[week].a.label, 'חברה')
  assert.deepEqual(migrateDailyStatuses(migrated), migrated)
})
