# Shift Manager

A Hebrew, right-to-left weekly shift scheduler built with React, TypeScript, and Vite.

## Features

- Worker availability, preferred days, day/night preferences, and weekly shift limits.
- Daily shifts and continuous multi-day shifts with configurable staffing.
- Restricted shifts with an explicit list of eligible workers.
- Automatic scheduling balanced against the previous four weeks of ordinary shifts.
- Saturday rotation for continuous multi-day shifts.
- Separate permissions for Saturday-only workers, manual-only nights, and prohibited nights.
- Rest until the next calendar day after a night or multi-day shift ends.
- Manual editing and protected shifts that automatic generation cannot change.
- JSON backup import and export.
- Default spreadsheet-style worker-by-day view, with the original shift cards still available.
- Colored daily statuses (leave, holidays, courses, constraints and custom labels), notes,
  and per-cell settings that optionally block assignment on that date.
- Reusable custom statuses with names and colors, created in shift settings or while
  editing a shift. Choose a shift's displayed status independently of its day/night
  classification; automatic display remains the default. Display changes also apply
  to existing assignments without removing them or changing locks or rest rules.
- Click a cell to inspect or edit shifts and statuses; navigate one week at a time
  using arrows, the date picker, or a horizontal swipe on the week navigation bar.
- Email/password accounts, shared workspaces and expiring invitation links.
- Members can view schedules and request dates; only managers can edit schedules,
  manage roles, link accounts to workers, and approve or deny requests.
- Weekly constraint (`אילוץ`) and holiday (`חג`) requests. Approval adds a blocking
  daily status; denial leaves the schedule unchanged. Existing conflicting shifts,
  including protected assignments and overnight/grouped shifts, must be removed
  and saved explicitly before approval.

Day/night shifts, continuous Saturday assignments and required rest are displayed
from the real schedule, not stored as duplicate status entries. An empty cell does
not imply office attendance. Use a custom non-blocking status to record a location.
Blocking statuses apply to every date a shift covers, including overnight and
cross-week shifts. Existing assignments must be removed explicitly before saving
a conflicting blocking status; protected shifts are never silently overwritten.

## Run locally

Use Node.js 22.18 or newer.

```powershell
npm ci
npm run dev
```

## Development checks

```powershell
npm test
npm run lint
npm run build
```

## Vercel + Supabase setup

Vercel continues to host the Vite frontend. Supabase provides PostgreSQL and Auth;
no separate application server or private database key is needed in Vercel.

1. Create a Supabase project. In its SQL Editor, run the **contents** of each SQL
   file in `supabase\migrations` **once**, in filename order, from
   `202611190001_workspaces.sql` through `202611220001_request_options.sql`. This creates the
   workspace tables, row-level access policies, and transactional RPC functions.
   The migration uses `sm_`-prefixed tables and a private helper schema.
2. In Supabase's project connection/API settings, copy the **project URL** and
   **publishable key** (`sb_publishable_...`). The legacy public `anon` key also
   works. N
   Add the following DNS records in your domain provider.
   Domain Verification
   DKIM
   Type	Host	Value	TTL
   TXT	
   resend._domainkey.soc
   p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCqcaG+0EPI1uBlGbDD0U6wZTJzImhtLkvC7jsARKdy+uNTa+PhM+42Nj9nPRZFIP7WCgFapVZAO38GcIFjdQDebGH1FViLooW1e1CEdnLD5giWItPI63/k5EM6mGF0jZFVSVEq+VmMMLO/7nT1s0NqfmZZufBroYZfroH4ON0SRQIDAQAB
   Auto
   Enable Sending
   
   
   SPF
   Type	Host	Value	TTL
   CNAME	
   rsend.soc
   rsend-apne1.forge.rmta.net
   Auto
   CNAME	
   send.soc
   send.forge.rmta.net
   Auto
   DMARC
   (Recommended)
   Type	Name	Content	TTL	Priority
   TXT	
   _dmarc
   v=DMARC1; p=none;
   Auto	
   Enable receiving
   
   
   /docs
   /domains
   ever use a `service_role`, `sb_secret_...`, or database password.
3. In **Vercel → Project → Settings → Environment Variables**, set:

   ```text
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
   ```

   Enable them for Production (and Preview only if intended), then **redeploy**:
   Vite embeds these public settings at build time. Keep Vercel's Vite preset,
   build command `npm run build`, and output directory `dist`.
4. In **Supabase → Authentication → URL Configuration**, set **Site URL** to
   your production Vercel/custom-domain URL. Add that site's `/**` redirect URL
   so confirmation/reset emails can preserve invitation query parameters, e.g.
   `https://your-app.vercel.app/**`. Add only trusted preview URLs, if needed.
   Keep the email/password provider and email confirmation enabled.
