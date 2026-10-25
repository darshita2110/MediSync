const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findFindings } = require('../src/services/reconciliation');

const item = (id, fields = {}) => ({ id, raw_text: 'Example', brand_name: 'Example', status: 'active', start_date: '2026-01-01',
  end_date: null, dose_amount: '1 tablet', frequency: 'daily', strength: '10 mg', prescriber_name: 'Dr. Test', visit_date: '2026-01-01', ...fields });

test('Level 1 compares every duplicate pair with normalized names and doctor context', () => {
  const findings = findFindings([item('c'), item('a', { brand_name: '  EXAMPLE  ' }), item('b')], '2026-10-25');
  assert.equal(findings.length, 3);
  assert.ok(findings.every(f => f.kind === 'duplicate_medicine' && f.level === 1 && f.item_a_id < f.item_b_id));
  assert.match(findings[0].description, /Dr\. Test/);
  assert.match(findings[0].description, /check both prescriptions/);
});

test('different recorded instructions are flagged separately without recommending a dose', () => {
  const findings = findFindings([item('a'), item('b', { dose_amount: '2 tablets', frequency: 'twice daily' })], '2026-10-25');
  assert.deepEqual(findings.map(f => f.kind), ['duplicate_medicine', 'different_instructions']);
  assert.match(findings[1].description, /1 tablet/);
  assert.match(findings[1].description, /2 tablets/);
});

test('ended courses are flagged, while stopped and future medicines are not compared', () => {
  const findings = findFindings([item('a'), item('b', { start_date: '2027-01-01' }), item('c', { status: 'stopped' }), item('d', { end_date: '2026-10-24' })], '2026-10-25');
  assert.deepEqual(findings.map(f => [f.kind, f.item_a_id]), [['course_ended', 'd']]);
});

test('known ingredient matches across different brands are labelled Level 2; unknowns are not guessed', () => {
  const findings = findFindings([item('a', { brand_name: 'A', ingredient: ' Ingredient X ' }), item('b', { brand_name: 'B', ingredient: 'ingredient x' }), item('c', { brand_name: 'Unknown' })], '2026-10-25');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'same_ingredient');
  assert.equal(findings[0].level, 2);
});
