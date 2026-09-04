// src/controllers/conflicts.controller.js
// Level 1 reconciliation: flag when the same medicine appears more than
// once among a patient's currently-active items.
//
// "Same medicine" at Level 1 means same ingredient if we know it, else
// same brand name (case-insensitive). Catching same-ingredient-different-
// brand in general (Telmikind vs Telma) is Level 2 and needs a brand->
// ingredient map; that comes later.

const db = require('../config/db');
const { logAction } = require('../utils/audit');

// Pull the patient's active items (same rule as the /items endpoint).
async function getActiveItems(patientId) {
  const result = await db.query(
    `SELECT id, raw_text, brand_name, ingredient
     FROM prescription_items
     WHERE patient_id = $1
       AND status = 'active'
       AND (end_date IS NULL OR end_date >= CURRENT_DATE)`,
    [patientId]
  );
  return result.rows;
}

// Group items by a normalized key (ingredient if present, else brand).
// Returns an array of groups that have 2+ items — those are the clashes.
function findDuplicateGroups(items) {
  const groups = new Map();

  for (const item of items) {
    // Prefer ingredient; fall back to brand. Lowercase + trim so
    // "Telmikind" and "telmikind " land in the same bucket.
    const raw = item.ingredient || item.brand_name;
    if (!raw) continue;                      // nothing to compare on
    const key = raw.toLowerCase().trim();

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const dupes = [];
  for (const [key, groupItems] of groups) {
    if (groupItems.length >= 2) dupes.push({ key, items: groupItems });
  }
  return dupes;
}

// POST /api/patients/:patientId/conflicts/check
// Runs the check now and records any NEW conflicts found.
async function runCheck(req, res) {
  if (req.patientRole === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot run checks' });
  }
  const { patientId } = req.params;

  try {
    const items = await getActiveItems(patientId);
    const dupes = findDuplicateGroups(items);

    const created = [];
    for (const group of dupes) {
      // Flag the first two items in the group as the clashing pair.
      const [a, b] = group.items;
      const label = a.ingredient || a.brand_name;
      const description =
        `"${label}" appears more than once in the active medicine list ` +
        `(${group.items.length} times). Two doctors may have prescribed the ` +
        `same medicine without knowing.`;

      // Avoid piling up identical open conflicts for the same pair if the
      // check is run repeatedly: only insert if no open one already exists.
      const existing = await db.query(
        `SELECT id FROM conflicts
         WHERE patient_id = $1 AND status = 'open'
           AND kind = 'duplicate_medicine'
           AND ((item_a_id = $2 AND item_b_id = $3)
             OR (item_a_id = $3 AND item_b_id = $2))`,
        [patientId, a.id, b.id]
      );
      if (existing.rows.length > 0) continue;

      const inserted = await db.query(
        `INSERT INTO conflicts
           (patient_id, level, kind, description, item_a_id, item_b_id, status)
         VALUES ($1, 1, 'duplicate_medicine', $2, $3, $4, 'open')
         RETURNING id, level, kind, description, status, created_at`,
        [patientId, description, a.id, b.id]
      );
      created.push(inserted.rows[0]);
    }

    if (created.length > 0) {
      await logAction(patientId, req.user.id, 'conflicts.detected',
        { count: created.length });
    }

    return res.json({
      checked_items: items.length,
      new_conflicts: created.length,
      conflicts: created,
    });
  } catch (err) {
    console.error('Run check error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/patients/:patientId/conflicts   (?status=open|resolved|dismissed)
async function listConflicts(req, res) {
  const { patientId } = req.params;
  const status = req.query.status || 'open';

  try {
    const result = await db.query(
      `SELECT c.id, c.level, c.kind, c.description, c.status, c.created_at,
              a.raw_text AS item_a_text, b.raw_text AS item_b_text
       FROM conflicts c
       LEFT JOIN prescription_items a ON a.id = c.item_a_id
       LEFT JOIN prescription_items b ON b.id = c.item_b_id
       WHERE c.patient_id = $1 AND c.status = $2
       ORDER BY c.created_at DESC`,
      [patientId, status]
    );
    return res.json({ conflicts: result.rows });
  } catch (err) {
    console.error('List conflicts error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// PATCH /api/patients/:patientId/conflicts/:conflictId
// Body: { status: 'resolved' | 'dismissed' }
async function updateConflict(req, res) {
  if (req.patientRole === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot change conflicts' });
  }
  const { patientId, conflictId } = req.params;
  const { status } = req.body;

  if (!['resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: "status must be 'resolved' or 'dismissed'" });
  }

  try {
    const result = await db.query(
      `UPDATE conflicts
       SET status = $1, resolved_at = now(), resolved_by = $2
       WHERE id = $3 AND patient_id = $4
       RETURNING id, status, resolved_at`,
      [status, req.user.id, conflictId, patientId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conflict not found for this patient' });
    }
    await logAction(patientId, req.user.id, 'conflict.' + status,
      { conflict_id: conflictId });
    return res.json({ conflict: result.rows[0] });
  } catch (err) {
    console.error('Update conflict error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = { runCheck, listConflicts, updateConflict };