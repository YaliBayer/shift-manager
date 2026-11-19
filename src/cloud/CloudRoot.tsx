import { lazy, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { cloudError, configurationError, supabase } from './client'
import type { CloudClient } from './client'
import './cloud.css'

const App = lazy(() => import('../App'))
const WorkspaceSession = lazy(() => import('./WorkspaceSession'))

function pendingInvitation() {
  const token = new URLSearchParams(window.location.search).get('invite')
  if (token) sessionStorage.setItem('shift-manager-invite', token)
  return token ?? sessionStorage.getItem('shift-manager-invite')
}

export default function CloudRoot() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(Boolean(supabase))
  const [error, setError] = useState('')
  const [local, setLocal] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [invitation, setInvitation] = useState(pendingInvitation)

  useEffect(() => {
    if (!supabase) return
    let active = true
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return
      setSession(next)
      setLoading(false)
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'SIGNED_OUT') setRecovery(false)
    })
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) setError(cloudError(error))
      setSession(data.session)
      setLoading(false)
    }).catch((error: unknown) => { if (active) { setError(cloudError(error)); setLoading(false) } })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [])

  function clearInvite() {
    sessionStorage.removeItem('shift-manager-invite')
    const url = new URL(window.location.href)
    url.searchParams.delete('invite')
    window.history.replaceState(null, '', url)
    setInvitation(null)
  }

  if (local) return <><div className="cloud-banner" dir="rtl">
    <strong>מצב מקומי בלבד — הנתונים אינם משותפים ולא נשלחים לסביבה.</strong>
    <button className="button secondary" onClick={() => setLocal(false)}>חזרה להתחברות</button>
  </div><App /></>
  if (!supabase) return <main className="cloud-page" dir="rtl"><section className="card cloud-card">
    <h1>סביבות עבודה משותפות</h1>
    {configurationError && <p role="alert" className="validation-message">{configurationError}</p>}
    <p>כדי להפעיל התחברות ושיתוף ב־Vercel, יש לחבר פרויקט Supabase.</p>
    <ol><li>צור פרויקט Supabase והרץ את קובץ ההגירה שבתיקיית supabase/migrations בעורך ה־SQL.</li>
      <li>הגדר ב־Vercel את VITE_SUPABASE_URL ואת VITE_SUPABASE_PUBLISHABLE_KEY, ואז בצע פריסה מחדש.</li>
      <li>הגדר ב־Supabase את כתובת האתר וכתובות ההפניה של האימות. ההוראות המלאות ב־README.</li></ol>
    <p>עד החיבור אפשר להמשיך לעבוד מקומית ולייצא גיבוי. שום סידור קיים לא נמחק.</p>
    <button className="button primary" onClick={() => setLocal(true)}>המשך במצב מקומי</button>
  </section></main>
  if (loading) return <p className="cloud-page" dir="rtl">טוען התחברות…</p>
  if (error) return <main className="cloud-page" dir="rtl"><p role="alert">{error}</p><button onClick={() => window.location.reload()}>טעינה מחדש</button></main>
  if (recovery && session) return <PasswordRecovery client={supabase} onDone={() => setRecovery(false)} />
  if (!session) return <AuthForm client={supabase} invitation={invitation} onLocal={() => setLocal(true)} />
  return <WorkspacePortal key={session.user.id} client={supabase} session={session} invitation={invitation} onJoined={clearInvite} onLocal={() => setLocal(true)} />
}

