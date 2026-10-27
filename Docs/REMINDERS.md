# Reminders and Android push

Stage 5a implements server scheduling and the authenticated care inbox. Stage 5b
adds the Android Firebase transport, device enrollment, notification review
links and durable delivery retries. Phone delivery still needs server credentials
and physical-device verification. See PROGRESS.md for actual verification status.

## Run locally

From `backend`, apply the new migration before starting the updated app:

```powershell
npm run db:status
npm run db:migrate
npm run dev
```

Open a second terminal in `backend`:

```powershell
npm run worker
```

Keep both processes running. API startup does not start a hidden worker.
The worker uses the same `DATABASE_URL` and `DATABASE_SCHEMA` as the API. Its
default interval is 30 seconds after each completed tick; `REMINDER_INTERVAL_MS`
can be set from 1000 to 60000. It finishes the active tick before shutdown.
An always-on deployment/process supervisor remains part of stage 8.

The worker operates on the configured database: it generates real dose events
and changes overdue active doses to missed. Tests and visual QA instead use
random disposable schemas; they never run the worker on development patients.

In the Flutter app, open the bell from the care-space list or patient screen.
The inbox refreshes on opening, on resume and every 30 seconds while visible.
Pull to refresh or use the refresh button. An absent/stale worker heartbeat
produces a visible delay warning. Phone alerts additionally require the stage 5b configuration and explicit device opt-in below.

## Timing and consistency

- Every tick generates today plus seven days for each patient using their IANA
  timezone, schedule weekdays and medicine/course windows. Generation is unique
  per schedule/instant. Reconciliation also runs once per patient-local date.
- A pending, eligible dose receives reminders at due time, +15 and +30 minutes
  during normal operation, with at most three reminders. Each reminder goes to
  accepted owners, family admins and today's helpers. Viewers and pending
  invitations receive none.
- Snooze delays the next reminder by 10 minutes, capped at the original +45
  deadline. It is shared among caregivers and survives process restarts. It is
  unavailable before the dose is due, after three reminders, after the deadline,
  or after confirmation. It does not reset the reminder count or deadline.
- At +45 minutes, an unconfirmed eligible dose becomes missed. Only the owner
  and accepted family admins receive the missed-dose alert. This decision is
  server-side and does not depend on the patient's phone being connected.
- Downtime does not cause a burst of old reminders. A resumed worker sends at
  most one reminder per dose, then waits another 15 minutes. Already-overdue
  doses become missed directly. Doses over 24 hours old become missed without
  a new family alert, avoiding a flood from old backlog.
- Missed means no confirmation was recorded by the deadline. It is not evidence
  that a medicine was not given. Taken/Skip can record a late outcome if the
  original medicine/schedule remains eligible. The first caregiver confirmation
  wins, including concurrent late confirmations; later writes return `409`.
  Historical alert cards show the current saved dose outcome.
- A per-patient database lock serializes worker decisions, caregiver actions,
  revocations and lifecycle changes. Decisions, counters and inbox rows commit
  together. Concurrent workers cannot duplicate a reminder/escalation.
- Inbox reads and mark-read requests recheck current membership. Helpers see
  only today's reminders. Revoked memberships and earlier memberships after
  re-invitation cannot reveal old alerts. Inbox pages use a stable timestamp/ID
  cursor, 50 rows at a time. Read state is independent per recipient.

The inbox works independently of phone push. Persistent offline confirmations
and live updates across all patient screens remain a later checkpoint.

## Android push: stage 5b

The Android app is registered in Firebase project `medisync-4aec5`, package
`com.medisync.medisync`. Its `mobile/android/app/google-services.json` is client
configuration and contains public app identifiers. Firebase initializes only on
Android; the web care inbox continues to work without Firebase initialization.
iOS push remains pending an Apple app registration, APNs setup and a Mac/device.

### Server credentials

The Android configuration file cannot authenticate the server. On the Firebase
console, open **Project settings > Service accounts > Generate new private key**.
Save the downloaded key in `backend/credentials/` (for example as
`firebase-service-account.json`). You can retain Firebase's generated filename;
set `GOOGLE_APPLICATION_CREDENTIALS` to the actual file path.
The entire credentials directory and common service-account key filenames are
ignored by Git. Never add this private key to Flutter assets or paste it into
chat. For deployment, prefer managed Application Default Credentials when the
hosting platform supports them.

Set these fields in the existing `backend/.env`, preserving database/JWT values:

```dotenv
PUSH_ENABLED=true
FIREBASE_PROJECT_ID=medisync-4aec5
GOOGLE_APPLICATION_CREDENTIALS=D:/apps/medisync/backend/credentials/firebase-service-account.json
```

From `backend`, run:

```powershell
npm run db:migrate
npm run push:check
```

