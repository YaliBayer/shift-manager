import { useState } from 'react'
import { assignmentConflict, coveredDates, weekOccurrences } from '../scheduling'
import { assignmentConflictMessage } from '../assignment-errors'
import { isRequestKind, isShiftRequest, matchingRequestShifts, REQUEST_LABELS, requestLabel, requestStatus } from '../requests'
import type { ScheduleData } from '../schedule-data'
import type { Member, ShiftRequest } from './client'

type Props = {
  week: string; member: Member; requests: ShiftRequest[]; data: ScheduleData; dirty: boolean; busy: boolean
  onSubmit: (date: string, kind: ShiftRequest['kind'], reason: string, customStatusId?: string) => Promise<void>
  onDecide: (id: string, decision: 'approved' | 'denied', note: string, shiftId?: string) => Promise<void>
  onRevoke: (id: string) => Promise<void>
}
const STATES = { pending: 'ממתינה', approved: 'אושרה', denied: 'נדחתה' }

export default function RequestsPanel(props: Props) {
  const { week, member, requests, data, busy, dirty } = props
  const [date, setDate] = useState(week)
  const [kind, setKind] = useState<ShiftRequest['kind']>('constraint')
  const [reason, setReason] = useState('')
  const [customStatusId, setCustomStatusId] = useState('')
  const customStatus = data.customStatuses.find((status) => status.id === customStatusId)
  const last = new Date(`${week}T12:00:00Z`)
  last.setUTCDate(last.getUTCDate() + 6)
  const end = last.toISOString().slice(0, 10)
  const weekly = requests.filter((request) => request.request_date >= week && request.request_date <= end &&
    (member.role === 'manager' || request.user_id === member.user_id))
  return <details className="card requests-panel">
    <summary>בקשות לשבוע זה — {weekly.filter((request) => request.status === 'pending').length} ממתינות</summary>
    <p>אילוץ, חג וחופש חוסמים יום מלא לאחר אישור. בבקשת יום או לילה המנהל בוחר משמרת תואמת ומשבץ אותך בפועל. סטטוס מותאם מוחל לפי הצבע והגדרת החסימה שלו.</p>
    {member.worker_id ? <form onSubmit={(event) => {
      event.preventDefault()
      if (date >= week && date <= end && (kind !== 'custom' || customStatus)) {
        props.onSubmit(date, kind, reason.trim(), kind === 'custom' ? customStatusId : undefined)
      }
    }}>
      <div className="form-grid">
        <label><span>תאריך בשבוע המוצג</span><input required type="date" min={week} max={end} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>סוג בקשה</span><select value={kind} onChange={(event) => { if (isRequestKind(event.target.value)) setKind(event.target.value) }}>
          {Object.entries(REQUEST_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {kind === 'custom' && <label className="full-width"><span>הסטטוס המותאם המבוקש</span>
          <select required value={customStatusId} onChange={(event) => setCustomStatusId(event.target.value)}>
            <option value="">בחירת סטטוס שמור</option>
            {data.customStatuses.map((status) => <option key={status.id} value={status.id}>{status.label}</option>)}
          </select>
          {customStatus && <small>{customStatus.blocksShifts ? 'סטטוס זה חוסם שיבוץ ביום המבוקש.' : 'סטטוס לתצוגה בלבד — אינו חוסם שיבוץ.'}</small>}
          {data.customStatuses.length === 0 && <small>אין סטטוסים מותאמים זמינים. מנהל צריך ליצור סטטוס בהגדרות המשמרות ולפרסם אותו לעובדים.</small>}
        </label>}
        <label className="full-width"><span>סיבה / הערה למנהל</span><input maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </div>
      <button className="button secondary" disabled={busy || (kind === 'custom' && !customStatus)}>שליחת בקשה עבורי</button>
    </form> : <p>כדי לשלוח בקשות, מנהל צריך לקשר את החשבון לרשומת העובד דרך ״חברים והזמנות״.</p>}
    {member.role === 'manager' && dirty && <p className="validation-message">יש לשמור או לבטל שינויים בסידור לפני טיפול בבקשות.</p>}
    <div className="request-list">
      {weekly.map((request) => <RequestRow key={request.id} request={request} data={data} manager={member.role === 'manager'}
        disabled={busy || dirty} onDecide={props.onDecide} onRevoke={props.onRevoke} />)}
      {weekly.length === 0 && <p>אין בקשות לשבוע זה.</p>}
    </div>
  </details>
}

function RequestRow({ request, data, manager, disabled, onDecide, onRevoke }: {
  request: ShiftRequest; data: ScheduleData; manager: boolean; disabled: boolean; onDecide: Props['onDecide']
  onRevoke: Props['onRevoke']
}) {
  const [note, setNote] = useState('')
  const [shiftId, setShiftId] = useState('')
  const shiftRequest = isShiftRequest(request.kind)
  const status = requestStatus(request)
  const worker = data.workers.find((worker) => worker.id === request.worker_id)
  const choices = request.status === 'pending' && manager
    ? matchingRequestShifts(request.request_date, request.kind, data.shifts).map((occurrence) => {
      const assigned = data.assignments[occurrence.week]?.[occurrence.key] ?? []
      const conflict = worker ? assignmentConflict(worker, occurrence, data.shifts, data.assignments, data.dailyStatuses) : null
      const error = !worker ? 'העובד אינו קיים' : conflict ? assignmentConflictMessage(conflict, worker)
        : !assigned.includes(worker.id) && assigned.length >= occurrence.shift.requiredWorkers ? 'המשמרת מלאה' : null
      return { occurrence, error }
    }) : []
  const selected = choices.find((choice) => choice.occurrence.shift.id === shiftId)
  const conflicts = request.status === 'pending' && manager && status?.blocksShifts
    ? Object.keys(data.assignments).flatMap((week) => weekOccurrences(week, data.shifts))
      .filter((occurrence) => data.assignments[occurrence.week]?.[occurrence.key]?.includes(request.worker_id) &&
        coveredDates(occurrence).includes(request.request_date))
    : []
  const existingStatus = !shiftRequest && data.dailyStatuses[request.request_date]?.[request.worker_id]
  return <article className="request-row">
    <strong>{worker?.name ?? 'עובד שהוסר'} · {request.request_date} · {requestLabel(request)}</strong>
    <span className={`request-state ${request.status}`}>{STATES[request.status]}</span>
    {request.reason && <p>{request.reason}</p>}
    {request.decision_note && <p>תשובת מנהל: {request.decision_note}</p>}
    {request.status === 'approved' && request.assigned_shift_id && <p>משמרת שאושרה: {data.shifts.find((shift) => shift.id === request.assigned_shift_id)?.name ?? REQUEST_LABELS[request.kind]}</p>}
    {request.kind === 'custom' && <p>{status?.blocksShifts ? 'הסטטוס המבוקש חוסם שיבוץ.' : 'הסטטוס המבוקש לתצוגה בלבד, ללא חסימת שיבוץ.'}</p>}
    {manager && request.status === 'approved' && request.kind === 'constraint' &&
      <button type="button" className="button secondary" disabled={disabled} onClick={() => {
        if (window.confirm('לבטל את אישור האילוץ ולהחזיר את הבקשה להמתנה? החסימה תוסר, אך שיבוצים שהוסרו בעבר לא ישוחזרו.')) onRevoke(request.id)
      }}>ביטול אישור אילוץ</button>}
    {manager && request.status === 'pending' && <>
      {shiftRequest && <>
        <label>משמרת לשיבוץ בעת האישור<select value={shiftId} onChange={(event) => setShiftId(event.target.value)}>
          <option value="">בחירת משמרת תואמת לתאריך</option>
          {choices.map(({ occurrence, error }) => <option key={occurrence.shift.id} value={occurrence.shift.id} disabled={Boolean(error)}>
            {occurrence.shift.name} · {occurrence.shift.start}–{occurrence.shift.end}{error ? ` — ${error}` : ''}
          </option>)}
        </select></label>
        {choices.length === 0 && <p className="validation-message">אין משמרת תואמת שמתחילה בתאריך המבוקש. יש להגדיר ולשמור משמרת מתאימה לפני האישור.</p>}
        {choices.length > 0 && choices.every((choice) => choice.error) && <p className="validation-message">אין משמרת שניתן לשבץ אליה כרגע. סיבות החסימה מופיעות ברשימת המשמרות.</p>}
        {selected?.error && <p className="validation-message">{selected.error}</p>}
        <p>האישור מוסיף את העובד למשמרת ונועל אותה כשיבוץ ידני. משמרות אחרות אינן משתנות. יש לפרסם את השבוע כדי לעדכן את לוח העובדים.</p>
      </>}
      {conflicts.length > 0 && <p className="validation-message">לפני אישור יש להסיר ולשמור את השיבוצים: {conflicts.map((item) => item.shift.name).join(', ')}. גם שיבוצים מוגנים נשארים עד להסרה ידנית.</p>}
      {existingStatus && <p className="validation-message">קיים סטטוס ״{existingStatus.label}״ בתא. יש להסירו ולשמור לפני אישור כדי לא לדרוס מידע.</p>}
      <label>הערת החלטה<input maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="cloud-actions">
        <button type="button" className="button primary" disabled={disabled || !worker || conflicts.length > 0 || Boolean(existingStatus) || (shiftRequest && (!selected || Boolean(selected.error)))}
          onClick={() => onDecide(request.id, 'approved', note.trim(), shiftRequest ? shiftId : undefined)}>
          {shiftRequest ? 'אישור ושיבוץ במשמרת' : status?.blocksShifts ? 'אישור וחסימת היום' : 'אישור והוספת סטטוס'}
        </button>
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onDecide(request.id, 'denied', note.trim())}>דחייה</button>
      </div>
    </>}
  </article>
}
