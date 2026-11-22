import { STATUS_PRESETS } from './daily-status.ts'
import type { DailyStatus } from './daily-status'
import { shiftPeriod, weekOccurrences } from './scheduling.ts'
import type { ShiftTemplate } from './scheduling'

export const REQUEST_LABELS = {
  constraint: 'אילוץ',
  holiday: 'חג',
  leave: 'חופש',
  day_shift: 'משמרת יום',
  night_shift: 'משמרת לילה',
  custom: 'סטטוס מותאם',
}
export type RequestKind = keyof typeof REQUEST_LABELS
type StatusRequest = { kind: RequestKind; custom_status: DailyStatus | null }

export function isRequestKind(value: string): value is RequestKind {
  return Object.hasOwn(REQUEST_LABELS, value)
}

export function isShiftRequest(kind: RequestKind) {
  return kind === 'day_shift' || kind === 'night_shift'
}

export function requestLabel(request: StatusRequest) {
  return request.kind === 'custom' ? requestStatus(request)?.label : REQUEST_LABELS[request.kind]
}

export function requestStatus(request: StatusRequest): DailyStatus | null {
  if (isShiftRequest(request.kind)) return null
  if (request.kind === 'custom') {
    if (!request.custom_status) throw new Error('חסר סטטוס מותאם לבקשה.')
    return { ...request.custom_status }
  }
  const preset = STATUS_PRESETS.find((status) => status.id === request.kind)
  if (!preset) throw new Error('סוג בקשה אינו תקין.')
  return { label: preset.label, color: preset.color, blocksShifts: preset.blocksShifts, note: '' }
}

export function matchingRequestShifts(date: string, kind: RequestKind, shifts: ShiftTemplate[]) {
  if (!isShiftRequest(kind)) return []
  const start = new Date(`${date}T00:00:00Z`)
  const day = start.getUTCDay()
  start.setUTCDate(start.getUTCDate() - day)
  const week = start.toISOString().slice(0, 10)
  return weekOccurrences(week, shifts).filter((occurrence) => occurrence.day === day && !occurrence.shift.grouping &&
    shiftPeriod(occurrence.shift) === (kind === 'day_shift' ? 'day' : 'night'))
}