`push:check` validates a local service-account project match and obtains a
short-lived Google access token. It never prints the token or private key and
sends no notification. Authentication success does not prove FCM send permission
or phone receipt. The FCM HTTP v1 API must be enabled for the Firebase project.
Restart the API and `npm run worker` after changing environment settings.
`PUSH_ENABLED=false` keeps the in-app inbox working without any cloud calls.

### Phone opt-in and actions

Install a fresh debug APK on an Android phone with Google Play services. Use
**Phone notifications** from the care-space list, then **Enable notifications**
and grant Android permission. Permission is requested only from this explicit
screen. A device registers against the signed-in account using a random
installation UUID, private installation secret and account binding UUID.
Firebase token refresh re-registers the device. An enrollment error can be
retried from this screen. A token collision triggers one FCM token refresh and
one guarded enrollment retry; other failures remain visible for manual retry.

Reminders arrive as high-priority Android data messages. The app renders one
local notification with generic text and Taken/Snooze/Skip buttons. Those buttons
open the authenticated dose-review screen. The caregiver reviews the medicine,
patient and latest saved state before using its guarded action controls. A stale
notification cannot overwrite a saved confirmation or bypass revoked access.
No medical details or session/installation secrets are sent through FCM.

Sign-out first disables the local binding and clears displayed notifications,
then attempts server unregistration. Incoming payloads must match an enabled
binding and the locally saved account. Offline cleanup cannot expose another
account's medicine details; old bindings are rejected locally and the server
checks current device ownership before sending. Background receipt records are
separate from the enrollment record and expired records are pruned on sign-in.

### Durable delivery and limits

- Reminder decisions and per-device delivery jobs commit in the same database
  transaction. Only currently enrolled devices receive jobs; registration does
  not replay the historical inbox.
- Multiple workers claim jobs with database locks and expiring leases. Workers
  retry at most six times, with exponential backoff and bounded Retry-After
  support. Invalid/unregistered tokens and permanent FCM errors fail the job;
  unregistered tokens deactivate the matching device binding.
- Before every send, the worker checks accepted membership, role, local helper
  date, read state, dose/schedule/course eligibility, snooze and device binding.
  Obsolete deliveries are cancelled. Reminders expire after 15 minutes or at
  the dose's original +45 deadline; family alerts expire after one hour.
- FCM acceptance is stored as `accepted`, never labelled proof of phone delivery.
  A crash after FCM acceptance can cause a retried send. Stable notification IDs,
  local receipt records and Android `onlyAlertOnce` suppress duplicate cards.
- Phone delivery depends on connectivity, permission, Google Play services and
  OS background restrictions. Force-stopping the app can prevent delivery until
  it is opened again. Server-side missed detection and family inbox alerts do
  not depend on the patient's phone being online, but family phones also need
  their own opt-in, permission and connectivity to receive push.
- `delivery.push_configured` means the server's explicit enable flag/project ID
  are set. It does not certify credentials, worker availability or a particular
  phone's permission/token. Inspect the setup screen, worker heartbeat and
  device test results together.

Before marking stage 5 complete, verify due/+15/+30 reminders, snooze, +45 family
alerts, foreground/background/terminated delivery, account switching, sign-out,
permission denial, token refresh, expired/revoked access and phone-off behavior
on physical devices. Live patient-screen sync and offline confirmations remain
stage 6; always-on deployment and signed releases remain stage 8.

Firebase references: [Flutter setup](https://firebase.google.com/docs/flutter/setup),
[background message handling](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages),
[server credentials and FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api).


### Physical-device QA without development patient data

After `npm run push:check` passes, start a fresh disposable API from `backend`:

```powershell
$env:MEDISYNC_DEVICE_QA="true"
node test/support/client-server.js
```

This creates a random `medisync_test_*` schema on port 31328. The special device
QA mode starts the reminder/push worker only inside that schema. Normal client
smoke tests force cloud push off; device QA additionally requires the explicit
mode flag and `PUSH_ENABLED=true`. Create synthetic accounts/patients in this
server for phone testing. Do not run the automated smoke fixture with device
QA mode enabled, since its device token is deliberately synthetic.

Connect the phone by USB with debugging enabled, then use the Android SDK's adb:

```powershell
adb reverse tcp:31328 tcp:31328
cd ../mobile
flutter run -d YOUR_DEVICE_ID --dart-define=API_BASE_URL=http://127.0.0.1:31328
```

The default Android API address `10.0.2.2` is for an emulator; it does not connect
a physical phone to this PC. Keep the USB reverse connection and QA server
running, opt in on each test phone, and add synthetic doses near the current
patient-local time. Exit the QA server with Ctrl+C to remove its schema and
synthetic accounts/device tokens. Reinstalling/restarting a phone with a removed
QA schema requires creating a fresh QA account and re-enrolling notifications.
