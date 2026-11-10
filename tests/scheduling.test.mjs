import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assignmentConflict,
  coveredDays,
  createOccurrence,
  generateWeek,
  isVisibleOnDay,
  occursOnDay,
  protectExistingAssignments,
  protectedAssignmentProblems,
  removeRestrictedAssignments,
  removeIneligibleShiftAssignments,
  visibleOccurrences,
  weekOccurrences,
} from '../src/scheduling.ts'

const week = '2026-11-08'
const nextWeek = '2026-11-15'
const weekend = {
  id: 'weekend',
  name: 'Weekend',
  start: '18:00',
  end: '09:00',
  requiredWorkers: 2,
  activeDays: [4],
  grouping: { startDay: 4, endDay: 0 },
}
const worker = {
  id: 'worker',
  name: 'Worker',
  role: '',
  phone: '',
  maxShifts: 5,
  excludedDays: [],
  preferredDays: [],
}
const sunday = {
  id: 'morning',
  name: 'Morning',
  start: '08:00',
  end: '16:00',
  requiredWorkers: 1,
  activeDays: [0],
}

test('Thursday through Sunday is one 63-hour occurrence, with shared continuations across weeks', () => {
  const [occurrence] = weekOccurrences(week, [weekend])
  assert.equal(weekOccurrences(week, [weekend]).length, 1)
  assert.equal(occurrence.end - occurrence.start, 63 * 60)
  assert.deepEqual(coveredDays(occurrence), [4, 5, 6, 0])
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].filter((day) => isVisibleOnDay(occurrence, week, day)),
    [4, 5, 6],
  )

  const assignments = { [week]: { [occurrence.key]: [worker.id] } }
  const [continuation] = visibleOccurrences(nextWeek, [weekend], assignments)
  assert.equal(continuation.week, week)
  assert.equal(continuation.key, occurrence.key)
  assert.equal(isVisibleOnDay(continuation, nextWeek, 0), true)
  assert.equal(isVisibleOnDay(continuation, nextWeek, 1), false)
  assert.equal(visibleOccurrences(nextWeek, [weekend], {}).length, 1)
})

test('every covered day, including Sunday morning, blocks an unavailable worker', () => {
  const occurrence = createOccurrence(week, 4, weekend)
  for (const day of [4, 5, 6, 0]) {
    const unavailableWorker = { ...worker, excludedDays: [day] }
    assert.equal(assignmentConflict(unavailableWorker, occurrence, [weekend], {}), 'unavailable')
    assert.deepEqual(generateWeek(week, [unavailableWorker], [weekend], {})[occurrence.key], [])
  }
  assert.equal(assignmentConflict({ ...worker, excludedDays: [1] }, occurrence, [weekend], {}), null)
})

test('ordinary overnight shifts show only on their starting days without duplicate continuation cards', () => {
  const night = { ...sunday, id: 'night', start: '17:00', end: '09:00', activeDays: [0, 1] }
  const assignments = { [week]: { '0:night': [worker.id] } }
  const displayed = visibleOccurrences(week, [night], assignments)
  assert.deepEqual(
    [0, 1, 2].map((day) => displayed.filter((item) => isVisibleOnDay(item, week, day)).map((item) => item.key)),
    [['0:night'], ['1:night'], []],
  )
  const occurrence = createOccurrence(week, 0, night)
  assert.equal(occursOnDay(occurrence, week, 1), true)
  assert.equal(assignmentConflict(worker, createOccurrence(week, 1, night), [night], assignments), 'rest-day')
})

test('the next week hides ordinary overnight carryovers but keeps grouped continuations and their assignments', () => {
  const night = { ...sunday, id: 'night', start: '17:00', end: '09:00', activeDays: [6] }
  const assignments = { [week]: { '6:night': [worker.id], '4:weekend': ['other'] } }
  const snapshot = structuredClone(assignments)
  const shifts = [night, weekend]
  const displayed = visibleOccurrences(nextWeek, shifts, assignments)
  assert.equal(displayed.some((item) => item.week === week && item.key === '6:night'), false)
  const sundayCards = displayed.filter((item) => isVisibleOnDay(item, nextWeek, 0))
  assert.equal(sundayCards.length, 1)
  assert.equal(sundayCards[0].key, '4:weekend')
  assert.equal(sundayCards[0].week, week)
  assert.deepEqual(assignments[sundayCards[0].week][sundayCards[0].key], ['other'])
  const morning = { ...sunday, start: '09:00' }
  assert.equal(assignmentConflict(worker, createOccurrence(nextWeek, 0, morning), [...shifts, morning], assignments), 'rest-day')
  assert.deepEqual(assignments, snapshot)
})