5. Configure **custom SMTP** in Supabase Auth for confirmation and password-reset
   emails to real workers (for example via a provider with a verified sender
   domain). Supabase's built-in mail service is restricted to project-team
   addresses and is not suitable for inviting arbitrary workers. SMTP credentials
   belong in Supabase, never in `VITE_` variables or this repository.
6. Open the deployed app, create and confirm an account, and create a workspace.
   Its creator becomes the first manager. Add workers and shifts, or import a
   JSON backup, then click **שמירת שינויים לסביבה**.
7. Open **חברים והזמנות**, create an invitation link, and send it to coworkers.
   They sign in and join as ordinary members. Link each account to its worker
   record so it can submit its own requests. Promote selected accounts to manager
   only when they should be able to edit the entire workspace.

For local cloud development, copy `.env.example` to `.env.local`, fill in the
public values, and allow `http://localhost:5173/**` in Supabase's redirect URLs.
Run `npm run dev`. Without cloud configuration, the app explains setup and offers
an explicit **local-only** mode.

### Upgrading an existing workspace

Run only migrations not yet installed, in filename order. If week publishing is
already installed, run only the **contents** of
`supabase\migrations\202611220001_request_options.sql` in the Supabase SQL Editor,
then deploy the updated frontend and reload open app tabs. Do not paste the file
path into the SQL Editor or rerun previously installed migrations.
This upgrade preserves existing schedules, requests and published weeks, and adds
leave, day-shift, night-shift and saved custom-status requests.

### Shared scheduling and requests

Managers save a local draft with **שמירת שינויים לסביבה**, then separately publish
each week with **פרסום השבוע**. Members see published assignments, not
unpublished draft changes; the app checks for updates every 15 seconds,
on window focus, and on manual reload. Unsaved drafts are not published or cached
in browser storage; export a backup before leaving if you need to keep one.
Version checks prevent concurrent managers from silently overwriting each other.
On a conflict, export any needed draft, reload the newer schedule, and reapply
the intended changes.

The weekly **בקשות לשבוע זה** panel follows the displayed week. Each submission
covers one date; submit additional requests for additional dates.
Alongside **אילוץ** and **חג**, workers can request **חופש**, **משמרת יום**,
**משמרת לילה**, or a saved **סטטוס מותאם**.
Pending requests do not affect scheduling. Managers must save any schedule changes
before deciding requests. Leave, constraints and holidays block the full calendar
date, including overnight/grouped shifts touching it. Blocking-status approval
rejects overlapping assignments; all status approvals reject existing cell statuses
instead of overwriting them. Approved statuses cannot be
removed through ordinary cell editing or backup import. Managers can use
**ביטול אישור אילוץ** on an approved constraint to return it to pending review and
remove only its approved block. Existing assignments, locks and unrelated statuses
are preserved; previously removed assignments are not restored. Save any draft
before cancelling approval. Denied requests can be submitted again.

For day/night approval, the manager explicitly selects an ordinary matching shift
starting on the requested date. Approval adds the worker to that actual shift and
locks the slot, without replacing coworkers or changing other assignments. Capacity,
eligibility, availability, blocking statuses, weekly limits and cross-week overlap/rest
rules still apply. Manual-only nights are allowed, just like other manager assignments.
Publish the week separately to share the approved assignment. Managers may later
deliberately edit these assignments; the approved request remains decision history.

Custom requests select a saved custom status, not free text. Members can choose
definitions from the latest published snapshot. The requested label, color and
blocking policy are captured at submission, so later definition changes cannot alter
the request. Nonblocking custom statuses may coexist with shifts.

Invitation links expire after seven days and can be revoked. Revocation prevents
new joins; it does not remove existing members. An invitation never grants manager
permissions, even if a client supplies forged account metadata.

Workspace members can read the saved schedule within that workspace. Constraint
requests and their calendar blocks are visible only to managers and the original
requester. Other workers' recurring excluded days and manually entered constraint
statuses are also omitted from member responses. Holiday calendar blocks remain
visible. Request reasons and decision notes are readable only by the requester and
workspace managers. Full schedule JSON is not directly readable by members;
the database filters it before returning it to the app. Membership, edits,
decisions, and worker links are enforced
in PostgreSQL, not just by hidden frontend controls.

### Existing browser data

Local-only mode still uses the original browser storage. Cloud workspaces start
empty and do not automatically upload or replace that data. Use **עבודה מקומית /
ייצוא סידור קיים** to export it, then import the backup as a workspace manager
and save it to the shared workspace. Keep a backup before clearing browser data.

`npm run build` produces the static site in `dist`; `npm run preview` previews it.
Database permission and transaction tests use isolated in-memory PostgreSQL
(PGlite) and synthetic accounts, not your Supabase project. Production email
delivery and redirect URLs must also be checked after configuring your project.
