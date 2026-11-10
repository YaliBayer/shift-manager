import { useEffect, useMemo, useRef, useState } from 'react'
import {
  assignmentConflict,
  createOccurrence,
  generateWeek,
  isWorkerEligible,
  occursOnDay,
  protectExistingAssignments,
  protectedAssignmentProblems,
  removeRestrictedAssignments,
  removeIneligibleShiftAssignments,
  shiftPeriod as classifyShiftPeriod,
  startDays,
  visibleOccurrences,
  weekOccurrences,
} from './scheduling'
import type { AssignmentsByWeek, DayIndex, LockedSlotsByWeek, ShiftOccurrence, ShiftTemplate, Worker } from './scheduling'
import './App.css'

type Tab = 'schedule' | 'workers' | 'shifts'

const DAY_NAMES = ['יום א׳', 'יום ב׳', 'יום ג׳', 'יום ד׳', 'יום ה׳', 'יום ו׳', 'שבת']
const STORAGE_KEY = 'shift-manager-data-v1'
const PERIOD_LABELS = { day: 'יום', night: 'לילה' }
const PREFERENCE_LABELS = { none: 'ללא העדפה', day: 'מעדיף משמרות יום', night: 'מעדיף משמרות לילה' }

const initialWorkers: Worker[] = [
  {
    id: crypto.randomUUID(),
    name: 'נועה לוי',
    role: 'אחראית משמרת',
    phone: '050-1234567',
    maxShifts: 5,
    excludedDays: [5],
    preferredDays: [0, 2],
  },
  {
    id: crypto.randomUUID(),
    name: 'דניאל כהן',
    role: 'עובד',
    phone: '052-7654321',
    maxShifts: 4,
    excludedDays: [6],
    preferredDays: [1, 3],
  },
  {
    id: crypto.randomUUID(),
    name: 'מאיה ישראלי',
    role: 'עובדת',
    phone: '054-5551234',
    maxShifts: 5,
    excludedDays: [0],
    preferredDays: [4, 5],
  },
]

const initialShifts: ShiftTemplate[] = [
  {
    id: crypto.randomUUID(),
    name: 'בוקר',
    start: '08:00',
    end: '16:00',
    requiredWorkers: 2,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
  },
  {
    id: crypto.randomUUID(),
    name: 'ערב',
    start: '16:00',
    end: '00:00',
    requiredWorkers: 2,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
  },
]

function getSunday(date = new Date()) {
  const result = new Date(date)
  result.setHours(12, 0, 0, 0)
  result.setDate(result.getDate() - result.getDay())
  return result
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' }).format(date)
}