test('manual eligibility blocks overlaps in either week and requires rest after a grouped shift', () => {
  const occurrence = createOccurrence(week, 4, weekend)
  const shifts = [weekend, sunday]
  const assignedWeekend = { [week]: { [occurrence.key]: [worker.id] } }
  assert.equal(
    assignmentConflict(worker, createOccurrence(nextWeek, 0, sunday), shifts, assignedWeekend),
    'overlap',
  )
  assert.equal(
    assignmentConflict(worker, occurrence, shifts, { [nextWeek]: { '0:morning': [worker.id] } }),
    'overlap',
  )
  const afterWeekend = { ...sunday, start: '09:00' }
  assert.equal(
    assignmentConflict(worker, createOccurrence(nextWeek, 0, afterWeekend), [weekend, afterWeekend], assignedWeekend),
    'rest-day',
  )
  const friday = { ...sunday, activeDays: [5] }
  assert.equal(
    assignmentConflict(worker, createOccurrence(week, 5, friday), [weekend, friday], assignedWeekend),
    'overlap',
  )
})

test('automatic generation respects both previous and future weeks without changing them', () => {
  const shifts = [weekend, sunday]
  const oldSchedule = { [week]: { '4:weekend': [worker.id] } }
  const snapshot = structuredClone(oldSchedule)
  const next = generateWeek(nextWeek, [worker], shifts, oldSchedule)
  assert.deepEqual(next['0:morning'], [])
  assert.deepEqual(next['4:weekend'], [worker.id])
  assert.deepEqual(oldSchedule, snapshot)

  const future = { [nextWeek]: { '0:morning': [worker.id] } }
  const earlier = generateWeek(week, [worker], shifts, future)
  assert.deepEqual(earlier['4:weekend'], [])
  assert.deepEqual(future[nextWeek]['0:morning'], [worker.id])
})

test('a grouped shift counts once against its starting week quota and retains its whole team', () => {
  const team = [worker, { ...worker, id: 'second', name: 'Second' }].map(
    (person) => ({ ...person, maxShifts: 1 }),
  )
  const generated = generateWeek(week, team, [weekend], {})
  assert.equal(Object.keys(generated).length, 1)
  assert.equal(generated['4:weekend'].length, 2)

  const friday = { ...sunday, activeDays: [5] }
  const nextMonday = { ...sunday, activeDays: [1] }
  const schedule = { [week]: generated }
  assert.equal(assignmentConflict(team[0], createOccurrence(week, 5, friday), [weekend, friday], schedule), 'overlap')
  assert.equal(assignmentConflict(team[0], createOccurrence(nextWeek, 1, nextMonday), [weekend, nextMonday], schedule), null)

  const thursday = { ...sunday, activeDays: [4], start: '10:00', end: '12:00' }
  assert.equal(assignmentConflict(team[0], createOccurrence(week, 4, thursday), [weekend, thursday], schedule), 'limit')
})

test('daily and overnight templates remain compatible, without treating midnight as a covered day', () => {
  const legacy = { ...sunday, activeDays: [0, 1] }
  assert.equal(weekOccurrences(week, [legacy]).length, 2)
  assert.deepEqual(coveredDays(createOccurrence(week, 0, legacy)), [0])

  const midnightEnd = { ...weekend, end: '00:00' }
  const occurrence = createOccurrence(week, 4, midnightEnd)
  assert.deepEqual(coveredDays(occurrence), [4, 5, 6])
  assert.equal(occursOnDay(occurrence, nextWeek, 0), false)
  assert.equal(assignmentConflict({ ...worker, excludedDays: [0] }, occurrence, [midnightEnd], {}), null)

  const overnight = { ...sunday, start: '22:00', end: '10:00', activeDays: [6] }
  const schedule = { [week]: { '6:morning': [worker.id] } }
  assert.equal(assignmentConflict(worker, createOccurrence(nextWeek, 0, sunday), [overnight, { ...sunday, id: 'day' }], schedule), 'overlap')
})

test('preferred days inside a group influence staffing and backup round trips preserve groups', () => {
  const shifts = [{ ...weekend, requiredWorkers: 1 }]
  const preferred = { ...worker, id: 'preferred', name: 'Z', preferredDays: [6] }
  const generated = generateWeek(week, [{ ...worker, name: 'A' }, preferred], shifts, {})
  assert.deepEqual(generated['4:weekend'], ['preferred'])
  const restored = JSON.parse(JSON.stringify({ shifts, assignments: { [week]: generated } }))
  assert.deepEqual(
    visibleOccurrences(nextWeek, restored.shifts, restored.assignments),
    visibleOccurrences(nextWeek, shifts, { [week]: generated }),
  )
})

