'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/webmcp-schema.js');

const icon = (name, description) => S.iconForTool({ name, description });

// --- The ordering bug -----------------------------------------------------

test('the action wins over the subject', () => {
  // Regression: `book` used to be tested before `cancel`, so this was 📅.
  assert.strictEqual(icon('cancelBooking'), '🗑');
  assert.strictEqual(icon('delete-appointment'), '🗑');
  assert.strictEqual(icon('removeFromCart'), '🗑');
  assert.strictEqual(icon('createFeature'), '➕');
});

test('a tool that really is about booking still gets the calendar', () => {
  assert.strictEqual(icon('book-slot'), '📅');
  assert.strictEqual(icon('reserveTable'), '📅');
});

// --- Whole tokens, never substrings ---------------------------------------

test('substring collisions no longer decide the icon', () => {
  // Each of these matched the wrong rule when the test was a regex on the
  // whole string.
  assert.notStrictEqual(icon('setPayload'), '🛒');   // 'pay' inside 'payload'
  assert.notStrictEqual(icon('budgetSummary'), '📋'); // 'get' inside 'budget'
  assert.notStrictEqual(icon('installPlugin'), '📋'); // 'all' inside 'install'
  assert.notStrictEqual(icon('recreateIndex'), '➕'); // 'create' inside 'recreate'
});

test('update is an edit, not a date', () => {
  assert.strictEqual(icon('update'), '✏️');
  assert.strictEqual(icon('updateProfile'), '✏️');
});

test('plurals still match their singular rule', () => {
  assert.strictEqual(icon('listTodos'), '📋');
  assert.strictEqual(icon('getItems'), '📋');
  assert.strictEqual(icon('searchFlights'), '🔍');
});

// --- Travel ---------------------------------------------------------------

test('travel tools get the plane', () => {
  assert.strictEqual(icon('flightStatus'), '✈️');
  assert.strictEqual(icon('bookFlight'), '✈️', 'the subject is more telling than "book" here');
  assert.strictEqual(icon('hotel-availability'), '✈️');
});

// --- Name first, description second ---------------------------------------

test('the description only speaks when the name says nothing', () => {
  assert.strictEqual(icon('xyzzy', 'Deletes the current record.'), '🗑');
  // The name is decisive: prose mentioning other verbs must not override it.
  assert.strictEqual(
    icon('createFeature', 'Use this instead of trying to delete or cancel anything.'),
    '➕'
  );
});

// --- Default --------------------------------------------------------------

test('anything unrecognised falls back to the bolt', () => {
  assert.strictEqual(icon('xyzzy'), '⚡');
  assert.strictEqual(icon(''), '⚡');
  assert.strictEqual(S.iconForTool(null), '⚡');
  assert.strictEqual(S.iconForTool({}), '⚡');
});
