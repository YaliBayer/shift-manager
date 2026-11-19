import { useState } from 'react'
import { coveredDates, weekOccurrences } from '../scheduling'
import type { ScheduleData } from '../schedule-data'
import type { Member, ShiftRequest } from './client'

type Props = {
  week: string; member: Member; requests: ShiftRequest[]; data: ScheduleData; dirty: boolean; busy: boolean
  onSubmit: (date: string, kind: ShiftRequest['kind'], reason: string) => Promise<void>
  onDecide: (id: string, decision: 'approved' | 'denied', note: string) => Promise<void>
}
const LABELS = { constraint: 'אילוץ', holiday: 'חג' }
const STATES = { pending: 'ממתינה', approved: 'אושרה', denied: 'נדחתה' }

export default function RequestsPanel(props: Props) {
  const { week, member, requests, data, busy, dirty } = props
  const [date, setDate] = useState(week)
  const [kind, setKind] = useState<ShiftRequest['kind']>('constraint')
  const [reason, setReason] = useState('')
  const last = new Date(`${week}T12:00:00Z`)
  last.setUTCDate(last.getUTCDate() + 6)
  const end = last.toISOString().slice(0, 10)
  const weekly = requests.filter((request) => request.request_date >= week && request.request_date <= end)
  return <details className="card requests-panel">
    <summary>בקשות לשבוע זה — {weekly.filter((request) => request.status === 'pending').length} ממתינות</summary>
    <p>בקשות אילוץ וחג חוסמות יום מלא רק לאחר אישור מנהל. הן חלות על התאריכים שנבחרו, כולל משמרות לילה ומשמרות רצופות שנוגעות בהם.</p>
    {member.worker_id ? <form onSubmit={(event) => {
      event.preventDefault()
      if (date >= week && date <= end) props.onSubmit(date, kind, reason.trim())
    }}>
      <div className="form-grid">
        <label><span>תאריך בשבוע המוצג</span><input required type="date" min={week} max={end} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>סוג בקשה</span><select value={kind} onChange={(event) => { if (event.target.value === 'constraint' || event.target.value === 'holiday') setKind(event.target.value) }}>
          <option value="constraint">אילוץ</option><option value="holiday">חג</option>
        </select></label>
        <label className="full-width"><span>סיבה / הערה למנהל</span><input maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </div>
      <button className="button secondary" disabled={busy}>שליחת בקשה עבורי</button>
    </form> : <p>כדי לשלוח בקשות, מנהל צריך לקשר את החשבון לרשומת העובד דרך ״חברים והזמנות״.</p>}
    {member.role === 'manager' && dirty && <p className="validation-message">יש לשמור או לבטל שינויים בסידור לפני טיפול בבקשות.</p>}
    <div className="request-list">
      {weekly.map((request) => <RequestRow key={request.id} request={request} data={data} manager={member.role === 'manager'}
        disabled={busy || dirty} onDecide={props.onDecide} />)}
      {weekly.length === 0 && <p>אין בקשות לשבוע זה.</p>}
    </div>
  </details>
}

function RequestRow({ request, data, manager, disabled, onDecide }: {
  request: ShiftRequest; data: ScheduleData; manager: boolean; disabled: boolean; onDecide: Props['onDecide']
}) {
  const [note, setNote] = useState('')
  const conflicts = request.status === 'pending' && manager
    ? Object.keys(data.assignments).flatMap((week) => weekOccurrences(week, data.shifts))
      .filter((occurrence) => data.assignments[occurrence.week]?.[occurrence.key]?.includes(request.worker_id) &&
        coveredDates(occurrence).includes(request.request_date))
    : []
  const existingStatus = data.dailyStatuses[request.request_date]?.[request.worker_id]
  return <article className="request-row">
    <strong>{data.workers.find((worker) => worker.id === request.worker_id)?.name ?? 'עובד שהוסר'} · {request.request_date} · {LABELS[request.kind]}</strong>
    <span className={`request-state ${request.status}`}>{STATES[request.status]}</span>
    {request.reason && <p>{request.reason}</p>}
    {request.decision_note && <p>תשובת מנהל: {request.decision_note}</p>}
    {manager && request.status === 'pending' && <>
      {conflicts.length > 0 && <p className="validation-message">לפני אישור יש להסיר ולשמור את השיבוצים: {conflicts.map((item) => item.shift.name).join(', ')}. גם שיבוצים מוגנים נשארים עד להסרה ידנית.</p>}
      {existingStatus && <p className="validation-message">קיים סטטוס ״{existingStatus.label}״ בתא. יש להסירו ולשמור לפני אישור כדי לא לדרוס מידע.</p>}
      <label>הערת החלטה<input maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="cloud-actions">
        <button type="button" className="button primary" disabled={disabled || conflicts.length > 0 || Boolean(existingStatus)}
          onClick={() => onDecide(request.id, 'approved', note.trim())}>אישור וחסימת היום</button>
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onDecide(request.id, 'denied', note.trim())}>דחייה</button>
      </div>
    </>}
  </article>
}
