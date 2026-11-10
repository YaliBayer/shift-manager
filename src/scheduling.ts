export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type ShiftPeriod = 'day' | 'night'

export type Worker = {
  id: string
  name: string
  role: string
  phone: string
  maxShifts: number
  excludedDays: DayIndex[]
  preferredDays: DayIndex[]
  shiftPreference?: ShiftPeriod | 'none'
  allowGroupedShifts?: boolean
  groupedOnly?: boolean
  manualNightOnly?: boolean
  allowNightShifts?: boolean
}

export type ShiftTemplate = {
  id: string
  name: string
  start: string
  end: string
  requiredWorkers: number
  activeDays: DayIndex[]
  grouping?: { startDay: DayIndex; endDay: DayIndex }
  period?: ShiftPeriod
  eligibleWorkerIds?: string[]
}

export type WeekAssignments = Record<string, string[]>
export type AssignmentsByWeek = Record<string, WeekAssignments>
export type LockedSlotsByWeek = Record<string, string[]>

export type ShiftOccurrence = {
  week: string
  day: DayIndex
  shift: ShiftTemplate
  key: string
  start: number
  end: number
}

const DAY = 24 * 60

// Use calendar minutes, independent of the browser's timezone and DST offsets.
function weekMinutes(week: string) {
  const [year, month, day] = week.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 60000
}

function timeMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export function shiftPeriod(shift: ShiftTemplate): ShiftPeriod {
  if (shift.period) return shift.period
  const start = timeMinutes(shift.start)
  return timeMinutes(shift.end) <= start || start >= 18 * 60 || start < 6 * 60
    ? 'night'
    : 'day'
}

function preferenceRank(worker: Worker, shift: ShiftTemplate) {
  if (shift.grouping) return 0
  if (!worker.shiftPreference || worker.shiftPreference === 'none') return 1
  return worker.shiftPreference === shiftPeriod(shift) ? 0 : 2
}

export function isWorkerEligible(shift: ShiftTemplate, workerId: string) {
  return shift.eligibleWorkerIds === undefined || shift.eligibleWorkerIds.includes(workerId)
}

export function removeIneligibleShiftAssignments(
  shift: ShiftTemplate,
  assignments: AssignmentsByWeek,
): AssignmentsByWeek {
  return Object.fromEntries(Object.entries(assignments).map(([week, slots]) => [
    week,
    Object.fromEntries(Object.entries(slots).map(([key, ids]) => [
      key, key.endsWith(`:${shift.id}`) ? ids.filter((id) => isWorkerEligible(shift, id)) : ids,
    ])),
  ]))
}

function shiftRestriction(
  worker: Worker,
  shift: ShiftTemplate,
): 'worker-not-eligible' | 'grouped-not-allowed' | 'grouped-only' | 'night-not-allowed' | null {
  if (!isWorkerEligible(shift, worker.id)) return 'worker-not-eligible'
  if (shift.grouping) return worker.allowGroupedShifts === false ? 'grouped-not-allowed' : null
  if (worker.groupedOnly) return 'grouped-only'
  if (worker.allowNightShifts === false && shiftPeriod(shift) === 'night') return 'night-not-allowed'
  return null
}

export function removeRestrictedAssignments(
  worker: Worker,
  shifts: ShiftTemplate[],
  assignments: AssignmentsByWeek,
): AssignmentsByWeek {
  const restrictedIds = new Set(shifts.filter((shift) => shiftRestriction(worker, shift) !== null).map((shift) => shift.id))
  return Object.fromEntries(Object.entries(assignments).map(([week, slots]) => [
    week,
    Object.fromEntries(Object.entries(slots).map(([key, ids]) => [
      key,
      restrictedIds.has(key.slice(key.indexOf(':') + 1)) ? ids.filter((id) => id !== worker.id) : ids,
    ])),
  ]))
}

export function protectExistingAssignments(assignments: AssignmentsByWeek): LockedSlotsByWeek {
  return Object.fromEntries(Object.entries(assignments).map(([week, slots]) => [
    week, Object.keys(slots).filter((key) => slots[key].length > 0),
  ]))
}

function protectedWeek(week: string, assignments: AssignmentsByWeek, locks: LockedSlotsByWeek): WeekAssignments {
  return Object.fromEntries((locks[week] ?? []).map((key) => [key, [...(assignments[week]?.[key] ?? [])]]))
}

export function slotKey(day: DayIndex, shiftId: string) {
  return `${day}:${shiftId}`
}

export function startDays(shift: ShiftTemplate): DayIndex[] {
  return shift.grouping ? [shift.grouping.startDay] : shift.activeDays
}

