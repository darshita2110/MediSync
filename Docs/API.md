# MediSync API contract

Base URL for local development: `http://localhost:3000`.
Send request bodies as `Content-Type: application/json`.
IDs are UUID strings; calendar dates use `YYYY-MM-DD` and instants use ISO 8601.
Nullable optional text and dates can be omitted or sent as `null`.

## Authentication and errors

`GET /`, `GET /api/health`, `GET /api/health/db`, signup and login are public.
All other endpoints require `Authorization: Bearer <token>`.
JWTs expire after seven days. Login again after a `401` response.

Browser clients must use an allowed origin. Development allows localhost:5173
and 127.0.0.1:5173. Configure `ALLOWED_ORIGINS` with exact comma-separated HTTP(S)
origins for other deployments; production allows none by default. Preflight
requests are public but do not grant access to patient data. Native mobile
requests still require bearer authentication and do not require CORS headers.

Errors use `{ "error": "message" }` and these status codes:

| Status | Meaning |
| --- | --- |
| 400 | Invalid body, calendar date, UUID, query parameter or action |
| 401 | Missing, invalid or expired authentication token |
| 403 | No accepted patient access, or the role cannot perform the action |
| 404 | Route or patient-scoped resource was not found |
| 409 | Duplicate account/invite/schedule, closed resource, or dose already confirmed/ineligible |
| 413 | JSON body exceeds 100 KB |
| 500 | Unexpected server/database failure; internals are omitted |

The JSON error body is for display; clients should branch on status and their
current operation, rather than comparing the wording of error strings.

## Roles and consent

| Operation | Owner | Family admin | Helper | Viewer |
| --- | --- | --- | --- | --- |
| Read medical records, prescriptions, conflicts, caregiver list | Yes | Yes | No | Yes |
| Add doctors, create/replace/stop/complete medicines | Yes | Yes | No | No |
| Manage schedules, generate doses, check/close conflicts | Yes | Yes | No | No |
| Read schedules and dose timeline | Yes | Yes | Today only | Yes |
| Confirm taken/skipped | Yes | Yes | Today only | No |
| Invite/revoke caregivers | Yes | No | No | No |

A user can create a patient and becomes its owner. Patient and user are distinct
records. An invitee must already have an account and accept the invitation before
it grants access. Removing access takes effect on subsequent API requests; a JWT
does not contain permanent patient permissions. The owner cannot be removed.

## Endpoint reference

Successful writes return `201` for creation and `200` for other actions.
All GET requests below return `200`.

| Method and path | Request / query | Response envelope |
| --- | --- | --- |
| `POST /api/auth/signup` | `email`, `password`, optional `name` | `{user, token}` |
| `POST /api/auth/login` | `email`, `password` | `{user, token}` |
| `POST /api/patients` | `full_name`, optional `timezone`, `date_of_birth` | `{patient}` |
| `GET /api/patients` | None | `{patients: [...]}`; each includes caller's `role` |
| `POST /api/patients/{patientId}/invites` | `email`, `role` | `{invite}` |
| `GET /api/invites` | None | `{invites: [...]}` addressed to the caller |
| `POST /api/invites/{accessId}/accept` | `{}` | `{access}` |
| `GET /api/patients/{patientId}/access` | None | `{access: [...]}` |
| `DELETE /api/patients/{patientId}/access/{accessId}` | None | `{revoked: true}` |
| `POST /api/patients/{patientId}/prescribers` | `name`, optional `specialty`, `clinic`, `phone` | `{prescriber}` |
| `GET /api/patients/{patientId}/prescribers` | None | `{prescribers: [...]}` |
| `POST /api/patients/{patientId}/prescriptions` | See example below | `{prescription}` including `items` and `reconciliation` |
| `GET /api/patients/{patientId}/prescriptions` | None | `{prescriptions: [...]}` with nested `items` and prescriber context |
| `GET /api/patients/{patientId}/items` | None | `{items: [...]}` currently active medicines |
| `PATCH /api/patients/{patientId}/items/{itemId}` | `status`: `stopped` or `completed` | `{item, reconciliation}` |
| `POST /api/patients/{patientId}/conflicts/check` | `{}` | `{checked_items, new_conflicts, auto_resolved, conflicts}` |
| `GET /api/patients/{patientId}/conflicts` | `status`: `open` (default), `resolved`, `dismissed`, `all` | `{conflicts: [...]}` |
| `PATCH /api/patients/{patientId}/conflicts/{conflictId}` | `status`: `resolved` or `dismissed` | `{conflict}` |
| `POST /api/patients/{patientId}/items/{itemId}/schedules` | See example below | `{schedule}` |
| `GET /api/patients/{patientId}/schedules` | None | `{schedules: [...]}` |
| `PATCH /api/patients/{patientId}/schedules/{scheduleId}` | `is_active: false` | `{schedule}` |
| `POST /api/patients/{patientId}/doses/generate` | Optional `days_ahead`: integer 0-30, default 7 | `{schedules_processed, doses_created}` |
| `GET /api/patients/{patientId}/doses` | Optional `from`, `to` calendar dates | `{doses: [...]}` |
| `PATCH /api/patients/{patientId}/doses/{doseId}` | `status`: `taken` or `skipped` | `{dose}` or `409` with `{error, dose}` |