test('grouped occurrences wrap calendar years and same-day overnight grouping wraps a week', () => {
  const yearEnd = createOccurrence('2026-12-27', 4, weekend)
  assert.equal(new Date(yearEnd.end * 60000).toISOString(), '2027-01-03T09:00:00.000Z')
  const sameDay = { ...weekend, grouping: { startDay: 4, endDay: 4 } }
  const occurrence = createOccurrence(week, 4, sameDay)
  assert.equal(occurrence.end - occurrence.start, 159 * 60)
  assert.equal(coveredDays(occurrence).length, 7)
})

test('day/night preference ranks matching workers before neutral and opposite preferences', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const dayWorker = { ...worker, id: 'day-worker', name: 'Z', shiftPreference: 'day' }
  const nightWorker = { ...worker, id: 'night-worker', name: 'Z', shiftPreference: 'night' }
  const neutral = { ...worker, id: 'neutral', name: 'A', preferredDays: [0] }
  const generated = generateWeek(week, [nightWorker, neutral, dayWorker], [sunday, night], {})
  assert.deepEqual(generated['0:morning'], ['day-worker'])
  assert.deepEqual(generated['0:night'], ['night-worker'])

  const withoutDayPreference = generateWeek(week, [nightWorker, neutral], [sunday], {})
  assert.deepEqual(withoutDayPreference['0:morning'], ['neutral'])
})

test('preferences allow fallback and manual overrides without bypassing hard constraints', () => {
  const prefersNight = { ...worker, shiftPreference: 'night' }
  assert.deepEqual(generateWeek(week, [prefersNight], [sunday], {})['0:morning'], [worker.id])
  assert.equal(assignmentConflict(prefersNight, createOccurrence(week, 0, sunday), [sunday], {}), null)

  const unavailableMatch = { ...worker, id: 'day-match', shiftPreference: 'day', excludedDays: [0] }
  const cappedMatch = { ...worker, id: 'capped', shiftPreference: 'day', maxShifts: 0 }
  assert.deepEqual(
    generateWeek(week, [unavailableMatch, cappedMatch, prefersNight], [sunday], {})['0:morning'],
    [worker.id],
  )
})

test('automatic time classification supports legacy shifts and an explicit classification overrides it', () => {
  const dayWorker = { ...worker, id: 'day-worker', shiftPreference: 'day' }
  const nightWorker = { ...worker, id: 'night-worker', shiftPreference: 'night' }
  const cases = [
    { start: '09:00', end: '17:00', expected: 'day-worker' },
    { start: '17:00', end: '05:00', expected: 'night-worker' },
    { start: '18:00', end: '23:00', expected: 'night-worker' },
    { start: '05:00', end: '09:00', expected: 'night-worker' },
    { start: '06:00', end: '14:00', expected: 'day-worker' },
    { start: '09:00', end: '17:00', period: 'night', expected: 'night-worker' },
    { start: '20:00', end: '06:00', period: 'day', expected: 'day-worker' },
  ]
  for (const { expected, ...times } of cases) {
    const generated = generateWeek(week, [dayWorker, nightWorker], [{ ...sunday, ...times }], {})
    assert.deepEqual(generated['0:morning'], [expected])
  }
})

test('grouped permission is independent of preferences and blocks both automatic and manual assignment', () => {
  const grouped = { ...weekend, requiredWorkers: 1 }
  const occurrence = createOccurrence(week, 4, grouped)
  const denied = { ...worker, allowGroupedShifts: false, shiftPreference: 'night' }
  assert.equal(assignmentConflict(denied, occurrence, [grouped], {}), 'grouped-not-allowed')
  assert.deepEqual(generateWeek(week, [denied], [grouped], {})['4:weekend'], [])
  assert.equal(assignmentConflict(denied, createOccurrence(week, 0, sunday), [sunday], {}), null)

  const allowedDay = { ...worker, id: 'allowed', allowGroupedShifts: true, shiftPreference: 'day' }
  assert.deepEqual(generateWeek(week, [denied, allowedDay], [grouped], {})['4:weekend'], ['allowed'])
  const prefersCoveredDay = { ...allowedDay, id: 'preferred-day', name: 'Z', preferredDays: [6] }
  const nightWorker = { ...worker, id: 'night-worker', name: 'A', shiftPreference: 'night' }
  assert.deepEqual(
    generateWeek(week, [nightWorker, prefersCoveredDay], [grouped], {})['4:weekend'],
    ['preferred-day'],
  )
  assert.deepEqual(generateWeek(week, [worker], [grouped], {})['4:weekend'], [worker.id])
})