function formatFullDate(date: Date) {
  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function getWeekDays(weekKey: string) {
  const [year, month, day] = weekKey.split('-').map(Number)
  const start = new Date(year, month - 1, day, 12)
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function shiftPeriod(shift: ShiftTemplate) {
  if (!shift.grouping) return `${shift.start}–${shift.end}`
  return `${DAY_NAMES[shift.grouping.startDay]} ${shift.start} — ${DAY_NAMES[shift.grouping.endDay]} ${shift.end}`
}

function App() {
  const stored = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    } catch {
      return null
    }
  }, [])

  const [workers, setWorkers] = useState<Worker[]>(stored?.workers ?? initialWorkers)
  const [shifts, setShifts] = useState<ShiftTemplate[]>(stored?.shifts ?? initialShifts)
  const [assignments, setAssignments] = useState<AssignmentsByWeek>(stored?.assignments ?? {})
  const [lockedSlots, setLockedSlots] = useState<LockedSlotsByWeek>(
    stored?.lockedSlots ?? protectExistingAssignments(stored?.assignments ?? {}),
  )
  const [weekStart, setWeekStart] = useState(toDateKey(getSunday()))
  const [tab, setTab] = useState<Tab>('schedule')
  const [editingWorker, setEditingWorker] = useState<Worker | null>(null)
  const [editingShift, setEditingShift] = useState<ShiftTemplate | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const importRef = useRef<HTMLInputElement>(null)

  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart])
  const currentAssignments = assignments[weekStart] ?? {}
  const displayedOccurrences = visibleOccurrences(weekStart, shifts, assignments)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ workers, shifts, assignments, lockedSlots }))
  }, [workers, shifts, assignments, lockedSlots])

  useEffect(() => {
    if (!notice && !error) return
    const timer = window.setTimeout(() => {
      setNotice('')
      setError('')
    }, 3500)
    return () => window.clearTimeout(timer)
  }, [notice, error])

  function moveWeek(direction: number) {
    const date = getWeekDays(weekStart)[0]
    date.setDate(date.getDate() + direction * 7)
    setWeekStart(toDateKey(date))
  }

  function updateWeekDate(value: string) {
    if (!value) return
    const [year, month, day] = value.split('-').map(Number)
    setWeekStart(toDateKey(getSunday(new Date(year, month - 1, day, 12))))
  }

  function saveWorker(worker: Worker) {
    if (worker.allowGroupedShifts === false || worker.groupedOnly || worker.allowNightShifts === false) {
      const cleaned = removeRestrictedAssignments(worker, shifts, assignments)
      const hasRemovedAssignments = Object.entries(assignments).some(([week, slots]) =>
        Object.entries(slots).some(([key, ids]) => ids.length !== cleaned[week][key].length),
      )
      if (hasRemovedAssignments && !window.confirm('שינוי ההרשאות יסיר את העובד מהמשמרות שאינן מותרות לו בכל השבועות, כולל שיבוצים מוגנים והיסטוריה. שיבוצים מותרים יישארו ללא שינוי. להמשיך?')) return
      if (hasRemovedAssignments) setAssignments(cleaned)
    }
    setWorkers((current) => {
      const exists = current.some((item) => item.id === worker.id)
      return exists ? current.map((item) => (item.id === worker.id ? worker : item)) : [...current, worker]
    })
    setEditingWorker(null)
    setNotice('פרטי העובד נשמרו')
  }

  function removeWorker(workerId: string) {
    if (!window.confirm('למחוק את העובד ואת כל השיבוצים שלו?')) return
    setWorkers((current) => current.filter((worker) => worker.id !== workerId))
    setShifts((current) => current.map((shift) => shift.eligibleWorkerIds === undefined
      ? shift
      : { ...shift, eligibleWorkerIds: shift.eligibleWorkerIds.filter((id) => id !== workerId) },
    ))
    setAssignments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([week, weekAssignments]) => [
          week,
          Object.fromEntries(
            Object.entries(weekAssignments).map(([key, ids]) => [
              key,
              ids.filter((id) => id !== workerId),
            ]),
          ),
        ]),
      ),
    )
  }

  function saveShift(shift: ShiftTemplate) {
    const previous = shifts.find((item) => item.id === shift.id)
    const schedulingChanged = previous && (
      previous.start !== shift.start ||
      previous.end !== shift.end ||
      previous.requiredWorkers !== shift.requiredWorkers ||
      JSON.stringify(previous.grouping) !== JSON.stringify(shift.grouping) ||
      JSON.stringify([...startDays(previous)].sort()) !== JSON.stringify([...startDays(shift)].sort())
    )
    if (schedulingChanged) {
      const hasAssignments = Object.values(assignments).some((week) =>
        Object.entries(week).some(([key, ids]) => key.endsWith(`:${shift.id}`) && ids.length > 0),
      )
      if (hasAssignments && !window.confirm('שינוי הימים, השעות או כוח האדם ימחק את שיבוצי המשמרת בכל השבועות, כולל שיבוצים מוגנים והיסטוריה המשמשת לאיזון ולתור שבת. להמשיך?')) return
      setAssignments((current) => Object.fromEntries(
        Object.entries(current).map(([week, slots]) => [
          week,
          Object.fromEntries(Object.entries(slots).filter(([key]) => !key.endsWith(`:${shift.id}`))),
        ]),
      ))
      removeShiftLocks(shift.id)
    } else {
      const cleaned = removeIneligibleShiftAssignments(shift, assignments)
      const hasRemovedAssignments = Object.entries(assignments).some(([week, slots]) =>
        Object.entries(slots).some(([key, ids]) => ids.length !== cleaned[week][key].length),
      )
      if (hasRemovedAssignments && !window.confirm('שינוי רשימת העובדים יסיר מהמשמרת עובדים שאינם מורשים עוד בכל השבועות, כולל שיבוצים מוגנים והיסטוריה. העובדים שנותרו מורשים והנעילות יישמרו. להמשיך?')) return
      if (hasRemovedAssignments) setAssignments(cleaned)
    }
    setShifts((current) => {
      const exists = current.some((item) => item.id === shift.id)
      return exists ? current.map((item) => (item.id === shift.id ? shift : item)) : [...current, shift]
    })
    setEditingShift(null)
    setNotice('הגדרת המשמרת נשמרה')
  }

  function removeShift(shiftId: string) {
    if (!window.confirm('למחוק את המשמרת ואת כל השיבוצים שלה?')) return
    setShifts((current) => current.filter((shift) => shift.id !== shiftId))
    setAssignments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([week, weekAssignments]) => [
          week,
          Object.fromEntries(
            Object.entries(weekAssignments).filter(([key]) => !key.endsWith(`:${shiftId}`)),
          ),
        ]),
      ),
    )
    removeShiftLocks(shiftId)
  }

  function removeShiftLocks(shiftId: string) {
    setLockedSlots((current) => Object.fromEntries(Object.entries(current).map(([week, keys]) => [
      week, keys.filter((key) => !key.endsWith(`:${shiftId}`)),
    ])))
  }

  function setSlotLock({ week, key }: ShiftOccurrence, locked: boolean) {
    if (locked) {
      setAssignments((current) => ({
        ...current,
        [week]: { ...(current[week] ?? {}), [key]: current[week]?.[key] ?? [] },
      }))
    }
    setLockedSlots((current) => ({
      ...current,
      [week]: locked
        ? [...new Set([...(current[week] ?? []), key])]
        : (current[week] ?? []).filter((item) => item !== key),
    }))
  }

  function assignWorker(occurrence: ShiftOccurrence, workerId: string) {
    if (!workerId) return
    const { week, key, shift } = occurrence
    const assigned = assignments[week]?.[key] ?? []
    if (assigned.includes(workerId)) return
    if (assigned.length >= shift.requiredWorkers) {
      setError('המשמרת כבר מלאה. הסר עובד לפני הוספת עובד אחר.')
      return
    }

    const worker = workers.find((item) => item.id === workerId)
    if (!worker) {
      setError('העובד לא נמצא')
      return
    }
    const conflict = assignmentConflict(worker, occurrence, shifts, assignments)
    if (conflict) {
      const messages = {
        'worker-not-eligible': 'העובד אינו ברשימת העובדים המורשים למשמרת זו',
        'grouped-not-allowed': 'לעובד אין הרשאה למשמרות רצופות על פני מספר ימים',
        'grouped-only': 'העובד מורשה למשמרות שבת רצופות בלבד, ללא משמרות רגילות',
        'night-not-allowed': 'העובד אינו מורשה למשמרות לילה, גם לא בשיבוץ ידני',
        unavailable: 'העובד אינו זמין באחד הימים שהמשמרת מכסה',
        overlap: 'קיימת חפיפה עם שיבוץ אחר של העובד, כולל בשבוע סמוך',
        'rest-day': 'לא ניתן לשבץ: אחרי משמרת לילה או משמרת רצופה נדרשת מנוחה עד סוף יום הסיום, גם בשיבוץ ידני ובין שבועות.',
        limit: `${worker.name} כבר הגיע למכסת ${worker.maxShifts} המשמרות בשבוע תחילת המשמרת`,
      }
      setError(messages[conflict])
      return
    }

    setAssignments((current) => ({
      ...current,
      [week]: {
        ...(current[week] ?? {}),
        [key]: [...assigned, workerId],
      },
    }))
    setSlotLock(occurrence, true)
  }

  function unassignWorker({ week, key }: ShiftOccurrence, workerId: string) {
    setAssignments((current) => ({
      ...current,
      [week]: {
        ...(current[week] ?? {}),
        [key]: (current[week]?.[key] ?? []).filter((id) => id !== workerId),
      },
    }))
    setLockedSlots((current) => ({
      ...current,
      [week]: [...new Set([...(current[week] ?? []), key])],
    }))
  }

  function generateSchedule() {
    setError('')
    setNotice('')
    const problems = protectedAssignmentProblems(weekStart, workers, shifts, assignments, lockedSlots)
    if (problems.length) {
      setError('לא ניתן ליצור סידור: יש משמרות מוגנות שסותרות זמינות, הרשאות, מכסה, חפיפות או מנוחה אחרי משמרת. תקן אותן או שחרר את הנעילה. השיבוצים לא שונו.')
      return
    }
    const generated = generateWeek(weekStart, workers, shifts, assignments, lockedSlots)
    setAssignments((current) => ({ ...current, [weekStart]: generated }))
    const missing = shifts.reduce((total, shift) => {
      return (
        total +
        startDays(shift).reduce<number>((sum, day) => {
          const filled = generated[createOccurrence(weekStart, day, shift).key]?.length ?? 0
          return sum + Math.max(0, shift.requiredWorkers - filled)
        }, 0)
      )
    }, 0)
    if (missing > 0) setError(`הסידור נוצר ללא שינוי במשמרות מוגנות. חסרים ${missing} שיבוצים בגלל זמינות, מגבלות, נעילות או המתנה לתור שבת.`)
    else setNotice('סידור העבודה נוצר. המשמרות המוגנות נשמרו ללא שינוי.')
  }

  function clearWeek() {
    if (!window.confirm('למחוק את כל השיבוצים והנעילות שמתחילים השבוע, כולל ידניים? שינוי שבוע עבר משפיע על ההיסטוריה ותור שבת. המשכים מהשבוע הקודם יישארו ללא שינוי.')) return
    setAssignments((current) => ({ ...current, [weekStart]: {} }))
    setLockedSlots((current) => ({ ...current, [weekStart]: [] }))
  }

  function unlockWeek() {
    if (!window.confirm('לשחרר את כל המשמרות שמתחילות השבוע לשיבוץ אוטומטי? הסידור הנוכחי לא ישתנה עד להפעלת יצירת הסידור.')) return
    setLockedSlots((current) => ({ ...current, [weekStart]: [] }))
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ workers, shifts, assignments, lockedSlots }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `shift-manager-${toDateKey(new Date())}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function importData(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result))
        if (!Array.isArray(data.workers) || !Array.isArray(data.shifts) || !data.assignments) {
          throw new Error('Invalid data')
        }
        if (!data.shifts.every((shift: ShiftTemplate) =>
          shift.eligibleWorkerIds === undefined ||
          (Array.isArray(shift.eligibleWorkerIds) && shift.eligibleWorkerIds.every((id) => typeof id === 'string')),
        )) throw new Error('Invalid eligible workers')
        if (data.lockedSlots !== undefined && (
          !data.lockedSlots || typeof data.lockedSlots !== 'object' || Array.isArray(data.lockedSlots) ||
          !Object.values(data.lockedSlots).every((keys) => Array.isArray(keys) && keys.every((key) => typeof key === 'string'))
        )) throw new Error('Invalid locked slots')
        setWorkers(data.workers)
        setShifts(data.shifts)
        setAssignments(data.assignments)
        setLockedSlots(data.lockedSlots ?? protectExistingAssignments(data.assignments))
        setNotice('הנתונים יובאו בהצלחה')
      } catch {
        setError('הקובץ אינו קובץ גיבוי תקין')
      }
    }
    reader.readAsText(file)
  }

  const filledSlots = weekOccurrences(weekStart, shifts).reduce(
    (sum, occurrence) => sum + (currentAssignments[occurrence.key]?.length ?? 0), 0,
  )
  const neededSlots = shifts.reduce(
    (sum, shift) => sum + shift.requiredWorkers * startDays(shift).length,
    0,
  )

  return (
    <div className="app-shell" dir="rtl">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">ש</div>
          <div>
            <strong>משמרת</strong>
            <span>ניהול סידור עבודה חכם</span>
          </div>
        </div>
        <nav>
          <button className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>
            לוח משמרות
          </button>
          <button className={tab === 'workers' ? 'active' : ''} onClick={() => setTab('workers')}>
            עובדים
          </button>
          <button className={tab === 'shifts' ? 'active' : ''} onClick={() => setTab('shifts')}>
            הגדרות משמרות
          </button>
        </nav>
        <div className="header-actions">
          <button className="button ghost small" onClick={exportData}>ייצוא גיבוי</button>
          <button className="button ghost small" onClick={() => importRef.current?.click()}>ייבוא</button>
          <input
            ref={importRef}
            hidden
            type="file"
            accept="application/json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) importData(file)
              event.target.value = ''
            }}
          />
        </div>
      </header>

      <main>
        {tab === 'schedule' && (
          <>
            <section className="page-heading">
              <div>
                <span className="eyebrow">סידור שבועי</span>
                <h1>לוח המשמרות</h1>
                <p>שיבוץ אוטומטי לפי זמינות, העדפות ומכסת משמרות.</p>
              </div>
              <div className="heading-actions">
                <button className="button secondary" onClick={unlockWeek}>שחרור שבוע לאוטומטי</button>
                <button className="button secondary" onClick={clearWeek}>ניקוי שבוע</button>
                <button className="button primary" onClick={generateSchedule}>יצירת סידור אוטומטי</button>
              </div>
            </section>

            <section className="stats">
              <article>
                <span>עובדים פעילים</span>
                <strong>{workers.length}</strong>
                <small>זמינים לשיבוץ</small>
              </article>
              <article>
                <span>סוגי משמרות</span>
                <strong>{shifts.length}</strong>
                <small>תבניות מוגדרות</small>
              </article>
              <article>
                <span>שיבוצים שמתחילים השבוע</span>
                <strong>{filledSlots}<em> / {neededSlots}</em></strong>
                <small>{neededSlots ? Math.round((filledSlots / neededSlots) * 100) : 0}% השלמה</small>
              </article>
            </section>

            <section className="week-controls card">
              <button className="icon-button" onClick={() => moveWeek(1)} aria-label="השבוע הבא">‹</button>
              <div>
                <span>שבוע שמתחיל ביום ראשון</span>
                <strong>{formatFullDate(weekDays[0])} — {formatDate(weekDays[6])}</strong>
              </div>
              <input type="date" value={weekStart} onChange={(event) => updateWeekDate(event.target.value)} />
              <button className="icon-button" onClick={() => moveWeek(-1)} aria-label="השבוע הקודם">›</button>
            </section>

            <p className="grouped-help schedule-help">
              האיזון מתחשב במשמרות רגילות בארבעת השבועות הקודמים ובשבוע הנוכחי.
              במשמרות שבת רצופות אין חזרה על עובד לפני השלמת סבב של כל המורשים; כשאין מועמד זמין שנותר בסבב, המקום נשאר פנוי.
              אחרי משמרת לילה או משמרת רצופה אין שיבוץ נוסף ביום שבו היא מסתיימת; ניתן לחזור מחצות בתחילת היום הבא. הכלל מחייב גם שיבוץ ידני.
              <br />
              עריכה ידנית נועלת את המשמרת כולה, כולל מקומות ריקים. ניתן לשחרר אותה לאוטומטי בכפתור המשמרת.
              שיבוצים מגרסאות ישנות נשמרים כמוגנים. תור שבת ואיסור לילות אוטומטיים אינם מגבילים שיבוץ ידני; שאר המגבלות נשמרות.
            </p>
            <section className="schedule-grid">
              {weekDays.map((date, index) => {
                const day = index as DayIndex
                const activeOccurrences = displayedOccurrences.filter((occurrence) => occursOnDay(occurrence, weekStart, day))
                return (
                  <article className="day-card" key={toDateKey(date)}>
                    <header>
                      <div>
                        <strong>{DAY_NAMES[day]}</strong>
                        <span>{formatDate(date)}</span>
                      </div>
                      <em>{activeOccurrences.length} משמרות</em>
                    </header>
                    <div className="day-shifts">
                      {activeOccurrences.map((occurrence) => {
                        const { shift, week, key } = occurrence
                        const continuation = week !== weekStart || occurrence.day !== day
                        const assignedIds = assignments[week]?.[key] ?? []
                        const locked = (lockedSlots[week] ?? []).includes(key)
                        const openSpots = Math.max(0, shift.requiredWorkers - assignedIds.length)
                        const selectableWorkers = workers.filter((worker) =>
                          !assignedIds.includes(worker.id) && isWorkerEligible(shift, worker.id),
                        )
                        return (
                          <div className={`shift-block ${shift.grouping ? 'grouped-shift' : ''}`} key={`${week}:${key}`}>
                            <div className="shift-title">
                              <div>
                                <span className="shift-dot" />
                                <strong>{shift.name}</strong>
                              </div>
                              {!shift.grouping && <time>{shift.start}–{shift.end}</time>}
                            </div>
                            {shift.grouping && <p className="shift-period">{shiftPeriod(shift)}</p>}
                            {shift.eligibleWorkerIds !== undefined && <p className="shift-period">עובדים נבחרים בלבד</p>}
                            <button
                              className={`slot-lock ${locked ? 'locked' : ''}`}
                              aria-pressed={locked}
                              onClick={() => setSlotLock(occurrence, !locked)}
                            >{locked ? 'מוגן · שחרור לאוטומטי' : 'נעילת המשמרת לאוטומטי'}</button>
                            {(shift.grouping || continuation) && (
                              <p className="shift-continuation">
                                {continuation
                                  ? `המשך משמרת מ־${formatDate(getWeekDays(week)[occurrence.day])}`
                                  : 'משמרת רצופה · אותם עובדים בכל הימים'}
                                <span>שינוי שיבוץ חל על כל המשמרת</span>
                              </p>
                            )}
                            <div className="assigned-list">
                              {assignedIds.map((workerId) => {
                                const worker = workers.find((item) => item.id === workerId)
                                if (!worker) return null
                                return (
                                  <div className="assigned-worker" key={workerId}>
                                    <span className="avatar">{worker.name.charAt(0)}</span>
                                    <div><strong>{worker.name}</strong><small>{worker.role}</small></div>
                                    <button
                                      onClick={() => unassignWorker(occurrence, workerId)}
                                      aria-label={`הסרת ${worker.name}`}
                                    >×</button>
                                  </div>
                                )
                              })}
                            </div>
                            {openSpots > 0 && (
                              <select
                                value=""
                                disabled={selectableWorkers.length === 0}
                                onChange={(event) => assignWorker(occurrence, event.target.value)}
                                aria-label={`הוספת עובד למשמרת ${shift.name}`}
                              >
                                <option value="">{selectableWorkers.length ? `+ הוספת עובד (${openSpots} חסרים)` : `אין עובדים נוספים מורשים (${openSpots} חסרים)`}</option>
                                {selectableWorkers
                                  .map((worker) => (
                                    <option key={worker.id} value={worker.id}>{worker.name}</option>
                                  ))}
                              </select>
                            )}
                            {openSpots === 0 && <span className="full-badge">המשמרת מלאה</span>}
                          </div>
                        )
                      })}
                      {activeOccurrences.length === 0 && <p className="empty-day">אין משמרות ביום זה</p>}
                    </div>
                  </article>
                )
              })}
            </section>
          </>
        )}

        {tab === 'workers' && (
          <>
            <section className="page-heading">
              <div>
                <span className="eyebrow">הצוות שלך</span>
                <h1>ניהול עובדים</h1>
                <p>הוספת עובדים, הגדרת זמינות, העדפות ומכסת משמרות.</p>
              </div>
              <button
                className="button primary"
                onClick={() =>
                  setEditingWorker({
                    id: crypto.randomUUID(),
                    name: '',
                    role: '',
                    phone: '',
                    maxShifts: 5,
                    excludedDays: [],
                    preferredDays: [],
                  })
                }
              >+ הוספת עובד</button>
            </section>
            <section className="management-grid">
              {workers.map((worker) => (
                <article className="worker-card card" key={worker.id}>
                  <div className="worker-card-header">
                    <span className="avatar large">{worker.name.charAt(0)}</span>
                    <div><h3>{worker.name}</h3><p>{worker.role || 'ללא תפקיד'}</p></div>
                    <div className="card-actions">
                      <button onClick={() => setEditingWorker(worker)}>עריכה</button>
                      <button className="danger" onClick={() => removeWorker(worker.id)}>מחיקה</button>
                    </div>
                  </div>
                  <dl>
                    <div><dt>טלפון</dt><dd>{worker.phone || 'לא הוגדר'}</dd></div>
                    <div><dt>מקסימום בשבוע</dt><dd>{worker.maxShifts} משמרות</dd></div>
                    <div><dt>העדפת משמרת</dt><dd>{PREFERENCE_LABELS[worker.shiftPreference ?? 'none']}</dd></div>
                    <div><dt>משמרות רצופות</dt><dd>{worker.allowGroupedShifts === false ? 'לא מורשה' : 'מורשה'}</dd></div>
                    <div><dt>סוגי שיבוץ מותרים</dt><dd>{worker.groupedOnly ? 'שבת רצופה בלבד' : 'רגילות ושבת לפי הרשאה'}</dd></div>
                    <div><dt>משמרות לילה</dt><dd>{worker.allowNightShifts === false ? 'לא מורשה, גם לא ידנית' : worker.manualNightOnly ? 'שיבוץ ידני בלבד' : 'שיבוץ אוטומטי מותר'}</dd></div>
                  </dl>
                  <div className="availability-row">
                    <span>ימים מועדפים</span>
                    <div>{worker.preferredDays.length ? worker.preferredDays.map((day) => <b className="preferred" key={day}>{DAY_NAMES[day]}</b>) : <i>לא הוגדרו</i>}</div>
                  </div>
                  <div className="availability-row">
                    <span>ימים לא זמינים</span>
                    <div>{worker.excludedDays.length ? worker.excludedDays.map((day) => <b className="excluded" key={day}>{DAY_NAMES[day]}</b>) : <i>זמין בכל השבוע</i>}</div>
                  </div>
                </article>
              ))}
            </section>
          </>
        )}

        {tab === 'shifts' && (
          <>
            <section className="page-heading">
              <div>
                <span className="eyebrow">מבנה יום העבודה</span>
                <h1>הגדרות משמרות</h1>
                <p>קביעת מספר המשמרות, שעות הפעילות וכמות העובדים הנדרשת.</p>
              </div>
              <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => setEditingShift({
                  id: crypto.randomUUID(),
                  name: 'שבת',
                  start: '18:00',
                  end: '09:00',
                  requiredWorkers: 1,
                  activeDays: [4],
                  grouping: { startDay: 4, endDay: 0 },
                })}
              >+ משמרת שבת רצופה</button>
              <button
                className="button primary"
                onClick={() =>
                  setEditingShift({
                    id: crypto.randomUUID(),
                    name: '',
                    start: '08:00',
                    end: '16:00',
                    requiredWorkers: 1,
                    activeDays: [0, 1, 2, 3, 4],
                  })
                }
              >+ הוספת משמרת</button>
              </div>
            </section>
            <section className="shift-settings-list">
              {shifts.map((shift, index) => (
                <article className="shift-setting-card card" key={shift.id}>
                  <div className="shift-index">{index + 1}</div>
                  <div className="shift-main">
                    <span>שם המשמרת</span>
                    <strong>{shift.name}</strong>
                    {!shift.grouping && <span>סיווג: {PERIOD_LABELS[classifyShiftPeriod(shift)]}</span>}
                    <span>{shift.eligibleWorkerIds === undefined
                      ? 'עובדים: ללא הגבלת רשימה'
                      : `עובדים מורשים: ${workers.filter((worker) => isWorkerEligible(shift, worker.id)).map((worker) => worker.name).join(', ') || 'לא נבחרו עובדים'}`}</span>
                  </div>
                  <div><span>{shift.grouping ? 'תקופה רצופה' : 'שעות'}</span><strong>{shiftPeriod(shift)}</strong></div>
                  <div><span>כוח אדם נדרש</span><strong>{shift.requiredWorkers} עובדים</strong></div>
                  <div className="active-days">
                    <span>{shift.grouping ? 'תחילת המשמרת' : 'ימים פעילים'}</span>
                    <div>{startDays(shift).map((day) => <b key={day}>{DAY_NAMES[day]}</b>)}</div>
                    {shift.grouping && <small>משמרת אחת בשבוע · צוות קבוע</small>}
                  </div>
                  <div className="card-actions">
                    <button onClick={() => setEditingShift(shift)}>עריכה</button>
                    <button className="danger" onClick={() => removeShift(shift.id)}>מחיקה</button>
                  </div>
                </article>
              ))}
            </section>
          </>
        )}
      </main>

      {(notice || error) && <div role={error ? 'alert' : 'status'} className={`toast ${error ? 'error' : ''}`}>{error || notice}</div>}
      {editingWorker && (
        <WorkerModal
          worker={editingWorker}
          onSave={saveWorker}
          onClose={() => setEditingWorker(null)}
        />
      )}
      {editingShift && (
        <ShiftModal
          shift={editingShift}
          workers={workers}
          onSave={saveShift}
          onClose={() => setEditingShift(null)}
        />
      )}
    </div>
  )
}

function WorkerModal({
  worker,
  onSave,
  onClose,
}: {
  worker: Worker
  onSave: (worker: Worker) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(worker)

  function toggleDay(field: 'excludedDays' | 'preferredDays', day: DayIndex) {
    setDraft((current) => {
      const otherField = field === 'excludedDays' ? 'preferredDays' : 'excludedDays'
      const values = current[field].includes(day)
        ? current[field].filter((value) => value !== day)
        : [...current[field], day]
      return { ...current, [field]: values, [otherField]: current[otherField].filter((value) => value !== day) }
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault()
          onSave({ ...draft, name: draft.name.trim(), role: draft.role.trim(), phone: draft.phone.trim() })
        }}
      >
        <div className="modal-header"><div><span>פרטי עובד</span><h2>{worker.name ? 'עריכת עובד' : 'הוספת עובד חדש'}</h2></div><button type="button" onClick={onClose}>×</button></div>
        <div className="form-grid">
          <label><span>שם מלא</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="לדוגמה: ישראל ישראלי" /></label>
          <label><span>תפקיד</span><input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="לדוגמה: אחראי משמרת" /></label>
          <label><span>טלפון</span><input value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} placeholder="050-0000000" /></label>
          <label><span>מקסימום משמרות בשבוע</span><input min="1" max="14" required type="number" value={draft.maxShifts} onChange={(event) => setDraft({ ...draft, maxShifts: Number(event.target.value) })} /></label>
          <label>
            <span>סוגי שיבוץ מותרים</span>
            <select value={draft.groupedOnly ? 'grouped' : 'all'} onChange={(event) => {
              const groupedOnly = event.target.value === 'grouped'
              setDraft({ ...draft, groupedOnly, allowGroupedShifts: groupedOnly ? true : draft.allowGroupedShifts })
            }}>
              <option value="all">משמרות רגילות ושבת לפי הרשאה</option>
              <option value="grouped">משמרות שבת רצופות בלבד, ללא רגילות</option>
            </select>
          </label>
          <label>
            <span>שיבוץ במשמרות לילה רגילות</span>
            <select value={draft.allowNightShifts === false ? 'never' : draft.manualNightOnly ? 'manual' : 'auto'} onChange={(event) => setDraft({
              ...draft,
              manualNightOnly: event.target.value === 'manual',
              allowNightShifts: event.target.value !== 'never',
            })}>
              <option value="auto">מותר בשיבוץ אוטומטי</option>
              <option value="manual">אסור אוטומטית; מותר בשיבוץ ידני בלבד</option>
              <option value="never">לא מורשה למשמרות לילה, גם לא ידנית</option>
            </select>
          </label>
          <label>
            <span>העדפת משמרת</span>
            <select value={draft.shiftPreference ?? 'none'} onChange={(event) => {
              const value = event.target.value
              if (value === 'none' || value === 'day' || value === 'night') {
                setDraft({ ...draft, shiftPreference: value })
              }
            }}>
              <option value="none">ללא העדפה</option>
              <option value="day">מעדיף משמרות יום</option>
              <option value="night">מעדיף משמרות לילה</option>
            </select>
          </label>
          <label>
            <span>הרשאה למשמרות רצופות</span>
            <select value={draft.allowGroupedShifts === false ? 'no' : 'yes'} onChange={(event) => setDraft({
              ...draft, allowGroupedShifts: event.target.value === 'yes',
            })}>
              <option value="yes">מורשה למשמרות רצופות על פני מספר ימים</option>
              <option value="no" disabled={draft.groupedOnly}>לא מורשה למשמרות רצופות</option>
            </select>
          </label>
        </div>
        <p className="grouped-help">
          בשיבוץ רגיל ניתנת עדיפות לעומס נמוך בארבעת השבועות הקודמים ובשבוע הנוכחי, ואחריו לסוג המשמרת ולימים המועדפים.
          זו העדפה בלבד: אפשר לשבץ גם בסוג האחר, אוטומטית או ידנית.
          משמרות שבת הן המשמרות הרצופות על פני מספר ימים. הן תלויות בהרשאה הנפרדת ובתור שבת, ללא קשר להעדפת יום או לילה.
          הגדרות הלילה חלות על משמרות לילה רגילות, ולא על שבת רצופה.
          ״לא מורשה״ חוסם גם שיבוץ ידני; ״ידני בלבד״ מאפשר שיבוץ ידני מוגן.
        </p>
        <DayPicker title="ימים מועדפים" description="המערכת תנסה לשבץ את העובד בימים אלו." selected={draft.preferredDays} tone="preferred" onToggle={(day) => toggleDay('preferredDays', day)} />
        <DayPicker title="ימים לא זמינים" description="העובד לא ישובץ בימים אלו." selected={draft.excludedDays} tone="excluded" onToggle={(day) => toggleDay('excludedDays', day)} />
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>ביטול</button><button className="button primary">שמירת עובד</button></div>
      </form>
    </div>
  )
}

function ShiftModal({
  shift,
  workers,
  onSave,
  onClose,
}: {
  shift: ShiftTemplate
  workers: Worker[]
  onSave: (shift: ShiftTemplate) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(shift)

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="modal compact"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.activeDays.length) onSave({ ...draft, name: draft.name.trim() })
        }}
      >
        <div className="modal-header"><div><span>מבנה משמרת</span><h2>{shift.name ? 'עריכת משמרת' : 'הוספת משמרת'}</h2></div><button type="button" onClick={onClose}>×</button></div>
        <div className="form-grid">
          <label className="full-width"><span>שם המשמרת</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="לדוגמה: משמרת לילה" /></label>
          <label className="full-width">
            <span>סוג המשמרת</span>
            <select
              value={draft.grouping ? 'grouped' : 'daily'}
              onChange={(event) => setDraft((current) => event.target.value === 'grouped'
                ? { ...current, grouping: { startDay: 4, endDay: 0 }, activeDays: [4], start: '18:00', end: '09:00' }
                : { ...current, grouping: undefined })}
            >
              <option value="daily">משמרת יומית חוזרת</option>
              <option value="grouped">משמרת רצופה על פני מספר ימים</option>
            </select>
          </label>
          {!draft.grouping && (
            <label className="full-width">
              <span>סיווג יום / לילה לשיבוץ לפי העדפות</span>
              <select value={draft.period ?? 'auto'} onChange={(event) => {
                const value = event.target.value
                if (value === 'auto' || value === 'day' || value === 'night') {
                  setDraft({ ...draft, period: value === 'auto' ? undefined : value })
                }
              }}>
                <option value="auto">אוטומטי לפי השעות ({PERIOD_LABELS[classifyShiftPeriod({ ...draft, period: undefined })]})</option>
                <option value="day">יום</option>
                <option value="night">לילה</option>
              </select>
              <small>אוטומטי: לילה אם המשמרת חוצה חצות או מתחילה בין 18:00 ל־06:00. ניתן לבחור סיווג ידנית.</small>
            </label>
          )}
          {draft.grouping && (
            <>
              <label>
                <span>יום התחלה</span>
                <select value={draft.grouping.startDay} onChange={(event) => {
                  const startDay = Number(event.target.value) as DayIndex
                  setDraft((current) => current.grouping
                    ? { ...current, activeDays: [startDay], grouping: { ...current.grouping, startDay } }
                    : current)
                }}>
                  {DAY_NAMES.map((name, day) => <option value={day} key={name}>{name}</option>)}
                </select>
              </label>
              <label>
                <span>יום סיום</span>
                <select value={draft.grouping.endDay} onChange={(event) => {
                  const endDay = Number(event.target.value) as DayIndex
                  setDraft((current) => current.grouping
                    ? { ...current, grouping: { ...current.grouping, endDay } }
                    : current)
                }}>
                  {DAY_NAMES.map((name, day) => <option value={day} key={name}>{name}</option>)}
                </select>
              </label>
            </>
          )}
          <label><span>שעת התחלה</span><input required type="time" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} /></label>
          <label><span>שעת סיום</span><input required type="time" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} /></label>
          <label className="full-width"><span>מספר עובדים במשמרת</span><input required min="1" max="50" type="number" value={draft.requiredWorkers} onChange={(event) => setDraft({ ...draft, requiredWorkers: Number(event.target.value) })} /></label>
        </div>
        <fieldset className="eligible-workers">
          <legend>עובדים מורשים למשמרת</legend>
          <label>
            <span>מי יכול להשתבץ?</span>
            <select
              value={draft.eligibleWorkerIds === undefined ? 'all' : 'selected'}
              onChange={(event) => setDraft({
                ...draft, eligibleWorkerIds: event.target.value === 'all' ? undefined : [],
              })}
            >
              <option value="all">כל העובדים, בהתאם למגבלותיהם</option>
              <option value="selected">רק עובדים נבחרים</option>
            </select>
          </label>
          {draft.eligibleWorkerIds !== undefined && (
            <>
              <div className="eligible-worker-list">
                {workers.map((worker) => (
                  <label key={worker.id}>
                    <input
                      type="checkbox"
                      checked={draft.eligibleWorkerIds?.includes(worker.id) ?? false}
                      onChange={(event) => {
                        const checked = event.target.checked
                        setDraft((current) => ({
                          ...current,
                          eligibleWorkerIds: checked
                            ? [...new Set([...(current.eligibleWorkerIds ?? []), worker.id])]
                            : (current.eligibleWorkerIds ?? []).filter((id) => id !== worker.id),
                        }))
                      }}
                    />
                    <span>{worker.name}</span>
                  </label>
                ))}
              </div>
              {!workers.some((worker) => isWorkerEligible(draft, worker.id)) && (
                <p className="validation-message">לא נבחרו עובדים. המשמרת תישאר ללא שיבוץ עד לבחירת עובדים מורשים.</p>
              )}
            </>
          )}
          <p>הרשימה מחייבת גם בשיבוץ ידני וגם באוטומטי. זמינות, הרשאות לילה, מכסה וחפיפות עדיין נבדקות. בשבת רצופה, התור חל רק על המורשים מתוך הרשימה.</p>
        </fieldset>
        {draft.grouping ? (
          <p className="grouped-help">
            {shiftPeriod(draft)}
            {draft.grouping.endDay < draft.grouping.startDay ||
              (draft.grouping.endDay === draft.grouping.startDay && draft.end <= draft.start)
              ? ' (סיום בשבוע הבא)' : ''}
            <br />
            אותם עובדים לכל התקופה. המשמרת נספרת פעם אחת בשבוע שבו היא מתחילה.
            נדרשת זמינות בכל יום מכוסה, גם ביום הסיום. סיום בחצות אינו כולל את היום החדש.
          </p>
        ) : <DayPicker
          title="ימים פעילים"
          description="בחר באילו ימים המשמרת תופיע בלוח."
          selected={draft.activeDays}
          tone="active"
          onToggle={(day) => setDraft((current) => ({ ...current, activeDays: current.activeDays.includes(day) ? current.activeDays.filter((value) => value !== day) : [...current.activeDays, day] }))}
        />}
        {!draft.activeDays.length && <p className="validation-message">יש לבחור לפחות יום פעיל אחד.</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>ביטול</button><button className="button primary">שמירת משמרת</button></div>
      </form>
    </div>
  )
}

function DayPicker({
  title,
  description,
  selected,
  tone,
  onToggle,
}: {
  title: string
  description: string
  selected: DayIndex[]
  tone: 'preferred' | 'excluded' | 'active'
  onToggle: (day: DayIndex) => void
}) {
  return (
    <fieldset className="day-picker">
      <legend>{title}<small>{description}</small></legend>
      <div>
        {DAY_NAMES.map((dayName, index) => {
          const day = index as DayIndex
          return <button type="button" className={selected.includes(day) ? tone : ''} onClick={() => onToggle(day)} key={dayName}>{dayName}</button>
        })}
      </div>
    </fieldset>
  )
}

export default App
