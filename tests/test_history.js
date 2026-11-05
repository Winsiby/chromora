"use strict";

// Run with: node tests/test_history.js
const assert = require("node:assert/strict");
const { PhotoHistory } = require("../history.js");

const history = new PhotoHistory(3);
const initial = { settings: { exposure: 0, curves: { rgb: [[0, 0], [1, 1]] } }, lutId: null };
history.reset("a", initial);
history.reset("b", initial);

const once = { settings: { exposure: 1, curves: { rgb: [[0, 0], [1, 1]] } }, lutId: null };
assert.equal(history.record("a", initial, once), true, "one completed gesture records one action");
assert.equal(history.canUndo("a"), true);
assert.equal(history.canRedo("a"), false);
assert.equal(history.canUndo("b"), false, "each photo has its own history");

const undo = history.undo("a", once);
assert.deepEqual(undo, initial);
assert.equal(history.canUndo("a"), false);
assert.equal(history.canRedo("a"), true);
const redo = history.redo("a", undo);
assert.deepEqual(redo, once);
assert.equal(history.canUndo("a"), true);
assert.equal(history.canRedo("a"), false);

assert.equal(history.record("a", once, once), false, "no-op does not create a step");
assert.equal(history.canRedo("a"), false);
assert.deepEqual(history.undo("a", once), initial);
const branch = { settings: { exposure: -1, curves: { rgb: [[0, 0], [1, 1]] } }, lutId: null };
assert.equal(history.record("a", initial, branch), true);
assert.equal(history.canRedo("a"), false, "a new edit clears the redo branch");

// Snapshots are cloned on both insert and return; callers cannot mutate history in place.
branch.settings.exposure = 99;
const stableUndo = history.undo("a", { settings: { exposure: -1, curves: { rgb: [[0, 0], [1, 1]] } }, lutId: null });
assert.equal(stableUndo.settings.exposure, 0);
stableUndo.settings.curves.rgb[0][0] = 0.5;
assert.deepEqual(history.redo("a", stableUndo).settings.curves.rgb, [[0, 0], [1, 1]]);

history.resetAll([["a", once], ["b", initial]]);
assert.equal(history.canUndo("a"), false, "reopening a project resets its in-memory history");
assert.equal(history.canRedo("a"), false);
assert.equal(history.canUndo("b"), false);

console.log("PhotoHistory: all assertions passed.");
