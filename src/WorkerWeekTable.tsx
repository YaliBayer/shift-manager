import { useEffect, useRef, useState } from 'react'
import { BUILTIN_STATUSES, SHIFT_COLORS, STATUS_PRESETS, textColor } from './daily-status'
import type { DailyStatus, DailyStatuses, StatusDefinition } from './daily-status'
import { shiftAppearance } from './shift-status'
import { StatusBadge } from './StatusSettings'
import { isVisibleOnDay, occursOnDay, visibleOccurrences, weekOccurrences, workerRestOnDate } from './scheduling'
import type { AssignmentsByWeek, DayIndex, LockedSlotsByWeek, ShiftOccurrence, ShiftTemplate, Worker } from './scheduling'
import './WorkerWeekTable.css'

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

type Props = {
  week: string
  dates: string[]
  workers: Worker[]
  shifts: ShiftTemplate[]
  assignments: AssignmentsByWeek
  locks: LockedSlotsByWeek
  statuses: DailyStatuses
  customStatuses: StatusDefinition[]
  onSaveStatus: (date: string, workerId: string, status: DailyStatus | null) => string | null
  onAssign: (occurrence: ShiftOccurrence, workerId: string) => string | null
  onUnassign: (occurrence: ShiftOccurrence, workerId: string) => void
  onLock: (occurrence: ShiftOccurrence, locked: boolean) => void
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`))
}

export default function WorkerWeekTable(props: Props) {
  const { week, dates, workers, shifts, assignments, locks, statuses, customStatuses } = props
  const [selected, setSelected] = useState<{ workerId: string; day: DayIndex } | null>(null)
  const occurrences = visibleOccurrences(week, shifts, assignments)
  const selectedWorker = workers.find((worker) => worker.id === selected?.workerId)
  return (
    <section className="worker-week">
      <div className="matrix-layout">
        <div className="matrix-scroll" tabIndex={0} role="region" aria-label="טבלת עובדים שבועית">
          <table className="worker-matrix" dir="ltr">
            <caption>סידור עבודה שבועי · {dateLabel(dates[0])} – {dateLabel(dates[6])}</caption>
            <thead>
              <tr><th rowSpan={2} scope="col">עובד/ת</th>{dates.map((date) => <th key={date} scope="col"><time dateTime={date}>{dateLabel(date)}</time></th>)}</tr>
              <tr>{DAYS.map((day) => <th scope="col" key={day}>{day}</th>)}</tr>
            </thead>
            <tbody>
              {workers.map((worker) => (
                <tr key={worker.id}>
                  <th scope="row" dir="rtl">{worker.name}</th>
                  {dates.map((date, index) => {
                    const day = index as DayIndex
                    const assigned = occurrences.filter((item) =>
                      isVisibleOnDay(item, week, day) && assignments[item.week]?.[item.key]?.includes(worker.id),
                    )
                    const status = statuses[date]?.[worker.id]
                    const rest = workerRestOnDate(worker.id, date, shifts, assignments)
                    const excluded = worker.excludedDays.includes(day)
                    const labels = [
                      ...assigned.map((item) => `${shiftAppearance(item.shift, customStatuses).label}: ${item.shift.name}`),
                      ...(rest.length ? ['אפטר'] : []),
                      ...(status ? [status.label] : []),
                      ...(excluded ? ['לא זמין (קבוע)'] : []),
                    ]
                    return (
                      <td key={date} dir="rtl">
                        <button className="matrix-cell" onClick={() => setSelected({ workerId: worker.id, day })}
                          aria-label={`${worker.name}, ${dateLabel(date)}: ${labels.join(', ') || 'ללא שיבוץ'} — פרטים ועריכה`}>
                          {assigned.map((item) => {
                            const appearance = shiftAppearance(item.shift, customStatuses)
                            return <span className="cell-band" key={`${item.week}:${item.key}`} style={{ backgroundColor: appearance.color, color: textColor(appearance.color) }}
                              title={`${item.shift.name} ${item.shift.start}–${item.shift.end}`}>
                              {appearance.label}
                              <small>{item.shift.name}{locks[item.week]?.includes(item.key) ? ' · מוגן' : ''}</small>
                            </span>
                          })}
                          {rest.length > 0 && <span className="cell-band" style={{ backgroundColor: SHIFT_COLORS.rest }}>אפטר<small>מנוחה עד סוף היום</small></span>}
                          {status && <span className="cell-band" style={{ backgroundColor: status.color, color: textColor(status.color) }}>
                            {status.label}{status.note && <small>{status.note}</small>}
                            {status.blocksShifts && <small>חוסם שיבוץ</small>}
                          </span>}
                          {excluded && <span className="cell-band recurring-exclusion">אילוץ<small>יום לא זמין קבוע</small></span>}
                          {labels.length === 0 && <span className="empty-cell">＋</span>}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
              {workers.length === 0 && <tr><td colSpan={8} className="matrix-empty">הוסף עובדים בלשונית עובדים כדי להתחיל.</td></tr>}
            </tbody>
          </table>
        </div>
        <aside className="matrix-legend" aria-label="מקרא צבעים">
          <h2>מקרא</h2>
          {[...BUILTIN_STATUSES, ...customStatuses].map((item) => <div key={item.id} style={{ backgroundColor: item.color, color: textColor(item.color) }}>{item.label}</div>)}
          <p>לחץ על תא לפרטים ולעריכה. סטטוס המשמרת וצבעו נקבעים בהגדרות המשמרת. מנוחה מוצגת לפי השיבוצים בפועל.</p>
          <p>תא ריק אינו מציין נוכחות במשרד. אפשר להוסיף סטטוס מותאם ולבחור צבע.</p>
        </aside>
      </div>
      {selected && selectedWorker && <CellEditor key={`${week}:${selected.workerId}:${selected.day}`}
        {...props} worker={selectedWorker} day={selected.day} occurrences={occurrences}
        onClose={() => setSelected(null)} />}
    </section>
  )
}

function CellEditor(props: Props & { worker: Worker; day: DayIndex; occurrences: ShiftOccurrence[]; onClose: () => void }) {
  const { worker, day, dates, week, statuses, occurrences, assignments, locks, onClose } = props
  const date = dates[day]
  const [draft, setDraft] = useState<DailyStatus | null>(statuses[date]?.[worker.id] ?? null)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  const rest = workerRestOnDate(worker.id, date, props.shifts, assignments)
  const visible = occurrences.filter((item) => isVisibleOnDay(item, week, day))
  const incoming = Object.keys(assignments).flatMap((startWeek) => weekOccurrences(startWeek, props.shifts))
    .filter((item) => assignments[item.week]?.[item.key]?.includes(worker.id) &&
      occursOnDay(item, week, day) && !visible.some((shown) => shown.week === item.week && shown.key === item.key))
  const dayOccurrences = [...incoming, ...visible]
  const presets = [...STATUS_PRESETS, ...props.customStatuses]
  const preset = draft ? presets.find((item) => item.label === draft.label)?.id ?? 'custom' : ''

  return (
    <dialog ref={dialog} className="cell-dialog" dir="rtl" aria-labelledby="cell-title" onCancel={onClose}>
      <div className="modal-header"><div><span>{DAYS[day]} · {dateLabel(date)}</span><h2 id="cell-title">{worker.name}</h2></div>
        <button type="button" aria-label="סגירה" onClick={onClose}>×</button></div>
      <h3>משמרות ביום זה</h3>
      {worker.excludedDays.includes(day) && <p className="validation-message">יום זה חסום בזמינות הקבועה של העובד.</p>}
      {rest.length > 0 && <p className="rest-message">אפטר — מנוחה מחייבת עד סוף היום בעקבות {rest.map((item) => item.shift.name).join(', ')}. שינוי הסטטוס אינו מבטל מנוחה.</p>}
      <div className="cell-shifts">
        {dayOccurrences.map((item) => {
          const assigned = assignments[item.week]?.[item.key]?.includes(worker.id) ?? false
          const full = (assignments[item.week]?.[item.key]?.length ?? 0) >= item.shift.requiredWorkers
          const locked = locks[item.week]?.includes(item.key) ?? false
          return <article key={`${item.week}:${item.key}`}>
            <strong>{item.shift.name}</strong> <bdi>{item.shift.start}–{item.shift.end}</bdi>
            <StatusBadge status={shiftAppearance(item.shift, props.customStatuses)} />
            {(item.week !== week || item.day !== day) && <small>המשך משמרת מתאריך קודם (מוצג כאן לפרטים בלבד)</small>}
            {item.shift.grouping && <small>
              {dateLabel(new Date(item.start * 60000).toISOString().slice(0, 10))} — {dateLabel(new Date(item.end * 60000).toISOString().slice(0, 10))}
              {' · '}משמרת רצופה: שינוי חל על כל הימים, גם בשבוע סמוך.
            </small>}
            <div className="cell-shift-actions">
              <button type="button" className="button secondary" disabled={!assigned && full} onClick={() => {
                if (assigned) {
                  if (item.shift.grouping && !window.confirm('להסיר את העובד מכל המשמרת הרצופה, בכל הימים שלה?')) return
                  props.onUnassign(item, worker.id)
                  setError('')
                } else setError(props.onAssign(item, worker.id) ?? '')
              }}>{assigned ? 'הסרת שיבוץ' : full ? 'המשמרת מלאה' : 'שיבוץ העובד'}</button>
              <button type="button" className="button secondary" onClick={() => props.onLock(item, !locked)}>
                {locked ? 'שחרור המשמרת לאוטומטי' : 'נעילת המשמרת'}
              </button>
            </div>
            {error && <p role="alert" className="validation-message">{error}</p>}
          </article>
        })}
        {dayOccurrences.length === 0 && <p>אין משמרות שמתחילות או נמשכות ביום זה.</p>}
      </div>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (draft && !draft.label.trim()) { setError('יש להזין שם לסטטוס.'); return }
        const message = props.onSaveStatus(date, worker.id, draft ? { ...draft, label: draft.label.trim() } : null)
        if (message) setError(message)
        else onClose()
      }}>
        <h3>סטטוס לתאריך זה בלבד</h3>
        <div className="form-grid">
          <label className="full-width"><span>סטטוס</span><select value={preset} onChange={(event) => {
            const value = event.target.value
            setDraft(!value ? null : value === 'custom'
              ? { label: '', color: '#dce4ef', blocksShifts: false, note: '' }
              : { ...presets.find((item) => item.id === value)! })
            setError('')
          }}>
            <option value="">ללא סטטוס נוסף</option>
            {presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            <option value="custom">סטטוס מותאם (למשל משרד)</option>
          </select></label>
          {draft && <>
            <label><span>שם הסטטוס</span><input required value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
            <label><span>צבע התא</span><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
            <label className="full-width"><span>הערה / מיקום</span><input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
            <label className="full-width"><span>השפעה על שיבוץ</span><select value={draft.blocksShifts ? 'block' : 'note'} onChange={(event) => setDraft({ ...draft, blocksShifts: event.target.value === 'block' })}>
              <option value="block">חוסם שיבוץ בתאריך זה (ידני ואוטומטי)</option>
              <option value="note">תצוגה בלבד — אינו חוסם שיבוץ</option>
            </select></label>
          </>}
        </div>
        <p className="cell-help">סטטוס אינו יוצר משמרת ואינו מחליף שיבוץ קיים. לפני שמירת חסימה יש להסיר שיבוצים החופפים לתאריך, כולל משמרת לילה מהיום הקודם.</p>
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>ביטול</button><button className="button primary">שמירת תא</button></div>
      </form>
    </dialog>
  )
}
