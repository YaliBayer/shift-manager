import { BUILTIN_STATUSES, isCustomStatuses, SHIFT_COLORS } from './daily-status.ts'
import type { StatusDefinition } from './daily-status'
import { shiftPeriod } from './scheduling.ts'
import type { ShiftTemplate } from './scheduling'

export function shiftAppearance(shift: ShiftTemplate, customStatuses: StatusDefinition[]) {
  const selected = [...BUILTIN_STATUSES, ...customStatuses].find((item) => item.id === shift.statusId)
  if (selected) return { label: selected.label, color: selected.color }
  if (shift.grouping) return { label: 'שבת', color: SHIFT_COLORS.grouped }
  const period = shiftPeriod(shift)
  return { label: period === 'night' ? 'לילה' : 'יום', color: SHIFT_COLORS[period] }
}

export function isShiftStatusConfiguration(shifts: unknown, customStatuses: unknown = []): boolean {
  if (!isCustomStatuses(customStatuses) || !Array.isArray(shifts)) return false
  const ids = new Set([...BUILTIN_STATUSES, ...customStatuses].map((item) => item.id))
  return shifts.every((shift) => shift && typeof shift === 'object' &&
    (shift.statusId === undefined || (typeof shift.statusId === 'string' && ids.has(shift.statusId))))
}
