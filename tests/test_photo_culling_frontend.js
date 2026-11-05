"use strict";

// Run with: node tests/test_photo_culling_frontend.js
// Exercise the production culling contracts without initializing the workbench DOM.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PhotoHistory } = require("../history.js");
const appPath = path.join(__dirname, "..", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const boundary = source.indexOf("const histogramSample =");
assert.ok(boundary > 0, "workbench initialization boundary must remain identifiable");
const context = vm.createContext({ console });
vm.runInContext(source.slice(0, boundary) + `
  globalThis.photoCullingTestApi = {
    normalizePhotoCullingMetadata, photoMatchesFilter, filteredPhotos,
    firstPhotoToSelectAfterFilter, setPhotoRating, setPhotoFlag,
    photoCullingShortcutAction, photoSnapshot, dirtyProjectSnapshot,
    setBrowsingState(list, id, flagFilter, minimumRating) {
      photos = list;
      currentId = id;
      photoFlagFilter = flagFilter;
      photoMinimumRating = minimumRating;
    }
  };
`, context);
const api = context.photoCullingTestApi;
const json = (value) => JSON.stringify(value);
const ids = (list) => Array.from(list, (photo) => photo.id);
const unfocused = { closest: () => null };

// Legacy projects default missing fields to 0/null; invalid frontend payloads are normalized safely.
const legacy = { id: "legacy", name: "旧项目", settings: { exposure: 0 }, lutId: null };
api.normalizePhotoCullingMetadata(legacy);
assert.equal(legacy.rating, 0);
assert.equal(legacy.flag, null);
const invalidMetadata = { id: "invalid", rating: 6, flag: "maybe" };
api.normalizePhotoCullingMetadata(invalidMetadata);
assert.equal(invalidMetadata.rating, 0);
assert.equal(invalidMetadata.flag, null);
const boundaryValues = { id: "edge", rating: 0, flag: null };
api.normalizePhotoCullingMetadata(boundaryValues);
assert.equal(boundaryValues.rating, 0);
assert.equal(boundaryValues.flag, null);
boundaryValues.rating = 5;
boundaryValues.flag = "reject";
api.normalizePhotoCullingMetadata(boundaryValues);
assert.equal(boundaryValues.rating, 5);
assert.equal(boundaryValues.flag, "reject");

// Filters combine flag state and a minimum rating while preserving original photo order.
const photos = [
  { id: "zero", rating: 0, flag: null },
  { id: "pick-two", rating: 2, flag: "pick" },
  { id: "reject-five", rating: 5, flag: "reject" },
  { id: "unflagged-four", rating: 4, flag: null }
];
assert.deepEqual(ids(api.filteredPhotos(photos, "all", 0)), ["zero", "pick-two", "reject-five", "unflagged-four"]);
assert.deepEqual(ids(api.filteredPhotos(photos, "pick", 2)), ["pick-two"]);
assert.deepEqual(ids(api.filteredPhotos(photos, "pick", 3)), []);
assert.deepEqual(ids(api.filteredPhotos(photos, "reject", 5)), ["reject-five"]);
assert.deepEqual(ids(api.filteredPhotos(photos, "unflagged", 1)), ["unflagged-four"]);
assert.deepEqual(ids(api.filteredPhotos(photos, "unrecognized", 0)), ["zero", "pick-two", "reject-five", "unflagged-four"]);
assert.equal(api.firstPhotoToSelectAfterFilter("zero", api.filteredPhotos(photos, "pick", 0)).id, "pick-two",
  "when filtering excludes the current photo, navigation chooses the first matching photo");
assert.equal(api.firstPhotoToSelectAfterFilter("pick-two", api.filteredPhotos(photos, "pick", 0)), null,
  "a current photo that still matches remains selected");
assert.equal(api.firstPhotoToSelectAfterFilter("zero", api.filteredPhotos(photos, "pick", 3)), null,
  "an empty filter result does not discard or replace the current project photo");

// Rating and flags affect the project dirty baseline, but browsing/filter state does not.
const projectPhotos = [
  { id: "a", name: "A.jpg", settings: { exposure: 0 }, lutId: null, rating: 0, flag: null },
  { id: "b", name: "B.jpg", settings: { exposure: 1 }, lutId: null, rating: 2, flag: "pick" }
];
api.setBrowsingState(projectPhotos, "a", "all", 0);
const dataBeforeBrowsing = json(projectPhotos);
const cleanBaseline = api.dirtyProjectSnapshot("筛选测试", projectPhotos);
api.setBrowsingState(projectPhotos, "b", "pick", 2);
assert.equal(api.dirtyProjectSnapshot("筛选测试", projectPhotos), cleanBaseline,
  "changing the selected photo or ephemeral filter does not mark project data dirty");
assert.equal(json(projectPhotos), dataBeforeBrowsing,
  "filtering/browsing does not change photo edit settings or metadata");
const legacyBaseline = api.dirtyProjectSnapshot("旧项目", [legacy]);
legacy.rating = 0;
legacy.flag = null;
assert.equal(api.dirtyProjectSnapshot("旧项目", [legacy]), legacyBaseline,
  "defaulting a legacy photo to 0/null does not make it dirty");
const metadataBaseline = api.dirtyProjectSnapshot("筛选测试", projectPhotos);
assert.equal(api.setPhotoRating(projectPhotos[0], 5), true);
assert.notEqual(api.dirtyProjectSnapshot("筛选测试", projectPhotos), metadataBaseline,
  "changing rating is included in the project dirty baseline");
const ratedBaseline = api.dirtyProjectSnapshot("筛选测试", projectPhotos);
assert.equal(api.setPhotoFlag(projectPhotos[0], "reject"), true);
assert.notEqual(api.dirtyProjectSnapshot("筛选测试", projectPhotos), ratedBaseline,
  "changing the flag is included in the project dirty baseline");
assert.equal(api.setPhotoRating(projectPhotos[0], 6), false, "ratings outside 0..5 are rejected by the frontend mutator");
assert.equal(api.setPhotoFlag(projectPhotos[0], "skip"), false, "unsupported flags are rejected by the frontend mutator");

// Culling operations stay outside each photo's edit-undo snapshot and history stack.
const historyPhoto = {
  id: "history-photo", name: "History.jpg", settings: { exposure: 0.25, composition: { rotation: 0 } },
  lutId: null, rating: 0, flag: null
};
const beforeCulling = api.photoSnapshot(historyPhoto);
const history = new PhotoHistory();
history.reset(historyPhoto.id, beforeCulling);
assert.equal(api.setPhotoRating(historyPhoto, 3), true);
assert.equal(api.setPhotoFlag(historyPhoto, "pick"), true);
assert.equal(json(api.photoSnapshot(historyPhoto)), json(beforeCulling),
  "rating and flag are absent from the photo edit snapshot");
assert.equal(history.canUndo(historyPhoto.id), false,
  "rating and flag changes do not create edit-history entries");

// Keyboard mapping and guards: 0-5, P/X/U; ignore modifiers, editable fields, dialogs and IME input.
const action = (key, overrides = {}, dialogOpen = false) => api.photoCullingShortcutAction({
  key, target: unfocused, ...overrides
}, dialogOpen);
for (let rating = 0; rating <= 5; rating += 1) {
  assert.equal(json(action(String(rating))), json({ type: "rating", value: rating }));
}
assert.equal(json(action("P")), json({ type: "flag", value: "pick" }));
assert.equal(json(action("x")), json({ type: "flag", value: "reject" }));
assert.equal(json(action("u")), json({ type: "flag", value: null }));
assert.equal(action("q"), null);
for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
  assert.equal(action("p", { [modifier]: true }), null, `${modifier} suppresses culling shortcuts`);
}
assert.equal(action("3", { defaultPrevented: true }), null);
assert.equal(action("3", { isComposing: true }), null);
assert.equal(action("3", {}, true), null, "open dialogs suppress culling shortcuts");
for (const marker of ["input", "textarea", "select", "[contenteditable]", '[role="textbox"]']) {
  const editableTarget = { closest: (selector) => selector.includes(marker) ? editableTarget : null };
  assert.equal(api.photoCullingShortcutAction({ key: "4", target: editableTarget }), null,
    `${marker} focus suppresses culling shortcuts`);
}
assert.equal(api.photoCullingShortcutAction({ key: "4", target: { closest: () => null, isContentEditable: true } }), null,
  "contenteditable focus suppresses culling shortcuts");

