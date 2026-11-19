import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScheduleData } from '../schedule-data'

export type Role = 'manager' | 'member'
export type Member = {
  workspace_id: string
  user_id: string
  display_name: string
  email: string
  role: Role
  worker_id: string | null
}
export type Invite = { id: string; workspace_id: string; token: string; expires_at: string; revoked: boolean }
export type ShiftRequest = {
  id: string; workspace_id: string; user_id: string; worker_id: string; request_date: string
  kind: 'constraint' | 'holiday'; reason: string; status: 'pending' | 'approved' | 'denied'
  decision_note: string; decided_by: string | null; created_at: string; decided_at: string | null
}
type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined }
type WorkspaceRow = { id: string; name: string; data: Json; revision: number; created_at: string }
type Table<T> = { Row: T; Insert: never; Update: never; Relationships: [] }
type Database = {
  public: {
    Tables: {
      sm_workspaces: Table<WorkspaceRow>
      sm_members: Table<Member>
      sm_invites: Table<Invite>
      sm_requests: Table<ShiftRequest>
    }
    Views: Record<string, never>
    Functions: {
      sm_get_workspace: { Args: { p_workspace: string }; Returns: WorkspaceRow }
      sm_create_workspace: { Args: { p_name: string }; Returns: string }
      sm_create_invite: { Args: { p_workspace: string }; Returns: Invite }
      sm_revoke_invite: { Args: { p_workspace: string; p_invite: string }; Returns: undefined }
      sm_join_workspace: { Args: { p_token: string }; Returns: string }
      sm_update_member: { Args: { p_workspace: string; p_user: string; p_role: Role; p_worker: string | null }; Returns: undefined }
      sm_save_workspace: { Args: { p_workspace: string; p_revision: number; p_data: ScheduleData }; Returns: WorkspaceRow }
      sm_submit_request: { Args: { p_workspace: string; p_date: string; p_kind: ShiftRequest['kind']; p_reason: string }; Returns: string }
      sm_decide_request: { Args: { p_request: string; p_decision: 'approved' | 'denied'; p_note: string; p_revision: number }; Returns: undefined }
      sm_revoke_request_approval: { Args: { p_request: string; p_revision: number }; Returns: undefined }
    }
  }
}
const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
let configuredClient: SupabaseClient<Database> | null = null
let setupError = ''
if (url && key) {
  try { configuredClient = createClient<Database>(url, key) }
  catch { setupError = 'הגדרות Supabase אינן תקינות. בדוק את כתובת הפרויקט והמפתח הציבורי ובצע פריסה מחדש.' }
} else if (url || key) {
  setupError = 'חסר אחד ממשתני הסביבה: יש להגדיר גם כתובת Supabase וגם מפתח ציבורי.'
}
export const supabase = configuredClient
export const configurationError = setupError
export type CloudClient = NonNullable<typeof supabase>

const errors: Record<string, string> = {
  MANAGER_REQUIRED: 'הפעולה מותרת למנהלים בלבד. רענן כדי לעדכן את ההרשאות.',
  STALE_REVISION: 'מנהל אחר עדכן את הסידור. השינויים שלך לא נדרסו ולא נשמרו. ייצא גיבוי אם צריך, ואז טען מחדש.',
  INVALID_INVITE: 'קישור ההזמנה אינו תקין, פג תוקף או בוטל. בקש קישור חדש מהמנהל.',
  WORKER_LINK_REQUIRED: 'מנהל צריך לקשר את החשבון שלך לעובד לפני שליחת בקשות.',
  REQUEST_SHIFT_CONFLICT: 'יש משמרת שחופפת לתאריך המבוקש, כולל לילה או משמרת רצופה. הסר את השיבוץ ושמור את הסידור לפני האישור. נעילות לא הוסרו.',
  REQUEST_STATUS_CONFLICT: 'כבר קיים סטטוס בתא. הסר אותו ושמור לפני אישור הבקשה כדי לא לדרוס מידע.',
  APPROVED_REQUEST_PROTECTED: 'לא ניתן להסיר או לשנות חסימה של בקשה מאושרת.',
  REQUEST_ALREADY_DECIDED: 'הבקשה כבר טופלה. רענן את הרשימה.',
  UNKNOWN_WORKER: 'העובד אינו קיים בסידור השמור. שמור את העובד או עדכן את קישור החשבון.',
  LAST_MANAGER: 'לא ניתן להסיר את הרשאת המנהל האחרון בסביבה.',
  MEMBERSHIP_REQUIRED: 'אין לך הרשאה לסביבה זו.',
  REQUEST_NOT_APPROVED_CONSTRAINT: 'ניתן לבטל אישור רק של בקשת אילוץ מאושרת. רענן את הרשימה.',
  REQUEST_STATUS_CHANGED: 'הסטטוס בתאריך השתנה ואינו שייך לאישור זה. לא הוסר מידע; יש לבדוק את התא.',
}

export function cloudError(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
  for (const [code, text] of Object.entries(errors)) if (message.includes(code)) return text
  if (message.includes('sm_active_request')) return 'כבר קיימת בקשה ממתינה או מאושרת לתאריך זה.'
  if (message.includes('sm_members_workspace_id_worker_id_key')) return 'העובד כבר מקושר לחשבון אחר.'
  return `הפעולה נכשלה: ${message}`
}

export function invitationUrl(token: string) {
  const url = new URL(window.location.origin + window.location.pathname)
  url.searchParams.set('invite', token)
  return url.toString()
}
