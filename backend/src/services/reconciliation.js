const { transaction } = require('../utils/transaction');

function normalize(value) { return (value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function key(finding) {
  return `${finding.kind}:${[finding.item_a_id, finding.item_b_id].filter(Boolean).sort().join(':')}`;
}

// These are comparisons of recorded data, not instructions to change treatment.
function findFindings(items, today) {
  const findings = [];
  const active = items.filter(i => i.status === 'active' && i.start_date <= today && (!i.end_date || i.end_date >= today));
  const replaced = new Set(active.map(i => i.replaces_item_id).filter(Boolean));
  const source = i => `${i.prescriber_name || 'an unspecified doctor'} (${i.visit_date})`;
  for (const item of items) {
    if (item.status === 'active' && item.end_date && item.end_date < today && !replaced.has(item.id)) {
      findings.push({ kind: 'course_ended', level: 1, item_a_id: item.id, item_b_id: null,
        description: `${item.raw_text}, prescribed by ${source(item)}, has a recorded end date of ${item.end_date} but remains marked active. Please check the intended course with the prescriber.` });
    }
  }
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const left = active[a], right = active[b];
      const sameBrand = normalize(left.brand_name || left.raw_text) === normalize(right.brand_name || right.raw_text);
      const sameIngredient = !!normalize(left.ingredient) && normalize(left.ingredient) === normalize(right.ingredient);
      if (!sameBrand && !sameIngredient) continue;
      const [itemA, itemB] = [left.id, right.id].sort();
      const context = `${left.raw_text} from ${source(left)} and ${right.raw_text} from ${source(right)}`;
      findings.push({ kind: sameBrand ? 'duplicate_medicine' : 'same_ingredient', level: sameBrand ? 1 : 2,
        item_a_id: itemA, item_b_id: itemB,
        description: `${context} ${sameBrand ? 'have the same recorded medicine name' : 'have the same recorded ingredient'}. Please check both prescriptions with either doctor.` });
      const differences = ['dose_amount', 'frequency', 'strength'].filter(field =>
        normalize(left[field]) && normalize(right[field]) && normalize(left[field]) !== normalize(right[field]));
      if (sameBrand && differences.length) {
        findings.push({ kind: 'different_instructions', level: 1, item_a_id: itemA, item_b_id: itemB,
          description: `${context} have different recorded ${differences.join(', ')}: ` +
            differences.map(field => `${field}: "${left[field]}" / "${right[field]}"`).join('; ') +
            '. Please ask the prescriber to clarify the instructions.' });
      }
    }
  }
  return findings;
}

async function lockPatient(client, patientId) {
  await client.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
}

async function reconcileWithClient(client, patientId, actorUserId) {
  // All reconciliation and prescription/lifecycle writes use the same patient
  // row lock, preventing concurrent checks from inserting the same finding.
  await lockPatient(client, patientId);
  const patient = await client.query('SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM patients WHERE id = $1', [patientId]);
  const result = await client.query(
    `SELECT pi.id, pi.raw_text, pi.brand_name, pi.ingredient, pi.dose_amount, pi.frequency, pi.strength,
            pi.start_date::text, pi.end_date::text, pi.status, pi.replaces_item_id, d.name AS prescriber_name, pr.visit_date::text
     FROM prescription_items pi JOIN prescriptions pr ON pr.id = pi.prescription_id
     LEFT JOIN prescribers d ON d.id = pr.prescriber_id AND d.patient_id = pr.patient_id
     WHERE pi.patient_id = $1 ORDER BY pi.id`, [patientId]);
  const today = patient.rows[0].today;
  const findings = findFindings(result.rows, today);
  const existing = await client.query(
    `SELECT id, kind, item_a_id, item_b_id, status FROM conflicts
     WHERE patient_id = $1 AND kind IN ('duplicate_medicine', 'same_ingredient', 'different_instructions', 'course_ended')`, [patientId]);
  const known = new Set(existing.rows.map(key));
  const current = new Set(findings.map(key));
  const created = [];
  for (const finding of findings) {
    if (known.has(key(finding))) continue;
    const saved = await client.query(
      `INSERT INTO conflicts (patient_id, level, kind, description, item_a_id, item_b_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [patientId, finding.level, finding.kind, finding.description, finding.item_a_id, finding.item_b_id]);
    created.push(saved.rows[0]);
    known.add(key(finding));
  }
  let autoResolved = 0;
  for (const conflict of existing.rows) {
    if (conflict.status !== 'open' || current.has(key(conflict))) continue;
    await client.query(
      `UPDATE conflicts SET status = 'resolved', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
      [conflict.id, actorUserId || null]);
    autoResolved++;
  }
  if (created.length || autoResolved) {
    await client.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details)
       VALUES ($1, $2, 'conflicts.reconciled', $3)`,
      [patientId, actorUserId || null, { created: created.length, auto_resolved: autoResolved }]);
  }
  return { checked_items: result.rows.filter(i => i.status === 'active' && i.start_date <= today && (!i.end_date || i.end_date >= today)).length,
    new_conflicts: created.length, auto_resolved: autoResolved, conflicts: created };
}

async function reconcile(patientId, actorUserId, client) {
  if (client) return reconcileWithClient(client, patientId, actorUserId);
  return transaction(tx => reconcileWithClient(tx, patientId, actorUserId));
}

module.exports = { findFindings, reconcile, lockPatient };
