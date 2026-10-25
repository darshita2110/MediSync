-- Reject inconsistent records rather than silently repairing or deleting them.
ALTER TABLE users ADD CONSTRAINT users_email_normalized
  CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254);
ALTER TABLE patients ADD CONSTRAINT patients_name_not_blank CHECK (btrim(full_name) <> '');
ALTER TABLE prescribers ADD CONSTRAINT prescribers_name_not_blank CHECK (btrim(name) <> '');
ALTER TABLE prescription_items ADD CONSTRAINT items_text_not_blank CHECK (btrim(raw_text) <> '' AND btrim(dose_amount) <> '');
ALTER TABLE prescription_items ADD CONSTRAINT items_valid_dates CHECK (end_date IS NULL OR end_date >= start_date);
ALTER TABLE prescription_items ADD CONSTRAINT items_cannot_replace_self CHECK (replaces_item_id IS NULL OR replaces_item_id <> id);
ALTER TABLE schedules ADD CONSTRAINT schedules_valid_dates CHECK (end_date IS NULL OR end_date >= start_date);
ALTER TABLE schedules ADD CONSTRAINT schedules_valid_weekdays CHECK (
  days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND
  array_position(days_of_week, NULL) IS NULL AND cardinality(days_of_week) <= 7);
ALTER TABLE schedules ADD CONSTRAINT schedules_valid_time CHECK (time_of_day < TIME '24:00');
ALTER TABLE patient_access ADD CONSTRAINT access_owner_accepted CHECK (
  role <> 'owner' OR (status = 'accepted' AND invited_by IS NULL));
CREATE UNIQUE INDEX one_accepted_owner_per_patient ON patient_access(patient_id)
  WHERE role = 'owner' AND status = 'accepted';

-- The individual UUID foreign keys are retained for their existing deletion
-- behavior. These composite keys additionally prevent cross-patient links.
ALTER TABLE prescribers ADD CONSTRAINT prescribers_id_patient_unique UNIQUE (id, patient_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_id_patient_unique UNIQUE (id, patient_id);
ALTER TABLE prescription_items ADD CONSTRAINT items_id_patient_unique UNIQUE (id, patient_id);
ALTER TABLE schedules ADD CONSTRAINT schedules_id_patient_unique UNIQUE (id, patient_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_doctor_patient_fk
  FOREIGN KEY (prescriber_id, patient_id) REFERENCES prescribers(id, patient_id);
ALTER TABLE prescription_items ADD CONSTRAINT items_prescription_patient_fk
  FOREIGN KEY (prescription_id, patient_id) REFERENCES prescriptions(id, patient_id) ON DELETE CASCADE;
ALTER TABLE prescription_items ADD CONSTRAINT items_replacement_patient_fk
  FOREIGN KEY (replaces_item_id, patient_id) REFERENCES prescription_items(id, patient_id);
ALTER TABLE schedules ADD CONSTRAINT schedules_item_patient_fk
  FOREIGN KEY (prescription_item_id, patient_id) REFERENCES prescription_items(id, patient_id) ON DELETE CASCADE;
ALTER TABLE dose_events ADD CONSTRAINT doses_schedule_patient_fk
  FOREIGN KEY (schedule_id, patient_id) REFERENCES schedules(id, patient_id) ON DELETE CASCADE;
ALTER TABLE conflicts ADD CONSTRAINT conflicts_item_a_patient_fk
  FOREIGN KEY (item_a_id, patient_id) REFERENCES prescription_items(id, patient_id) ON DELETE CASCADE;
ALTER TABLE conflicts ADD CONSTRAINT conflicts_item_b_patient_fk
  FOREIGN KEY (item_b_id, patient_id) REFERENCES prescription_items(id, patient_id) ON DELETE CASCADE;

ALTER TABLE dose_events ADD CONSTRAINT doses_confirmation_consistent CHECK (
  (status IN ('taken', 'skipped') AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL) OR
  (status IN ('pending', 'missed') AND confirmed_by IS NULL AND confirmed_at IS NULL));
ALTER TABLE conflicts ADD CONSTRAINT conflicts_valid_level CHECK (level BETWEEN 1 AND 4);
ALTER TABLE conflicts ADD CONSTRAINT conflicts_distinct_items CHECK (item_b_id IS NULL OR item_b_id <> item_a_id);
ALTER TABLE conflicts ADD CONSTRAINT conflicts_resolution_consistent CHECK (
  (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL) OR
  (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL));
CREATE UNIQUE INDEX one_open_conflict_per_pair ON conflicts (
  patient_id, kind,
  LEAST(item_a_id, COALESCE(item_b_id, item_a_id)),
  GREATEST(item_a_id, COALESCE(item_b_id, item_a_id)))
  WHERE status = 'open' AND item_a_id IS NOT NULL;
CREATE INDEX idx_patient_dose_timeline ON dose_events(patient_id, scheduled_for);
CREATE INDEX idx_patient_open_conflicts ON conflicts(patient_id, created_at DESC) WHERE status = 'open';