function AuthForm({ client, invitation, onLocal }: { client: CloudClient; invitation: string | null; onLocal: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  return <main className="cloud-page" dir="rtl"><section className="card cloud-card">
    <h1>{mode === 'signup' ? 'יצירת חשבון' : mode === 'reset' ? 'איפוס סיסמה' : 'כניסה למשמרת'}</h1>
    {invitation && <p>יש קישור הזמנה. לאחר ההתחברות תוכל להצטרף לסביבה כחבר לצפייה בלבד.</p>}
    <form onSubmit={async (event) => {
      event.preventDefault()
      setBusy(true); setError(''); setNotice('')
      try {
        const redirect = new URL(window.location.origin + window.location.pathname)
        if (invitation) redirect.searchParams.set('invite', invitation)
        if (mode === 'signup') {
          const result = await client.auth.signUp({ email: email.trim(), password,
            options: { data: { display_name: name.trim() }, emailRedirectTo: redirect.toString() } })
          if (result.error) throw result.error
          if (!result.data.session) setNotice('בדוק את הדוא״ל ואשר את החשבון לפני ההתחברות.')
        } else if (mode === 'reset') {
          const result = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirect.toString() })
          if (result.error) throw result.error
          setNotice('אם קיים חשבון מתאים, יישלח קישור לאיפוס הסיסמה.')
        } else {
          const result = await client.auth.signInWithPassword({ email: email.trim(), password })
          if (result.error) throw result.error
        }
      } catch (error) { setError(cloudError(error)) } finally { setBusy(false) }
    }}>
      <fieldset disabled={busy} className="cloud-fields">
        <div className="form-grid">
          {mode === 'signup' && <label className="full-width"><span>שם לתצוגה</span><input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>}
          <label className="full-width"><span>דוא״ל</span><input required type="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
          {mode !== 'reset' && <label className="full-width"><span>סיסמה</span><input required type="password" minLength={mode === 'signup' ? 8 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></label>}
        </div>
        <button className="button primary">{busy ? 'ממתין…' : mode === 'signup' ? 'הרשמה' : mode === 'reset' ? 'שליחת קישור איפוס' : 'התחברות'}</button>
      </fieldset>
    </form>
    {error && <p role="alert" className="validation-message">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="cloud-actions">
      <button className="button secondary" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(''); setNotice('') }}>{mode === 'signup' ? 'כבר יש חשבון' : 'יצירת חשבון חדש'}</button>
      <button className="button secondary" onClick={() => { setMode(mode === 'reset' ? 'signin' : 'reset'); setError(''); setNotice('') }}>{mode === 'reset' ? 'חזרה לכניסה' : 'שכחתי סיסמה'}</button>
      <button className="button secondary" onClick={onLocal}>עבודה מקומית / ייצוא סידור קיים</button>
    </div>
  </section></main>
}

function PasswordRecovery({ client, onDone }: { client: CloudClient; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <main className="cloud-page" dir="rtl"><form className="card cloud-card" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    try { const result = await client.auth.updateUser({ password }); if (result.error) throw result.error; onDone() }
    catch (error) { setError(cloudError(error)) } finally { setBusy(false) }
  }}><h1>סיסמה חדשה</h1><label>סיסמה<input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <button disabled={busy} className="button primary">שמירת סיסמה</button>{error && <p role="alert">{error}</p>}
  </form></main>
}

function WorkspacePortal({ client, session, invitation, onJoined, onLocal }: {
  client: CloudClient; session: Session; invitation: string | null; onJoined: () => void; onLocal: () => void
}) {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    client.from('sm_workspaces').select('id,name').order('created_at').then(({ data, error }) => {
      if (!active) return
      if (error) setError(cloudError(error))
      else setWorkspaces(data)
    })
    return () => { active = false }
  }, [client, refresh])

  async function signOut() {
    const result = await client.auth.signOut()
    if (result.error) throw result.error
  }
  if (selected) return <WorkspaceSession client={client} workspaceId={selected} userId={session.user.id}
    onBack={() => { setSelected(null); setRefresh((value) => value + 1) }} onSignOut={signOut} />
  return <main className="cloud-page" dir="rtl"><section className="card cloud-card">
    <h1>סביבות העבודה שלי</h1><p>{session.user.email}</p>
    {error && <p role="alert" className="validation-message">{error}</p>}
    {invitation && <div className="invite-prompt"><p>הוזמנת לסביבת עבודה. הצטרפות מעניקה צפייה ושליחת בקשות בלבד.</p>
      <button disabled={busy} className="button primary" onClick={async () => {
        setBusy(true); setError('')
        try {
          const result = await client.rpc('sm_join_workspace', { p_token: invitation })
          if (result.error) throw result.error
          onJoined(); setSelected(result.data)
        } catch (error) { setError(cloudError(error)) } finally { setBusy(false) }
      }}>הצטרפות לסביבה</button>
    </div>}
    <div className="workspace-list">{workspaces.map((workspace) => <button className="button secondary" key={workspace.id} onClick={() => setSelected(workspace.id)}>{workspace.name}</button>)}</div>
    <form onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError('')
      try {
        const result = await client.rpc('sm_create_workspace', { p_name: name.trim() })
        if (result.error) throw result.error
        setSelected(result.data)
      } catch (error) { setError(cloudError(error)) } finally { setBusy(false) }
    }}>
      <label className="cloud-name">שם סביבה חדשה<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button disabled={busy} className="button primary">יצירת סביבה כמנהל</button>
    </form>
    <p className="cell-help">סביבה חדשה מתחילה ריקה. מנהל יכול לייבא גיבוי מהמצב המקומי ואז לשמור לסביבה.</p>
    <button className="button secondary" onClick={onLocal}>עבודה מקומית / ייצוא סידור קיים</button>
    <button className="button secondary" onClick={() => { signOut().catch((error: unknown) => setError(cloudError(error))) }}>התנתקות</button>
  </section></main>
}
