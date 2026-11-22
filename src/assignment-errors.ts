import type { assignmentConflict, Worker } from './scheduling'

export function assignmentConflictMessage(conflict: NonNullable<ReturnType<typeof assignmentConflict>>, worker: Worker) {
  const messages = {
    'daily-status': 'לעובד יש סטטוס חוסם באחד התאריכים שהמשמרת מכסה. ניתן לערוך אותו בטבלת העובדים.',
    'worker-not-eligible': 'העובד אינו ברשימת העובדים המורשים למשמרת זו',
    'grouped-not-allowed': 'לעובד אין הרשאה למשמרות רצופות על פני מספר ימים',
    'grouped-only': 'העובד מורשה למשמרות שבת רצופות בלבד, ללא משמרות רגילות',
    'night-not-allowed': 'העובד אינו מורשה למשמרות לילה, גם לא בשיבוץ ידני',
    unavailable: 'העובד אינו זמין באחד הימים שהמשמרת מכסה',
    overlap: 'קיימת חפיפה עם שיבוץ אחר של העובד, כולל בשבוע סמוך',
    'rest-day': 'לא ניתן לשבץ: אחרי משמרת לילה או משמרת רצופה נדרשת מנוחה עד סוף יום הסיום, גם בשיבוץ ידני ובין שבועות.',
    limit: `${worker.name} כבר הגיע למכסת ${worker.maxShifts} המשמרות בשבוע תחילת המשמרת`,
  }
  return messages[conflict]
}
