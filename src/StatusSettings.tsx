import { useState } from 'react'
import { textColor } from './daily-status'
import type { StatusDefinition } from './daily-status'
import './StatusSettings.css'

type Props = {
  customStatuses: StatusDefinition[]
  onCreate: (status: StatusDefinition) => string | null
}

export function StatusBadge({ status }: { status: Pick<StatusDefinition, 'label' | 'color'> }) {
  return <span className="status-chip" style={{ backgroundColor: status.color, color: textColor(status.color) }}>{status.label}</span>
}

export function StatusCreator({ onCreate }: Pick<Props, 'onCreate'>) {
  const [label, setLabel] = useState('')
  const [color, setColor] = useState('#dce4ef')
  const [blocksShifts, setBlocksShifts] = useState(false)
  const [error, setError] = useState('')

  function create() {
    const message = onCreate({ id: crypto.randomUUID(), label: label.trim(), color, blocksShifts, note: '' })
    setError(message ?? '')
    if (!message) {
      setLabel('')
      setColor('#dce4ef')
      setBlocksShifts(false)
    }
  }

  return <fieldset className="status-creator" onKeyDown={(event) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'text') {
      event.preventDefault()
      create()
    }
  }}>
    <legend>יצירת סטטוס מותאם</legend>
    <div className="form-grid">
      <label><span>שם הסטטוס החדש</span><input type="text" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="למשל: משרד או כוננות" /></label>
      <label><span>צבע הסטטוס החדש</span><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
      <label className="full-width"><span>ברירת מחדל בהוספה כסטטוס יומי</span>
        <select value={blocksShifts ? 'block' : 'note'} onChange={(event) => setBlocksShifts(event.target.value === 'block')}>
          <option value="note">תצוגה בלבד — אינו חוסם שיבוץ</option>
          <option value="block">חוסם שיבוץ בתאריך זה</option>
        </select>
      </label>
    </div>
    <p className="cell-help">בבחירה כסטטוס של משמרת, השם והצבע הם לתצוגה בלבד. חסימה חלה רק כשמוסיפים את הסטטוס בנפרד לתא יומי.</p>
    {error && <p className="validation-message" role="alert">{error}</p>}
    <button type="button" className="button secondary" onClick={create}>יצירת סטטוס</button>
  </fieldset>
}

export default function StatusSettings({ customStatuses, onCreate }: Props) {
  return <section className="card status-settings">
    <h2>סטטוסים מותאמים</h2>
    <p>סטטוסים שנשמרו זמינים לבחירה בכל משמרת וגם בעריכת תא בטבלת העובדים.</p>
    <div className="status-chips">
      {customStatuses.map((status) => <StatusBadge key={status.id} status={status} />)}
    </div>
    <StatusCreator onCreate={onCreate} />
  </section>
}
