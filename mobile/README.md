# MediSync Flutter app

The shared care client for the Node/PostgreSQL API in `../backend`.
Android, iOS and web projects are included. Use Flutter 3.27.4 / Dart 3.6.2;
the committed `pubspec.lock` pins the dependency graph.

## Run locally

Start the API in one terminal from the repository root:

```powershell
cd backend
npm run db:migrate
npm run dev
```

Open the app in another terminal:

```powershell
cd mobile
flutter pub get --enforce-lockfile
flutter run -d chrome --web-port=5173 --dart-define=API_BASE_URL=http://localhost:3000
```

Development CORS permits `http://localhost:5173` and
`http://127.0.0.1:5173`. Set backend `ALLOWED_ORIGINS` to a comma-separated
list of exact origins when using another host/port. Production has no default
allowed browser origins. Native apps do not require CORS.

Create an account, add a patient, add the prescribing doctor and prescription,
and enter dose times from the prescription. Open Today to see the shared
timeline. A caregiver needs their own account; invitations appear on their
dashboard and grant access only after acceptance.

## Android

Use an Android emulator or connect a phone with USB debugging enabled:

```powershell
flutter devices
flutter run -d <android-device-id> --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

`10.0.2.2` is the Android emulator's route to the host computer. For a physical
phone, replace it with the computer's LAN address and use the same trusted local
network. The backend port must be reachable from that device.

```powershell
flutter build apk --debug --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

The development APK is `build/app/outputs/flutter-apk/app-debug.apk`.
It uses a debug signing key and is not a production release.
The project uses AGP 8.7.3, Gradle 8.11.1, Kotlin 2.1.0, Java 17 bytecode and
NDK 27.0.12077973. Install required Android SDK components using Android Studio;
no machine-specific SDK paths or signing keys belong in Git.

HTTP is allowed only in Android debug/profile manifests. Release manifests deny
cleartext traffic. Android backup is disabled to avoid transferring secure-store
material without its device key.

## iOS

Building and device verification require macOS, Xcode and signing configuration.
The iOS scaffold and Keychain session adapter are included. Native iOS builds,
Keychain behavior and device delivery have not been verified on this Windows
machine. Use an HTTPS API endpoint; broad ATS exceptions are not enabled.
Production signing, store artwork and release-device verification are stage 8.

## Connection and sessions

`API_BASE_URL` is a compile-time Dart define and excludes the `/api` suffix.
Debug defaults are localhost:3000 for web/iOS and 10.0.2.2:3000 for Android.
Release builds require an explicit HTTPS URL at startup:

```powershell
flutter build web --pwa-strategy=none --dart-define=API_BASE_URL=https://your-api.example
```

Replace that URL with the deployed API. An unconfigured release shows a
configuration screen rather than sending patient data to a development URL.
The build-only placeholder in CI is never a deployed service.

Mobile sessions use Flutter Secure Storage (Android encrypted preferences / iOS
Keychain). Web sessions stay in memory and end on page refresh. Patient records
are not persisted to local storage in this stage. Logout clears the session;
a 401 clears all patient routes and dialogs. Late responses from an old session
cannot log out a new session, and storage operations are serialized.

HTTP mutations are not automatically retried. On a connection timeout, refresh
the relevant records before submitting a change again.

## Implemented flows

- Sign up, sign in, restore mobile sessions and sign out.
- Create/select patients with a patient-local IANA timezone.
- Read today's or another day's doses, record taken/skipped, and display the
  caregiver/time of the saved confirmation. A 409 refreshes the timeline and
  preserves the winning confirmation.
- Read active medicines and complete visit history; record doctors and
  multi-item prescriptions, course dates, replacement links and dose times.
- Add/deactivate schedules and record stopped/completed courses.
- Review duplicate, instruction and course-date findings and their history.
- Invite/accept/revoke caregiver access with role-specific controls.
- Loading, empty, error and retry states; narrow layouts and enlarged text.

Owners/family admins prepare upcoming dose events when opening the timeline or
saving dose times. Helpers see and confirm today only. Viewers cannot mutate
records. The server independently enforces every role boundary.

Prescriptions and schedules are separate API operations. If a prescription
saves but a dose-time request fails, a persistent receipt reports the incomplete
schedule. The prescription is not recreated; open its medicine record to finish
the missing dose times.

Push notifications, server-side recurring jobs, reminder escalation and family
alerts are stage 5. WebSockets and persistent offline queues are stage 6.

## Verify

```powershell
dart format --output=none --set-exit-if-changed lib test tool
flutter analyze --no-pub
flutter test --no-pub
```

The tests cover API/session behavior and widget workflows, including role
boundaries, a concurrent dose conflict, partial saves, session expiry and large
text on a narrow phone.

For a real client/API smoke test, start a disposable API in one terminal:

```powershell
cd backend
node test/support/client-server.js
```

Then, from `mobile`:

```powershell
dart run tool/api_smoke.dart
```

The server uses a random `medisync_test_*` PostgreSQL schema on port 31328.
The smoke test refuses a normal API and uses synthetic records only. Stop the
server with Ctrl+C so it removes its schema. It is a test fixture and is never
mounted by the production API.

GitHub Actions checks formatting, analysis, widget/unit tests, real-client API
integration, and Android/web compilation. Hosted CI runs after pushing the commit.