export function createOccurrence(week: string, day: DayIndex, shift: ShiftTemplate): ShiftOccurrence {
  const startTime = timeMinutes(shift.start)
  const endTime = timeMinutes(shift.end)
  let endOffset = shift.grouping
    ? (shift.grouping.endDay - shift.grouping.startDay + 7) % 7
    : 0
  if (endOffset === 0 && endTime <= startTime) endOffset = shift.grouping ? 7 : 1
  const midnight = weekMinutes(week) + day * DAY
  return {
    week,
    day,
    shift,
    key: slotKey(day, shift.id),
    start: midnight + startTime,
    end: midnight + endOffset * DAY + endTime,
  }
}

export function weekOccurrences(week: string, shifts: ShiftTemplate[]) {
  return shifts
    .flatMap((shift) => startDays(shift).map((day) => createOccurrence(week, day, shift)))
    .sort((a, b) => a.start - b.start)
}

export function coveredDays(occurrence: ShiftOccurrence): DayIndex[] {
  const days = new Set<DayIndex>()
  for (let minute = Math.floor(occurrence.start / DAY) * DAY; minute < occurrence.end; minute += DAY) {
    days.add(new Date(minute * 60000).getUTCDay() as DayIndex)
  }
  return [...days]
}

export function visibleOccurrences(week: string, shifts: ShiftTemplate[], assignments: AssignmentsByWeek) {
  const start = weekMinutes(week)
  const previousWeek = new Date((start - 7 * DAY) * 60000).toISOString().slice(0, 10)
  return [
    ...weekOccurrences(previousWeek, shifts).filter(
      (occurrence) => occurrence.shift.grouping && occurrence.end > start && assignments[previousWeek]?.[occurrence.key] !== undefined,
    ),
    ...weekOccurrences(week, shifts),
  ]
}

export function occursOnDay(occurrence: ShiftOccurrence, week: string, day: DayIndex) {
  const start = weekMinutes(week) + day * DAY
  return occurrence.start < start + DAY && start < occurrence.end
}

export function isVisibleOnDay(occurrence: ShiftOccurrence, week: string, day: DayIndex) {
  return occurrence.shift.grouping
    ? occursOnDay(occurrence, week, day)
    : occurrence.week === week && occurrence.day === day
}

function restEndsAt(occurrence: ShiftOccurrence) {
  if (occurrence.shift.grouping || shiftPeriod(occurrence.shift) === 'night') {
    return (Math.floor(occurrence.end / DAY) + 1) * DAY
  }
  return occurrence.end
}

export function assignmentConflict(
  worker: Worker,
  target: ShiftOccurrence,
  shifts: ShiftTemplate[],
  assignments: AssignmentsByWeek,
): 'worker-not-eligible' | 'grouped-not-allowed' | 'grouped-only' | 'night-not-allowed' | 'unavailable' | 'overlap' | 'rest-day' | 'limit' | null {
  const restriction = shiftRestriction(worker, target.shift)
  if (restriction) return restriction
  if (coveredDays(target).some((day) => worker.excludedDays.includes(day))) return 'unavailable'

  for (const [week, assigned] of Object.entries(assignments)) {
    for (const other of weekOccurrences(week, shifts)) {
      if (week === target.week && other.key === target.key) continue
      if (!assigned[other.key]?.includes(worker.id)) continue
      if (target.start < other.end && other.start < target.end) return 'overlap'
      if (
        target.start < restEndsAt(other) &&
        other.start < restEndsAt(target)
      ) return 'rest-day'
    }
  }

  const count = weekOccurrences(target.week, shifts).filter(
    (other) => other.key !== target.key && assignments[target.week]?.[other.key]?.includes(worker.id),
  ).length
  return count >= worker.maxShifts ? 'limit' : null
}

export function protectedAssignmentProblems(
  week: string,
  workers: Worker[],
  shifts: ShiftTemplate[],
  assignments: AssignmentsByWeek,
  locks: LockedSlotsByWeek,
): string[] {
  const protectedSlots = protectedWeek(week, assignments, locks)
  const schedule = { ...assignments, [week]: protectedSlots }
  const occurrences = weekOccurrences(week, shifts)
  return Object.entries(protectedSlots).filter(([key, ids]) => {
    const occurrence = occurrences.find((item) => item.key === key)
    if (!occurrence || ids.length > occurrence.shift.requiredWorkers || new Set(ids).size !== ids.length) return true
    return ids.some((id) => {
      const worker = workers.find((item) => item.id === id)
      return !worker || assignmentConflict(worker, occurrence, shifts, schedule) !== null
    })
  }).map(([key]) => key)
}