test('revoking grouped permission removes only that worker from grouped assignments across weeks', () => {
  const assignments = {
    [week]: { '4:weekend': [worker.id, 'other'], '0:morning': [worker.id] },
    [nextWeek]: { '4:weekend': [worker.id], '0:morning': ['other'] },
  }
  const snapshot = structuredClone(assignments)
  const cleaned = removeRestrictedAssignments({ ...worker, allowGroupedShifts: false }, [weekend, sunday], assignments)
  assert.deepEqual(cleaned, {
    [week]: { '4:weekend': ['other'], '0:morning': [worker.id] },
    [nextWeek]: { '4:weekend': [], '0:morning': ['other'] },
  })
  assert.deepEqual(assignments, snapshot)
})

test('backup round trips retain preferences and permission while older backups keep their eligibility', () => {
  const data = {
    workers: [
      { ...worker, id: 'day', shiftPreference: 'day', allowGroupedShifts: false },
      { ...worker, id: 'night', shiftPreference: 'night', allowGroupedShifts: true },
    ],
    shifts: [sunday, { ...weekend, requiredWorkers: 1 }],
    assignments: {},
  }
  const restored = JSON.parse(JSON.stringify(data))
  const generated = generateWeek(week, restored.workers, restored.shifts, restored.assignments)
  assert.deepEqual(generated['0:morning'], ['day'])
  assert.deepEqual(generated['4:weekend'], ['night'])
  const legacy = JSON.parse(JSON.stringify({ workers: [worker], shifts: [weekend] }))
  assert.deepEqual(generateWeek(week, legacy.workers, legacy.shifts, {})['4:weekend'], [worker.id])
})

test('Saturday-only workers cannot receive ordinary shifts, even ordinary shifts on Saturday', () => {
  const saturdayOnly = { ...worker, groupedOnly: true, allowGroupedShifts: true }
  const saturdayDaily = { ...sunday, activeDays: [6] }
  assert.equal(assignmentConflict(saturdayOnly, createOccurrence(week, 6, saturdayDaily), [saturdayDaily], {}), 'grouped-only')
  const generated = generateWeek(week, [saturdayOnly], [sunday, weekend], {})
  assert.deepEqual(generated['0:morning'], [])
  assert.deepEqual(generated['4:weekend'], [worker.id])
  const assignments = { [week]: { '0:morning': [worker.id, 'other'], '4:weekend': [worker.id] } }
  assert.deepEqual(removeRestrictedAssignments(saturdayOnly, [sunday, weekend], assignments), {
    [week]: { '0:morning': ['other'], '4:weekend': [worker.id] },
  })
})

test('manual-only nights stay empty automatically but permit protected manual assignments', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const manualOnly = { ...worker, manualNightOnly: true, shiftPreference: 'night' }
  const shifts = [sunday, night, weekend]
  const automatic = generateWeek(week, [manualOnly], shifts, {})
  assert.deepEqual(automatic['0:night'], [])
  assert.deepEqual(automatic['0:morning'], [worker.id])
  assert.deepEqual(automatic['4:weekend'], [worker.id])
  assert.equal(assignmentConflict(manualOnly, createOccurrence(week, 0, night), shifts, {}), null)
  const assignments = { [week]: { '0:night': [worker.id] } }
  assert.deepEqual(generateWeek(week, [manualOnly], shifts, assignments, { [week]: ['0:night'] })['0:night'], [worker.id])
})

test('night prohibition blocks automatic and manual work but leaves day and grouped permissions independent', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const denied = { ...worker, allowNightShifts: false, manualNightOnly: true, shiftPreference: 'night' }
  const shifts = [sunday, night, weekend]
  assert.equal(assignmentConflict(denied, createOccurrence(week, 0, night), shifts, {}), 'night-not-allowed')
  const generated = generateWeek(week, [denied], shifts, {})
  assert.deepEqual(generated['0:night'], [])
  assert.deepEqual(generated['0:morning'], [worker.id])
  assert.deepEqual(generated['4:weekend'], [worker.id])
  assert.equal(assignmentConflict(denied, createOccurrence(week, 4, weekend), shifts, {}), null)
  assert.equal(assignmentConflict(
    { ...denied, allowGroupedShifts: false }, createOccurrence(week, 4, weekend), shifts, {},
  ), 'grouped-not-allowed')
  const restored = JSON.parse(JSON.stringify(denied))
  assert.deepEqual(generateWeek(week, [restored], [night], {})['0:night'], [])
  assert.deepEqual(generateWeek(week, [worker], [night], {})['0:night'], [worker.id])
  assert.deepEqual(generateWeek(week, [{ ...denied, allowNightShifts: true, manualNightOnly: false }], [night], {})['0:night'], [worker.id])
})

