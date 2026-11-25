export type DailyStatus = {
  label: string
  color: string
  blocksShifts: boolean
  note: string
  requestId?: string
}

export type DailyStatuses = Record<string, Record<string, DailyStatus>>
export type StatusDefinition = DailyStatus & { id: string }

export const SHIFT_COLORS = {
  day: '#ccffff',
  night: '#ffcf00',
  grouped: '#30c5c8',
  rest: '#abe88b',
}

export const STATUS_PRESETS: StatusDefinition[] = [
  { id: 'rest', label: 'אפטר', color: SHIFT_COLORS.rest, blocksShifts: true, note: '' },
  { id: 'holiday', label: 'חג', color: '#ffd9df', blocksShifts: true, note: '' },
  { id: 'course', label: 'קורס', color: '#af89ef', blocksShifts: true, note: '' },
  { id: 'referral', label: 'הפנייה', color: '#fff48a', blocksShifts: true, note: '' },
  { id: 'constraint', label: 'אילוץ', color: '#ff9999', blocksShifts: true, note: '' },
  { id: 'abroad', label: 'חו״ל', color: '#ee65e7', blocksShifts: true, note: '' },
  { id: 'company', label: 'חבירה', color: '#bdbdbd', blocksShifts: false, note: '' },
  { id: 'leave', label: 'חופש', color: '#ad86f5', blocksShifts: true, note: '' },
]

export const BUILTIN_STATUSES: StatusDefinition[] = [
  { id: 'day', label: 'יום', color: SHIFT_COLORS.day, blocksShifts: false, note: '' },
  { id: 'night', label: 'לילה', color: SHIFT_COLORS.night, blocksShifts: false, note: '' },
  { id: 'grouped', label: 'שבת', color: SHIFT_COLORS.grouped, blocksShifts: false, note: '' },
  ...STATUS_PRESETS,
]

export function customStatusError(status: DailyStatus, existing: StatusDefinition[]): string | null {
  if (!status.label.trim()) return 'יש להזין שם לסטטוס.'
  if ([...BUILTIN_STATUSES, ...existing].some((item) => item.label.trim().toLocaleLowerCase() === status.label.trim().toLocaleLowerCase())) {
    return 'כבר קיים סטטוס בשם זה. בחר שם אחר.'
  }
  if (!/^#[\da-f]{6}$/i.test(status.color)) return 'יש לבחור צבע תקין.'
  return null
}

export function isCustomStatuses(value: unknown): value is StatusDefinition[] {
  if (!Array.isArray(value)) return false
  const ids = new Set(BUILTIN_STATUSES.map((item) => item.id))
  const labels = new Set(BUILTIN_STATUSES.map((item) => item.label.toLocaleLowerCase()))
  return value.every((status) => {
    if (!isDailyStatus(status) || !('id' in status) || typeof status.id !== 'string' || !status.id.trim()) return false
    const label = status.label.trim().toLocaleLowerCase()
    if (ids.has(status.id) || labels.has(label)) return false
    ids.add(status.id)
    labels.add(label)
    return true
  })
}

export function updateDailyStatus(
  statuses: DailyStatuses, date: string, workerId: string, status: DailyStatus | null,
): DailyStatuses {
  const updated = { ...statuses, [date]: { ...statuses[date] } }
  if (status) updated[date][workerId] = { ...status }
  else delete updated[date][workerId]
  if (Object.keys(updated[date]).length === 0) delete updated[date]
  return updated
}

export function updateDailyStatusRange(
  statuses: DailyStatuses, start: string, end: string, workerId: string, status: DailyStatus | null,
  validate: (date: string) => string | null,
): { statuses: DailyStatuses; error: null } | { error: string } {
  const first = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  if (![start, end].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
    !Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) ||
    first.toISOString().slice(0, 10) !== start || last.toISOString().slice(0, 10) !== end || end < start) {
    return { error: 'יש לבחור תאריך סיום תקין שאינו לפני תאריך ההתחלה.' }
  }
  const dates: string[] = []
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10)
    if (statuses[date]?.[workerId]?.requestId) {
      return { error: `${date}: סטטוס זה נוצר מבקשה מאושרת ואינו ניתן לשינוי.` }
    }
    const error = validate(date)
    if (error) return { error: `${date}: ${error}` }
    dates.push(date)
  }
  const updated = { ...statuses }
  for (const date of dates) {
    updated[date] = { ...statuses[date] }
    if (status) updated[date][workerId] = { ...status }
    else delete updated[date][workerId]
    if (Object.keys(updated[date]).length === 0) delete updated[date]
  }
  return { statuses: updated, error: null }
}

export function migrateDailyStatuses(statuses: DailyStatuses): DailyStatuses {
  return Object.fromEntries(Object.entries(statuses).map(([date, workers]) => [
    date, Object.fromEntries(Object.entries(workers).map(([id, status]) => [
      id, status.label === 'חברה' && (!('id' in status) || status.id === 'company')
        ? { ...status, label: 'חבירה' }
        : status,
    ])),
  ]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDailyStatus(status: unknown): status is DailyStatus {
  return isRecord(status) &&
    typeof status.label === 'string' && status.label.trim().length > 0 &&
    typeof status.color === 'string' && /^#[\da-f]{6}$/i.test(status.color) &&
    typeof status.blocksShifts === 'boolean' && typeof status.note === 'string' &&
    (status.requestId === undefined || (typeof status.requestId === 'string' && status.requestId.length > 0))
}

export function isDailyStatuses(value: unknown): value is DailyStatuses {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([date, workers]) => {
    const parsed = new Date(`${date}T00:00:00Z`)
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === date && isRecord(workers) &&
      Object.values(workers).every(isDailyStatus)
  })
}

export function textColor(background: string) {
  const rgb = [1, 3, 5].map((offset) => {
    const channel = parseInt(background.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#172033' : '#ffffff'
}