Signup requires a password of at least eight characters, with a maximum of
72 UTF-8 bytes. Email addresses are trimmed and lowercased. Hashes are never
returned. Patient timezones default to `Asia/Kolkata`; use named IANA zones,
for example `America/New_York` or `UTC`.

## Example: prescription to dose timeline

The examples below illustrate the API shape using synthetic medicine labels.
Replace IDs and dates with actual values returned by earlier requests.

1. Create an account with `POST /api/auth/signup`:

   ```json
   { "email": "caregiver@example.com", "password": "a-unique-long-password", "name": "Caregiver" }
   ```

   Keep the returned token in secure client storage and send it on later requests.

2. Create a patient with `POST /api/patients`:

   ```json
   { "full_name": "Example patient", "timezone": "Asia/Kolkata", "date_of_birth": "1958-03-15" }
   ```

3. Add a doctor with `POST /api/patients/{patientId}/prescribers`:

   ```json
   { "name": "Example doctor", "specialty": "Example specialty" }
   ```

4. Create a visit with `POST /api/patients/{patientId}/prescriptions`:

   ```json
   {
     "prescriber_id": "doctor-uuid-from-step-3",
     "visit_date": "2026-10-25",
     "notes": "Recorded from the prescription",
     "items": [{
       "raw_text": "Example brand, recorded instructions",
       "brand_name": "Example brand",
       "dose_amount": "As recorded on the prescription",
       "frequency": "As recorded on the prescription",
       "start_date": "2026-10-25",
       "end_date": "2026-11-01"
     }]
   }
   ```

   `prescriber_id`, `notes` and all item fields except `raw_text` are optional.
   Other supported item fields are `ingredient`, `strength`, and
   `replaces_item_id`. Omitted `dose_amount` defaults to `"1"`; omitted
   `start_date` defaults to today in the patient's timezone. A prescription
   accepts 1-100 items. Its doctor must belong to the same patient.
   The response's reconciliation object reports findings created during this write.

5. Add a rule with `POST /api/patients/{patientId}/items/{itemId}/schedules`:

   ```json
   { "time_of_day": "08:00", "days_of_week": [], "start_date": "2026-10-25", "end_date": "2026-11-01" }
   ```

   Empty/omitted `days_of_week` means every day; 0 is Sunday, 6 is Saturday.
   Otherwise use distinct integers such as `[1, 3, 5]`. Times use 24-hour
   `HH:MM` or `HH:MM:SS`. Schedule dates must stay within the medicine course.
   The default start is the later of today and the medicine start. The default
   end is the medicine's end date, or no end for an ongoing course.

6. Generate the timeline with `POST /api/patients/{patientId}/doses/generate`:

   ```json
   { "days_ahead": 7 }
   ```

   This includes today and the next seven calendar days, constrained by course
   dates and weekdays. Repeating it does not create duplicate dose events.
   Automatic background generation is planned with the notification worker.

7. Read `GET /api/patients/{patientId}/doses?from=2026-10-25&to=2026-10-25`.
   The entire `to` date is included, in the patient's timezone. Without dates,
   the range is today through seven days ahead. With `from` only, the range ends
   seven days after `from`. An explicitly supplied pair may span at most 90 days.
   Helpers always receive today, regardless of a requested range.

8. Confirm with `PATCH /api/patients/{patientId}/doses/{doseId}`:

   Each timeline dose includes `is_actionable`. Show confirmation controls only
   when it is true and the caller's role can confirm. Inactive historical pending
   doses stay visible for history, with no confirmation action.

   ```json
   { "status": "taken" }
   ```

   A successful result includes the dose ID, status and confirmation instant.
   Concurrent confirmations preserve the first server write. On `409`, refresh
   the timeline and show the returned saved status, confirmer and time when
   available. A `409` can also mean that the medicine/schedule is no longer
   eligible, or a helper attempted another day's dose. Do not automatically
   retry a conflicting confirmation or overwrite it. A missing dose is `404`.

## Replacements, history and conflict review

To record a changed prescription, create another visit and include
`replaces_item_id` on the new medicine. An immediate replacement stops its
previous item and deactivates the old schedules. A future `start_date` bounds
the previous course to the prior day. Replacements cannot be backdated, linked
across patients, or branched into multiple active replacements.

Stopping/completing a medicine or deactivating a schedule removes future pending
forecasts. Confirmed doses and historical pending records are retained.
Closed medicines are not reactivated; record a new prescription instead.

Duplicate names, differing recorded instructions and overdue active courses are
Level 1 findings. Already-recorded matching ingredients across brands are Level 2.
Unknown ingredients are not inferred. Findings include their source context;
the app should ask the family to check with the prescriber. Resolving/dismissing
a finding does not itself stop or alter a medicine.

Repeated checks preserve dismissals. Open findings automatically resolve when
their underlying recorded conflict disappears. `status=all` exposes history.
Time-driven checks and notification delivery are not implemented yet.