test('night prohibition follows explicit classification and removes only forbidden assignments', () => {
  const classifiedNight = { ...sunday, id: 'night', period: 'night' }
  const classifiedDay = { ...sunday, id: 'day', start: '20:00', end: '06:00', period: 'day' }
  const denied = { ...worker, allowNightShifts: false }
  const shifts = [classifiedNight, classifiedDay, weekend]
  assert.equal(assignmentConflict(denied, createOccurrence(week, 0, classifiedNight), shifts, {}), 'night-not-allowed')
  assert.equal(assignmentConflict(denied, createOccurrence(week, 0, classifiedDay), shifts, {}), null)
  const assignments = {
    [week]: { '0:night': [worker.id, 'other'], '0:day': [worker.id], '4:weekend': [worker.id] },
    [nextWeek]: { '0:night': [worker.id] },
  }
  const snapshot = structuredClone(assignments)
  assert.deepEqual(removeRestrictedAssignments(denied, shifts, assignments), {
    [week]: { '0:night': ['other'], '0:day': [worker.id], '4:weekend': [worker.id] },
    [nextWeek]: { '0:night': [] },
  })
  assert.deepEqual(assignments, snapshot)
})

test('protected night assignments cannot bypass a strict night prohibition', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const denied = { ...worker, allowNightShifts: false }
  const assignments = { [week]: { '0:night': [worker.id] } }
  const locks = { [week]: ['0:night'] }
  assert.deepEqual(protectedAssignmentProblems(week, [denied], [night], assignments, locks), ['0:night'])
  assert.throws(() => generateWeek(week, [denied], [night], assignments, locks), /Invalid protected assignments/)
  assert.deepEqual(assignments[week]['0:night'], [worker.id])
})

test('previous ordinary workload reduces the following allocation ahead of preferences', () => {
  const shifts = [{ ...sunday, activeDays: [0, 1, 2] }]
  const busy = { ...worker, id: 'busy', name: 'A', shiftPreference: 'day' }
  const rested = { ...worker, id: 'rested', name: 'Z', shiftPreference: 'night' }
  const assignments = {
    '2026-11-01': { '0:morning': ['busy'], '1:morning': ['busy'], '2:morning': ['rested'] },
  }
  const generated = generateWeek(week, [busy, rested], shifts, assignments)
  assert.equal(Object.values(generated).filter((ids) => ids.includes('busy')).length, 1)
  assert.equal(Object.values(generated).filter((ids) => ids.includes('rested')).length, 2)
})

test('four-week history includes the fourth previous week, excludes older/future weeks, and ignores replaced current auto data', () => {
  const team = [
    { ...worker, id: 'a', name: 'A' },
    { ...worker, id: 'b', name: 'B' },
  ]
  const history = {
    '2026-10-11': { '0:morning': ['a'] },
    '2026-10-04': { '0:morning': ['b'] },
    [nextWeek]: { '0:morning': ['b'] },
    [week]: { '0:morning': ['b'] },
  }
  assert.deepEqual(generateWeek(week, team, [sunday], history)['0:morning'], ['b'])
  assert.deepEqual(generateWeek(week, team, [sunday], {
    '2026-10-04': history['2026-10-04'],
    [nextWeek]: history[nextWeek],
    [week]: history[week],
  })['0:morning'], ['a'])
})

test('Saturday rotation spans all saved history and repeats only after everybody has had a turn', () => {
  const grouped = { ...weekend, requiredWorkers: 1 }
  const team = ['a', 'b', 'c'].map((id) => ({ ...worker, id, name: id }))
  const history = {
    '2026-09-06': { '4:weekend': ['a'] },
    '2026-10-04': { '4:weekend': ['b'] },
  }
  const snapshot = structuredClone(history)
  const generated = generateWeek(week, team, [grouped], history)
  assert.deepEqual(generated['4:weekend'], ['c'])
  assert.deepEqual(history, snapshot)
  const completed = { ...history, [week]: generated }
  assert.deepEqual(generateWeek(nextWeek, team, [grouped], completed)['4:weekend'], ['a'])
})

test('an unavailable waiting worker keeps the Saturday slot open instead of allowing an early repeat', () => {
  const grouped = { ...weekend, requiredWorkers: 1 }
  const team = [
    { ...worker, id: 'a' },
    { ...worker, id: 'b', excludedDays: [6] },
    { ...worker, id: 'not-in-queue', allowGroupedShifts: false },
  ]
  const history = { '2026-11-01': { '4:weekend': ['a'] } }
  assert.deepEqual(generateWeek(week, team, [grouped], history)['4:weekend'], [])
  assert.deepEqual(generateWeek(week, [{ ...team[0] }, { ...team[1], excludedDays: [] }], [grouped], history)['4:weekend'], ['b'])
})

