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

## Deployment and storage

`npm run build` produces a static site in `dist`. Deploy that directory to a static
hosting service, or use `npm run preview` to preview the production build locally.

Worker details and schedules are saved in the current browser's local storage.
There is no backend, login system, or cross-device synchronization. Export a JSON
backup before changing devices or clearing browser data. Uploading the repository
does not upload schedules stored in the browser.
