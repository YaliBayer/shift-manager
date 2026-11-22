import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetStateAction } from 'react'
import App from '../App'
import { parseScheduleData } from '../schedule-data'
import type { ScheduleData } from '../schedule-data'
import { cloudError, invitationUrl } from './client'
import type { CloudClient, Invite, Member, ShiftRequest } from './client'
import RequestsPanel from './RequestsPanel'

type Snapshot = { data: ScheduleData; revision: number }
type Model = {
  name: string; snapshot: Snapshot; draft: ScheduleData; latestRevision: number
  members: Member[]; requests: ShiftRequest[]; invites: Invite[]; publishedWeeks: string[]
}
const hasChanges = (model: Model) => JSON.stringify(model.draft) !== JSON.stringify(model.snapshot.data)

export default function WorkspaceSession({ client, workspaceId, userId, onBack, onSignOut }: {
  client: CloudClient; workspaceId: string; userId: string; onBack: () => void; onSignOut: () => Promise<void>
}) {
  const [model, setModel] = useState<Model | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const busyRef = useRef(false)
  const sequence = useRef(0)
  const active = useRef(true)
  const me = model?.members.find((member) => member.user_id === userId)
  const manager = me?.role === 'manager'
  const dirty = model ? hasChanges(model) : false

  const refresh = useCallback(async (discard = false) => {
    const request = ++sequence.current
    const [workspace, members, requests, invites] = await Promise.all([
      client.rpc('sm_get_workspace', { p_workspace: workspaceId }),
      client.from('sm_members').select('*').eq('workspace_id', workspaceId),
      client.from('sm_requests').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }),
      client.from('sm_invites').select('*').eq('workspace_id', workspaceId).order('expires_at', { ascending: false }),
    ])
    for (const result of [workspace, members, requests, invites]) if (result.error) throw result.error
    if (!workspace.data || !members.data || !requests.data || !invites.data) throw new Error('לא ניתן לטעון את הסביבה.')
    const data = parseScheduleData(workspace.data.data)
    const ownMembership = members.data.find((member) => member.user_id === userId)
    if (!ownMembership) throw new Error('אין לך הרשאה לסביבה זו.')
    if (!active.current || request !== sequence.current) return
    const next: Model = {
      name: workspace.data.name, snapshot: { data, revision: workspace.data.revision }, draft: data,
      latestRevision: workspace.data.revision, members: members.data, requests: requests.data,
      invites: invites.data.filter((invite) => !invite.revoked && new Date(invite.expires_at).getTime() > Date.now()),
      publishedWeeks: workspace.data.publishedWeeks ?? [],
    }
    setModel((current) => current && hasChanges(current) && !discard && ownMembership.role === 'manager'
      ? { ...next, snapshot: current.snapshot, draft: current.draft }
      : next)
  }, [client, workspaceId, userId])

  useEffect(() => {
    active.current = true
    const load = () => {
      if (!busyRef.current) refresh().catch((error: unknown) => { if (active.current) setError(`טעינת הסביבה נכשלה; הנתונים המוצגים עשויים להיות ישנים. ${cloudError(error)}`) })
    }
    load()
    const timer = window.setInterval(load, 15000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => { active.current = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refresh])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function perform(action: () => Promise<void>, success: string, discard = false) {
    if (busyRef.current) return
    busyRef.current = true; sequence.current++; setBusy(true); setError(''); setNotice('')
    try { await action(); await refresh(discard); setNotice(success) }
    catch (error) { setError(cloudError(error)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  function change(update: SetStateAction<ScheduleData>) {
    if (!manager || busyRef.current) return
    setModel((current) => current ? { ...current, draft: typeof update === 'function' ? update(current.draft) : update } : current)
  }

  async function save() {
    if (!model || !manager || busyRef.current) return
    busyRef.current = true; sequence.current++; setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.rpc('sm_save_workspace', {
        p_workspace: workspaceId, p_revision: model.snapshot.revision, p_data: model.draft,
      })
      if (result.error) throw result.error
      const data = parseScheduleData(result.data.data)
      setModel((current) => current ? { ...current, snapshot: { data, revision: result.data.revision },
        draft: data, latestRevision: result.data.revision } : current)
      setNotice('הטיוטה נשמרה למנהלים. עובדים יראו שבוע רק לאחר פרסומו.')
    } catch (error) { setError(cloudError(error)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  async function deleteWorkspace() {
    if (!model || !manager || busyRef.current) return
    const confirmed = window.confirm(`למחוק את סביבת העבודה "${model.name}"?\n\nהסידור, החברים, ההזמנות והבקשות יימחקו לצמיתות. לא ניתן לבטל פעולה זו.`)
    if (!confirmed) return
    busyRef.current = true; sequence.current++; setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.rpc('sm_delete_workspace', { p_workspace: workspaceId })
      if (result.error) throw result.error
      onBack()
    } catch (error) {
      setError(cloudError(error))
      busyRef.current = false
      setBusy(false)
    }
  }

  function publishWeek(week: string) {
    if (!model || !manager || dirty || busyRef.current) return
    const alreadyPublished = model.publishedWeeks.includes(week)
    if (!window.confirm(alreadyPublished
      ? 'לפרסם מחדש את השבוע? העובדים יראו את השיבוץ השמור הנוכחי במקום הגרסה הקודמת.'
      : 'לפרסם את השבוע לעובדים? לאחר הפרסום הם יוכלו לראות את השיבוצים שלו.')) return
    perform(async () => {
      const result = await client.rpc('sm_publish_week', {
        p_workspace: workspaceId, p_week: week, p_revision: model.snapshot.revision,
      })
      if (result.error) throw result.error
    }, alreadyPublished ? 'השבוע פורסם מחדש לעובדים.' : 'השבוע פורסם לעובדים.')
  }

  function canLeave() { return !dirty || window.confirm('יש שינויים שלא נשמרו בסביבה. להמשיך ולאבד אותם?') }
  return <div dir="rtl">
    <header className="workspace-bar">
      <div><strong>{model?.name ?? 'סביבת עבודה'}</strong><small>{manager ? 'מנהל — עריכה ופרסום' : 'חבר — צפייה ושליחת בקשות'}</small></div>
      <div className="cloud-actions">
        {manager && <button className="button primary" disabled={!dirty || busy} onClick={save}>שמירת טיוטה</button>}
        {manager && <button className="button secondary" onClick={() => setShowSettings(!showSettings)}>חברים והזמנות</button>}
        <button className="button secondary" disabled={busy} onClick={() => {
          if (canLeave()) perform(async () => {}, 'הנתונים נטענו מחדש.', true)
        }}>טעינה מחדש</button>
        <button className="button secondary" disabled={busy} onClick={() => { if (canLeave()) onBack() }}>הסביבות שלי</button>
        <button className="button secondary" disabled={busy} onClick={() => { if (canLeave()) onSignOut().catch((error: unknown) => setError(cloudError(error))) }}>התנתקות</button>
      </div>
    </header>
    <div className="cloud-sync">
      {dirty ? <strong>שינויים מקומיים שטרם נשמרו — שמור את הטיוטה לפני פרסום שבוע.</strong> : <span>{manager ? 'מוצגת טיוטת המנהלים השמורה.' : 'מוצגים רק שבועות שמנהל פרסם.'} עדכונים נבדקים כל 15 שניות ובחזרה לחלון.</span>}
      {model && model.latestRevision !== model.snapshot.revision && <p role="alert">יש גרסה חדשה ממנהל אחר. ייצא את הטיוטה אם צריך וטען מחדש לפני שמירה.</p>}
      {busy && <p role="status">שומר / מעדכן…</p>}
      {error && <p role="alert" className="validation-message">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
    {!model && !error && <p className="cloud-page">טוען סביבה…</p>}
    {model && me && <>
      {manager && showSettings && <section className="workspace-settings card">
        <h2>חברים והרשאות</h2>
        <p>חבר חדש יכול לצפות בלבד. קשר אותו לרשומת עובד כדי שיוכל להגיש בקשות עבור עצמו. קידום למנהל מאפשר עריכה ואישור בקשות.</p>
        {dirty && <p>שמור את הסידור לפני שינוי הרשאות או קישור עובדים.</p>}
        <div className="member-list">{model.members.map((member) => <MemberEditor key={`${member.user_id}:${member.role}:${member.worker_id}`}
          member={member} workers={model.snapshot.data.workers} disabled={busy || dirty} onSave={(role, worker) => perform(async () => {
            const result = await client.rpc('sm_update_member', { p_workspace: workspaceId, p_user: member.user_id, p_role: role, p_worker: worker })
            if (result.error) throw result.error
          }, 'פרטי החבר נשמרו.')} />)}</div>
        <h2>קישורי הזמנה</h2><p>כל מי שמחזיק בקישור יכול להצטרף כחבר רגיל במשך 7 ימים. אפשר לבטל קישור; הביטול אינו מוציא חברים שכבר הצטרפו.</p>
        <button className="button secondary" disabled={busy} onClick={() => perform(async () => {
          const result = await client.rpc('sm_create_invite', { p_workspace: workspaceId })
          if (result.error) throw result.error
        }, 'נוצר קישור הזמנה. אפשר להעתיק אותו מהרשימה.')}>יצירת קישור הזמנה</button>
        {model.invites.map((invite) =>
          <div className="invite-row" key={invite.id}>
            <label>קישור להצטרפות<input readOnly dir="ltr" value={invitationUrl(invite.token)} onFocus={(event) => event.target.select()} /></label>
            <small>בתוקף עד {new Date(invite.expires_at).toLocaleString('he-IL')}</small>
            <button disabled={busy} className="button secondary" onClick={() => perform(async () => {
              const result = await client.rpc('sm_revoke_invite', { p_workspace: workspaceId, p_invite: invite.id })
              if (result.error) throw result.error
            }, 'קישור ההזמנה בוטל.')}>ביטול קישור</button>
          </div>)}
        <div className="workspace-danger">
          <h2>מחיקת סביבת העבודה</h2>
          <p>המחיקה מסירה לצמיתות את הסידור, החברים, ההזמנות והבקשות של סביבה זו.</p>
          <button className="button danger" disabled={busy} onClick={deleteWorkspace}>מחיקת סביבת העבודה</button>
        </div>
      </section>}
      <fieldset disabled={busy} className="cloud-fields cloud-schedule">
        <App cloud={{
          data: model.draft, onChange: change, canEdit: manager, publishedWeeks: model.publishedWeeks, requests: model.requests,
          renderRequests: (week) => <div key={`week-tools:${week}`}>
            <section className={`week-publication ${model.publishedWeeks.includes(week) ? 'published' : ''}`}>
              <div>
                <strong>{model.publishedWeeks.includes(week) ? 'השבוע פורסם לעובדים' : 'השבוע עדיין לא פורסם לעובדים'}</strong>
                <span>{manager
                  ? dirty ? 'יש לשמור את הטיוטה לפני פרסום.' : 'הפרסום מעתיק לעובדים את השיבוץ השמור של שבוע זה בלבד.'
                  : 'השיבוצים יופיעו כאן לאחר שמנהל יפרסם את השבוע.'}</span>
              </div>
              {manager && <button className="button primary" disabled={dirty || busy} onClick={() => publishWeek(week)}>
                {model.publishedWeeks.includes(week) ? 'פרסום מחדש' : 'פרסום השבוע'}
              </button>}
            </section>
            <RequestsPanel week={week} member={me} requests={model.requests}
              data={model.snapshot.data} dirty={dirty} busy={busy}
              onSubmit={(date, kind, reason, customStatusId) => perform(async () => {
                const result = await client.rpc('sm_submit_request', { p_workspace: workspaceId, p_date: date, p_kind: kind, p_reason: reason, p_custom_status_id: customStatusId ?? null })
                if (result.error) throw result.error
              }, 'הבקשה נשלחה למנהלים. עד לאישור היא אינה משנה את השיבוץ.')}
              onDecide={(id, decision, note, shiftId) => perform(async () => {
                const result = await client.rpc('sm_decide_request', { p_request: id, p_decision: decision, p_note: note, p_revision: model.snapshot.revision, p_shift_id: shiftId ?? null })
                if (result.error) throw result.error
              }, decision === 'approved' ? 'הבקשה אושרה והוחל השיבוץ או הסטטוס המבוקש. שינויי משמרות יוצגו לעובדים לאחר פרסום השבוע.' : 'הבקשה נדחתה; הסידור לא השתנה.')}
              onRevoke={(id) => perform(async () => {
                const result = await client.rpc('sm_revoke_request_approval', { p_request: id, p_revision: model.snapshot.revision })
                if (result.error) throw result.error
              }, 'האישור בוטל והבקשה חזרה להמתנה. החסימה הוסרה; השיבוצים והנעילות לא שונו.')} />
          </div>,
        }} />
      </fieldset>
    </>}
  </div>
}

function MemberEditor({ member, workers, disabled, onSave }: {
  member: Member; workers: ScheduleData['workers']; disabled: boolean
  onSave: (role: Member['role'], worker: string | null) => Promise<void>
}) {
  const [role, setRole] = useState(member.role)
  const [worker, setWorker] = useState(member.worker_id ?? '')
  return <form className="member-row" onSubmit={(event) => { event.preventDefault(); onSave(role, worker || null) }}>
    <div><strong>{member.display_name}</strong><small>{member.email}</small></div>
    <label>הרשאה<select disabled={disabled} value={role} onChange={(event) => { if (event.target.value === 'manager' || event.target.value === 'member') setRole(event.target.value) }}>
      <option value="member">חבר — צפייה</option><option value="manager">מנהל — עריכה</option>
    </select></label>
    <label>רשומת עובד<select disabled={disabled} value={worker} onChange={(event) => setWorker(event.target.value)}>
      <option value="">ללא קישור — לא ניתן להגיש בקשות</option>
      {workers.map((worker) => <option value={worker.id} key={worker.id}>{worker.name}</option>)}
    </select></label>
    <button className="button secondary" disabled={disabled}>שמירת חבר</button>
  </form>
}