test('multi-person Saturday shifts finish the round before starting another without duplicate staffing', () => {
  const team = ['a', 'b', 'c'].map((id) => ({ ...worker, id, name: id }))
  const history = { '2026-11-01': { '4:weekend': ['a', 'b'] } }
  const generated = generateWeek(week, team, [weekend], history)
  assert.deepEqual(generated['4:weekend'], ['c', 'a'])
  assert.deepEqual(generateWeek(nextWeek, team, [weekend], { ...history, [week]: generated })['4:weekend'], ['b', 'c'])
})

test('Saturday turns are reserved before ordinary shifts use a waiting worker weekly quota', () => {
  const grouped = { ...weekend, requiredWorkers: 1 }
  const team = [
    { ...worker, id: 'served', name: 'Z' },
    { ...worker, id: 'waiting', name: 'A', maxShifts: 1 },
  ]
  const history = { '2026-11-01': { '4:weekend': ['served'] } }
  const generated = generateWeek(week, team, [{ ...sunday, activeDays: [1] }, grouped], history)
  assert.deepEqual(generated['4:weekend'], ['waiting'])
  assert.deepEqual(generated['1:morning'], ['served'])
})

test('regeneration keeps partial and deliberately empty protected shifts exactly as entered', () => {
  const team = [worker, { ...worker, id: 'other' }]
  const shifts = [{ ...sunday, activeDays: [0, 1, 2], requiredWorkers: 2 }]
  const assignments = { [week]: { '0:morning': [worker.id], '1:morning': [], '2:morning': ['other'] } }
  const locks = { [week]: ['0:morning', '1:morning'] }
  const snapshot = structuredClone({ assignments, locks })
  const generated = generateWeek(week, team, shifts, assignments, locks)
  assert.deepEqual(generated['0:morning'], [worker.id])
  assert.deepEqual(generated['1:morning'], [])
  assert.equal(generated['2:morning'].length, 2)
  assert.deepEqual({ assignments, locks }, snapshot)
  assert.deepEqual(generateWeek(week, team, shifts, { [week]: generated }, locks), generated)
  assert.equal(generateWeek(week, team, shifts, assignments, {})['1:morning'].length, 2)
})

test('later manual assignments consume quota and prevent overlapping automatic assignments', () => {
  const day = { ...sunday, activeDays: [0, 1] }
  const assignments = { [week]: { '1:morning': [worker.id] } }
  assert.deepEqual(generateWeek(week, [{ ...worker, maxShifts: 1 }], [day], assignments, { [week]: ['1:morning'] }), {
    '0:morning': [], '1:morning': [worker.id],
  })
  const overlap = { ...sunday, id: 'overlap', start: '12:00', end: '20:00' }
  const generated = generateWeek(week, [worker], [sunday, overlap], {
    [week]: { '0:overlap': [worker.id] },
  }, { [week]: ['0:overlap'] })
  assert.deepEqual(generated['0:morning'], [])
  assert.deepEqual(generated['0:overlap'], [worker.id])
})

test('invalid protected assignments stop generation without discarding manual work', () => {
  const unavailable = { ...worker, excludedDays: [0] }
  const assignments = { [week]: { '0:morning': [worker.id] } }
  const locks = { [week]: ['0:morning'] }
  assert.deepEqual(protectedAssignmentProblems(week, [unavailable], [sunday], assignments, locks), ['0:morning'])
  assert.throws(() => generateWeek(week, [unavailable], [sunday], assignments, locks), /Invalid protected assignments/)
  assert.deepEqual(assignments[week]['0:morning'], [worker.id])
})

test('legacy assignments start protected and lock metadata survives backup round trips', () => {
  const assignments = { [week]: { '0:morning': [worker.id], '4:weekend': [] } }
  const migrated = protectExistingAssignments(assignments)
  assert.deepEqual(migrated, { [week]: ['0:morning'] })
  const backup = JSON.parse(JSON.stringify({
    workers: [{ ...worker, manualNightOnly: true }],
    shifts: [sunday, weekend],
    assignments,
    lockedSlots: { [week]: [...migrated[week], '4:weekend'] },
  }))
  const generated = generateWeek(week, backup.workers, backup.shifts, backup.assignments, backup.lockedSlots)
  assert.deepEqual(generated, assignments[week])
})

test('restricted shifts accept only selected workers in manual and automatic scheduling', () => {
  const allowed = { ...worker, name: 'Z', shiftPreference: 'night' }
  const outsider = { ...worker, id: 'outsider', name: 'A', shiftPreference: 'day' }
  const restricted = { ...sunday, requiredWorkers: 2, eligibleWorkerIds: [worker.id] }
  assert.equal(assignmentConflict(outsider, createOccurrence(week, 0, restricted), [restricted], {}), 'worker-not-eligible')
  assert.equal(assignmentConflict(allowed, createOccurrence(week, 0, restricted), [restricted], {}), null)
  assert.deepEqual(generateWeek(week, [outsider, allowed], [restricted], {})['0:morning'], [worker.id])
  const capped = { ...allowed, maxShifts: 0 }
  const unavailable = { ...allowed, excludedDays: [0] }
  for (const candidate of [capped, unavailable]) {
    assert.deepEqual(generateWeek(week, [outsider, candidate], [restricted], {})['0:morning'], [])
  }
})

