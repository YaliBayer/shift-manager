import { isCustomStatuses, isDailyStatuses, migrateDailyStatuses } from './daily-status.ts'
import type { DailyStatuses, StatusDefinition } from './daily-status'
import { isShiftStatusConfiguration } from './shift-status.ts'
import { protectExistingAssignments } from './scheduling.ts'
import type { AssignmentsByWeek, LockedSlotsByWeek, ShiftTemplate, Worker } from './scheduling'

export type ScheduleData = {
  workers: Worker[]
  shifts: ShiftTemplate[]
  assignments: AssignmentsByWeek
  lockedSlots: LockedSlotsByWeek
  dailyStatuses: DailyStatuses
  customStatuses: StatusDefinition[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function days(value: unknown) {
  return Array.isArray(value) && value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isWorker(value: unknown): value is Worker {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.name === 'string' && typeof value.role === 'string' && typeof value.phone === 'string' &&
    typeof value.maxShifts === 'number' && Number.isInteger(value.maxShifts) && value.maxShifts > 0 &&
    days(value.excludedDays) && days(value.preferredDays)
}

function isShift(value: unknown): value is ShiftTemplate {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.name === 'string' && typeof value.start === 'string' && time.test(value.start) &&
    typeof value.end === 'string' && time.test(value.end) &&
    typeof value.requiredWorkers === 'number' && Number.isInteger(value.requiredWorkers) && value.requiredWorkers > 0 &&
    days(value.activeDays) && (value.eligibleWorkerIds === undefined || strings(value.eligibleWorkerIds)) &&
    (value.grouping === undefined || (isRecord(value.grouping) && days([value.grouping.startDay, value.grouping.endDay]))) &&
    (value.period === undefined || value.period === 'day' || value.period === 'night')
}

function isAssignments(value: unknown): value is AssignmentsByWeek {
  return isRecord(value) && Object.entries(value).every(([week, slots]) => {
    const date = new Date(`${week}T00:00:00Z`)
    return /^\d{4}-\d{2}-\d{2}$/.test(week) && Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === week && date.getUTCDay() === 0 &&
      isRecord(slots) && Object.entries(slots).every(([key, ids]) => /^[0-6]:.+$/.test(key) && strings(ids))
  })
}

export function parseScheduleData(value: unknown): ScheduleData {
  if (!isRecord(value) || !Array.isArray(value.workers) || !value.workers.every(isWorker) ||
    !Array.isArray(value.shifts) || !value.shifts.every(isShift) || !isAssignments(value.assignments) ||
    !isShiftStatusConfiguration(value.shifts, value.customStatuses)) {
    throw new Error('נתוני הסידור אינם תקינים. לא בוצע שינוי.')
  }
  const dailyStatuses = value.dailyStatuses === undefined ? {} : value.dailyStatuses
  const customStatuses = value.customStatuses === undefined ? [] : value.customStatuses
  const lockedSlots = value.lockedSlots === undefined ? protectExistingAssignments(value.assignments) : value.lockedSlots
  if (!isDailyStatuses(dailyStatuses) || !isCustomStatuses(customStatuses) || !isRecord(lockedSlots)) {
    throw new Error('נתוני הסטטוסים או הנעילות אינם תקינים.')
  }
  const validatedLocks: LockedSlotsByWeek = {}
  for (const [week, keys] of Object.entries(lockedSlots)) {
    if (!strings(keys)) throw new Error('נתוני הנעילות אינם תקינים.')
    validatedLocks[week] = keys
  }
  return {
    workers: value.workers,
    shifts: value.shifts,
    assignments: value.assignments,
    lockedSlots: validatedLocks,
    dailyStatuses: migrateDailyStatuses(dailyStatuses),
    customStatuses,
  }
}