function ordinaryHistory(week: string, shifts: ShiftTemplate[], assignments: AssignmentsByWeek) {
  const counts = new Map<string, number>()
  const end = weekMinutes(week)
  for (const [pastWeek, slots] of Object.entries(assignments)) {
    const start = weekMinutes(pastWeek)
    if (start >= end || start < end - 28 * DAY) continue
    for (const occurrence of weekOccurrences(pastWeek, shifts)) {
      if (occurrence.shift.grouping) continue
      for (const id of slots[occurrence.key] ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

function groupedRotation(
  target: ShiftOccurrence,
  workers: Worker[],
  shifts: ShiftTemplate[],
  assignments: AssignmentsByWeek,
) {
  const pool = workers.filter((worker) =>
    worker.allowGroupedShifts !== false && worker.maxShifts > 0 && isWorkerEligible(target.shift, worker.id),
  ).map((worker) => worker.id)
  let waiting = new Set(pool)
  const lastTurn = new Map<string, number>()
  const past = Object.keys(assignments)
    .filter((week) => week <= target.week)
    .flatMap((week) => weekOccurrences(week, shifts))
    .filter((occurrence) => occurrence.shift.grouping && occurrence.start <= target.start)
    .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))

  for (const occurrence of past) {
    for (const id of assignments[occurrence.week]?.[occurrence.key] ?? []) {
      if (!pool.includes(id)) continue
      if (waiting.size === 0) waiting = new Set(pool)
      waiting.delete(id)
      lastTurn.set(id, occurrence.start)
    }
  }
  if (waiting.size === 0) waiting = new Set(pool)
  return { waiting, lastTurn }
}

export function generateWeek(
  week: string,
  workers: Worker[],
  shifts: ShiftTemplate[],
  assignments: AssignmentsByWeek,
  locks: LockedSlotsByWeek = {},
) {
  const problems = protectedAssignmentProblems(week, workers, shifts, assignments, locks)
  if (problems.length) throw new Error(`Invalid protected assignments: ${problems.join(', ')}`)
  const generated = protectedWeek(week, assignments, locks)
  const schedule = { ...assignments, [week]: generated }
  const history = ordinaryHistory(week, shifts, assignments)
  const ordinaryCounts = new Map<string, number>()
  const occurrences = weekOccurrences(week, shifts)
  for (const occurrence of occurrences.filter((item) => !item.shift.grouping)) {
    for (const id of generated[occurrence.key] ?? []) {
      ordinaryCounts.set(id, (ordinaryCounts.get(id) ?? 0) + 1)
    }
  }

  // Reserve Saturday turns before ordinary shifts can consume the waiting workers' weekly quota.
  const ordered = [...occurrences].sort((a, b) => {
    const groupedFirst = Number(Boolean(b.shift.grouping)) - Number(Boolean(a.shift.grouping))
    if (groupedFirst) return groupedFirst
    // Reserve small candidate pools before unrestricted ordinary shifts consume their workers.
    if (!a.shift.grouping && !b.shift.grouping) {
      const poolDifference = (a.shift.eligibleWorkerIds?.length ?? Number.MAX_SAFE_INTEGER) -
        (b.shift.eligibleWorkerIds?.length ?? Number.MAX_SAFE_INTEGER)
      if (poolDifference) return poolDifference
    }
    return a.start - b.start
  })
  for (const occurrence of ordered) {
    if ((locks[week] ?? []).includes(occurrence.key)) continue
    generated[occurrence.key] = []
    const days = coveredDays(occurrence)
    while (generated[occurrence.key].length < occurrence.shift.requiredWorkers) {
      const rotation = occurrence.shift.grouping ? groupedRotation(occurrence, workers, shifts, schedule) : null
      const eligible = workers
        .filter((worker) => !generated[occurrence.key].includes(worker.id))
        .filter((worker) => !rotation || rotation.waiting.has(worker.id))
        .filter((worker) => occurrence.shift.grouping || !worker.manualNightOnly || shiftPeriod(occurrence.shift) !== 'night')
        .filter((worker) => assignmentConflict(worker, occurrence, shifts, schedule) === null)
        .sort((a, b) => {
          const preferredA = days.some((day) => a.preferredDays.includes(day)) ? 0 : 1
          const preferredB = days.some((day) => b.preferredDays.includes(day)) ? 0 : 1
          const loadDifference = rotation
            ? (rotation.lastTurn.get(a.id) ?? Number.MIN_SAFE_INTEGER) - (rotation.lastTurn.get(b.id) ?? Number.MIN_SAFE_INTEGER)
            : ((history.get(a.id) ?? 0) + (ordinaryCounts.get(a.id) ?? 0)) -
              ((history.get(b.id) ?? 0) + (ordinaryCounts.get(b.id) ?? 0))
          return loadDifference ||
            preferenceRank(a, occurrence.shift) - preferenceRank(b, occurrence.shift) ||
            preferredA - preferredB ||
            (ordinaryCounts.get(a.id) ?? 0) - (ordinaryCounts.get(b.id) ?? 0) ||
            a.name.localeCompare(b.name, 'he') || a.id.localeCompare(b.id)
        })
      const selected = eligible[0]
      if (!selected) break
      generated[occurrence.key].push(selected.id)
      if (!occurrence.shift.grouping) ordinaryCounts.set(selected.id, (ordinaryCounts.get(selected.id) ?? 0) + 1)
    }
  }
  return generated
}
