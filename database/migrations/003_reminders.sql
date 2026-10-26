-- Reminder decisions and the inbox are durable even when no push provider exists.
CREATE TABLE dose_reminder_state (
  dose_id UUID PRIMARY KEY REFERENCES dose_events(id) ON DELETE CASCADE,
  reminders_sent SMALLINT NOT NULL DEFAULT 0 CHECK (reminders_sent BETWEEN 0 AND 3),
  next_reminder_at TIMESTAMPTZ NOT NULL,
  snoozed_until TIMESTAMPTZ
);

ALTER TABLE dose_events ADD CONSTRAINT doses_id_patient_unique UNIQUE (id, patient_id);
CREATE TABLE care_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  dose_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'missed')),
  stage SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  UNIQUE (user_id, dose_id, stage),
  FOREIGN KEY (dose_id, patient_id) REFERENCES dose_events(id, patient_id) ON DELETE CASCADE,
  CHECK ((kind = 'reminder' AND stage BETWEEN 0 AND 2) OR (kind = 'missed' AND stage = 3))
);
CREATE INDEX idx_care_notifications_inbox ON care_notifications(user_id, created_at DESC, id DESC);
CREATE INDEX idx_pending_worker_doses ON dose_events(patient_id, scheduled_for) WHERE status = 'pending';

CREATE TABLE patient_worker_state (
  patient_id UUID PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  reconciled_day DATE NOT NULL
);
CREATE TABLE reminder_worker_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_completed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ
);
INSERT INTO reminder_worker_status (singleton) VALUES (TRUE);
