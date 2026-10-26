const { test } = require('node:test');
const assert = require('node:assert/strict');
// Importing the service creates a pool but never connects without a tick.
const { reminderDecision } = require('../src/services/reminders');
const due = new Date('2026-10-26T08:00:00Z');
const dose = { scheduled_for: due };
const at = minute => new Date(due.getTime() + minute * 60000);

test('reminder deadlines, future doses and maximum count are deterministic', () => {
  const state = { reminders_sent: 0, next_reminder_at: due };
  assert.equal(reminderDecision(dose, state, at(-1)), 'wait');
  assert.equal(reminderDecision(dose, state, at(0)), 'reminder');
  assert.equal(reminderDecision(dose, { reminders_sent: 3, next_reminder_at: due }, at(30)), 'wait');
  assert.equal(reminderDecision(dose, state, at(45)), 'missed');
  assert.equal(reminderDecision(dose, state, at(1000)), 'missed');
});

test('snoozing defers the next reminder but never defers escalation', () => {
  const state = { reminders_sent: 1, next_reminder_at: at(44) };
  assert.equal(reminderDecision(dose, state, at(43)), 'wait');
  assert.equal(reminderDecision(dose, state, at(44)), 'reminder');
  assert.equal(reminderDecision(dose, { ...state, next_reminder_at: at(60) }, at(45)), 'missed');
});