// Selector/accessibility contract for independent interaction testing.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
for (const id of [
  "film-filter-all", "film-filter-pick", "film-filter-reject", "film-filter-unflagged", "film-min-rating", "film-items",
  "photo-rating-1", "photo-rating-2", "photo-rating-3", "photo-rating-4", "photo-rating-5", "photo-rating-clear",
  "photo-flag-pick", "photo-flag-reject", "photo-flag-clear"
]) assert.match(html, new RegExp(`id="${id}"`), `required UI selector #${id} exists`);
assert.match(html, /aria-label="设置当前照片星级"/);
assert.match(html, /aria-label="设置当前照片旗标"/);
assert.match(source, /photoCullingShortcutAction\(event, Boolean\(document\.querySelector\("dialog\[open\]"\)\)\)/,
  "global key handler consults the culling shortcut guard");
const selectionStart = source.indexOf("async function selectPhoto(");
const selectionEnd = source.indexOf("\nfunction showEdited(", selectionStart);
assert.ok(selectionStart > 0 && selectionEnd > selectionStart, "photo selection implementation remains identifiable");
assert.match(source.slice(selectionStart, selectionEnd), /finishPhotoGestures\(false\)/,
  "switching/browsing commits in-progress edits instead of rolling settings back");
const css = fs.readFileSync(path.join(__dirname, "..", "app.css"), "utf8");
assert.match(css, /width: 91px; height: 73px;/, "thumbnail scale remains 91×73 on desktop");
assert.match(css, /grid-template-rows: 25px minmax\(73px, 1fr\)/, "desktop filter row and thumbnail rail fit the compact filmstrip");

console.log("Frontend photo-culling contracts: all assertions passed.");