test('eligible lists do not override night restrictions or protected assignment validation', () => {
  const restricted = { ...sunday, start: '20:00', end: '06:00', eligibleWorkerIds: [worker.id] }
  assert.equal(assignmentConflict({ ...worker, allowNightShifts: false }, createOccurrence(week, 0, restricted), [restricted], {}), 'night-not-allowed')
  assert.deepEqual(generateWeek(week, [{ ...worker, manualNightOnly: true }], [restricted], {})['0:morning'], [])
  const outsider = { ...worker, id: 'outsider' }
  const assignments = { [week]: { '0:morning': [outsider.id] } }
  const locks = { [week]: ['0:morning'] }
  assert.deepEqual(protectedAssignmentProblems(week, [worker, outsider], [restricted], assignments, locks), ['0:morning'])
  assert.throws(() => generateWeek(week, [worker, outsider], [restricted], assignments, locks), /Invalid protected assignments/)
  assert.deepEqual(assignments[week]['0:morning'], ['outsider'])
})

test('empty or deleted eligible lists never become unrestricted, and backups retain restrictions', () => {
  for (const ids of [[], ['deleted-worker']]) {
    const restored = JSON.parse(JSON.stringify({ ...sunday, eligibleWorkerIds: ids }))
    assert.deepEqual(generateWeek(week, [worker], [restored], {})['0:morning'], [])
    assert.equal(assignmentConflict(worker, createOccurrence(week, 0, restored), [restored], {}), 'worker-not-eligible')
  }
  const restored = JSON.parse(JSON.stringify({ ...sunday, eligibleWorkerIds: [worker.id] }))
  assert.deepEqual(generateWeek(week, [worker], [restored], {})['0:morning'], [worker.id])
  assert.deepEqual(generateWeek(week, [worker], [sunday], {})['0:morning'], [worker.id])
})

test('editing eligible lists removes only disallowed workers without changing other assignments', () => {
  const restricted = { ...sunday, eligibleWorkerIds: [worker.id] }
  const assignments = {
    [week]: { '0:morning': [worker.id, 'outsider'], '4:weekend': ['outsider'] },
    [nextWeek]: { '0:morning': ['outsider'] },
  }
  const snapshot = structuredClone(assignments)
  assert.deepEqual(removeIneligibleShiftAssignments(restricted, assignments), {
    [week]: { '0:morning': [worker.id], '4:weekend': ['outsider'] },
    [nextWeek]: { '0:morning': [] },
  })
  assert.deepEqual(removeIneligibleShiftAssignments(sunday, assignments), assignments)
  assert.deepEqual(assignments, snapshot)
})

test('restricted Saturday rotation excludes outsiders but still waits for unavailable selected workers', () => {
  const grouped = { ...weekend, requiredWorkers: 1, eligibleWorkerIds: ['a', 'b'] }
  const team = ['a', 'b', 'outsider'].map((id) => ({ ...worker, id, name: id }))
  const history = { '2026-11-01': { '4:weekend': ['a'] } }
  assert.deepEqual(generateWeek(week, team, [grouped], history)['4:weekend'], ['b'])
  const completed = { ...history, [week]: { '4:weekend': ['b'] } }
  assert.deepEqual(generateWeek(nextWeek, team, [grouped], completed)['4:weekend'], ['a'])
  const unavailable = team.map((person) => person.id === 'b' ? { ...person, excludedDays: [6] } : person)
  assert.deepEqual(generateWeek(week, unavailable, [grouped], history)['4:weekend'], [])
})

test('restricted ordinary shifts reserve their eligible workers before unrestricted shifts use their quotas', () => {
  const restricted = { ...sunday, id: 'special', activeDays: [1], eligibleWorkerIds: ['selected'] }
  const team = [
    { ...worker, id: 'selected', name: 'A', maxShifts: 1 },
    { ...worker, id: 'other', name: 'B', maxShifts: 1 },
  ]
  const generated = generateWeek(week, team, [sunday, restricted], {})
  assert.deepEqual(generated['1:special'], ['selected'])
  assert.deepEqual(generated['0:morning'], ['other'])
})

