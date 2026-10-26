# Reminders: stage 5a

This checkpoint implements server scheduling and the authenticated care inbox.
Phone push notifications and lock-screen Taken/Snooze/Skip actions are the next
checkpoint. No Firebase project, device token or cloud credential is configured;
the API explicitly reports `push_configured: false`.

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
produces a visible delay warning. No alert appears on the phone lock screen yet.

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

This stage does not deliver push, queue offline confirmations, or synchronize
every open patient screen live. Those remain explicit later checkpoints.

## Next: Firebase setup and phone delivery

1. Create a development project in the [Firebase console](https://console.firebase.google.com/).
   Register an Android app with package name `com.medisync.medisync`, matching
   `mobile/android/app/build.gradle`. Download its `google-services.json` to
   `mobile/android/app/google-services.json`. This client configuration is not
   a server service-account key.
2. Keep the Firebase project ID available. The next implementation checkpoint
   will select SDK versions compatible with the pinned Flutter SDK, configure
   the client and add explicit notification permission/device enrollment.
   The current app does not initialize Firebase just because the file exists.
3. Configure server credentials through Application Default Credentials in the
   deployment environment. If a local service-account JSON key is needed,
   keep it outside Git (for example in ignored `backend/credentials/`) and
   use its path as an environment variable. Never paste the private key into
   chat or place it in Flutter assets. No server Firebase SDK is installed yet.
4. For iOS, register the same bundle identifier, configure APNs credentials and
   Xcode capabilities on a Mac, then test on a physical iPhone. This has not been
   done on the current Windows machine.
5. Implement the durable per-device delivery queue with retries, token refresh,
   account-switch cleanup and generic lock-screen text; connect the three
   actions to the same guarded API. Prove foreground/background delivery,
   action races, revoked access, denied permission and phone-off family alerts
   on real devices before marking stage 5 complete.

Firebase references: [Flutter setup](https://firebase.google.com/docs/flutter/setup),
[Cloud Messaging setup](https://firebase.google.com/docs/cloud-messaging/flutter/get-started),
and [server credentials](https://firebase.google.com/docs/admin/setup).