test('night shifts block any further work on the ending day and release at the following midnight', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const day = { ...sunday, start: '06:00', activeDays: [1] }
  const lateNight = { ...night, id: 'late', start: '23:59', end: '05:00', activeDays: [1] }
  const nextDay = { ...sunday, id: 'next', start: '00:00', end: '08:00', activeDays: [2] }
  const shifts = [night, day, lateNight, nextDay]
  const assignments = { [week]: { '0:night': [worker.id] } }
  for (const shift of [day, lateNight]) {
    assert.equal(assignmentConflict(worker, createOccurrence(week, 1, shift), shifts, assignments), 'rest-day')
  }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 2, nextDay), shifts, assignments), null)
  const generated = generateWeek(week, [worker], shifts, assignments, { [week]: ['0:night'] })
  assert.deepEqual(generated['0:night'], [worker.id])
  assert.deepEqual(generated['1:morning'], [])
  assert.deepEqual(generated['1:late'], [])
  assert.deepEqual(generated['2:next'], [worker.id])
})

test('rest constraints are symmetric when the later shift is already assigned or processed first', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const restrictedDay = { ...sunday, start: '09:00', activeDays: [1], eligibleWorkerIds: [worker.id] }
  const shifts = [night, restrictedDay]
  const assignments = { [week]: { '1:morning': [worker.id] } }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 0, night), shifts, assignments), 'rest-day')
  const generated = generateWeek(week, [worker], shifts, {})
  assert.deepEqual(generated['1:morning'], [worker.id])
  assert.deepEqual(generated['0:night'], [])
})

test('multi-day rest crosses week boundaries in both directions without changing saved weeks', () => {
  const grouped = { ...weekend, requiredWorkers: 1, period: 'day' }
  const day = { ...sunday, start: '09:00' }
  const monday = { ...sunday, id: 'monday', start: '00:00', end: '08:00', activeDays: [1] }
  const shifts = [grouped, day, monday]
  const assignments = { [week]: { '4:weekend': [worker.id] } }
  const snapshot = structuredClone(assignments)
  assert.equal(assignmentConflict(worker, createOccurrence(nextWeek, 0, day), shifts, assignments), 'rest-day')
  assert.equal(assignmentConflict(worker, createOccurrence(nextWeek, 1, monday), shifts, assignments), null)
  const generated = generateWeek(nextWeek, [worker], shifts, assignments)
  assert.deepEqual(generated['0:morning'], [])
  assert.deepEqual(generated['1:monday'], [worker.id])
  const future = { [nextWeek]: { '0:morning': [worker.id] } }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 4, grouped), shifts, future), 'rest-day')
  assert.deepEqual(generateWeek(week, [worker], shifts, future)['4:weekend'], [])
  assert.deepEqual(assignments, snapshot)
})

test('an exact midnight finish still reserves the calendar day on which the shift ends', () => {
  const grouped = { ...weekend, end: '00:00' }
  const firstMinute = { ...sunday, start: '00:00', end: '08:00' }
  const assignments = { [week]: { '4:weekend': [worker.id] } }
  assert.equal(assignmentConflict(worker, createOccurrence(nextWeek, 0, firstMinute), [grouped, firstMinute], assignments), 'rest-day')
  const monday = { ...firstMinute, activeDays: [1] }
  assert.equal(assignmentConflict(worker, createOccurrence(nextWeek, 1, monday), [grouped, monday], assignments), null)
})

test('rest applies to classified nights even on the same day, but not to ordinary day shifts', () => {
  const day = { ...sunday, start: '08:00', end: '12:00' }
  const later = { ...sunday, id: 'later', start: '12:00', end: '16:00' }
  const assignments = { [week]: { '0:morning': [worker.id] } }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 0, later), [day, later], assignments), null)
  assert.equal(assignmentConflict(worker, createOccurrence(week, 0, later), [{ ...day, period: 'night' }, later], assignments), 'rest-day')
  const midnight = { ...sunday, id: 'midnight', start: '00:00', end: '08:00' }
  const overnightDay = { ...sunday, start: '20:00', end: '00:00', period: 'day' }
  assert.equal(assignmentConflict(worker, createOccurrence(week, 1, midnight), [overnightDay, midnight], assignments), null)
})

test('protected manual assignments cannot waive rest and are never silently removed', () => {
  const night = { ...sunday, id: 'night', start: '20:00', end: '06:00' }
  const day = { ...sunday, start: '09:00', activeDays: [1] }
  const assignments = { [week]: { '0:night': [worker.id], '1:morning': [worker.id] } }
  const locks = { [week]: ['0:night', '1:morning'] }
  const manualOnly = { ...worker, manualNightOnly: true }
  const snapshot = structuredClone(assignments)
  assert.deepEqual(protectedAssignmentProblems(week, [manualOnly], [night, day], assignments, locks), ['0:night', '1:morning'])
  assert.throws(() => generateWeek(week, [manualOnly], [night, day], assignments, locks), /Invalid protected assignments/)
  assert.deepEqual(assignments, snapshot)
})
