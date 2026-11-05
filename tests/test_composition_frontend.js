"use strict";

// Run with: node tests/test_composition_frontend.js
// Exercise the production geometry functions without initializing the DOM/workbench.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PhotoHistory } = require("../history.js");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const boundary = source.indexOf("const histogramSample =");
assert.ok(boundary > 0, "workbench initialization boundary must remain identifiable");
const context = vm.createContext({ console });
vm.runInContext(source.slice(0, boundary) + `
  globalThis.geometry = {
    setComposition(composition) {
      sourceImageSize = { width: 1200, height: 800 };
      photos = [{ id: "fixture", settings: { composition } }];
      currentId = "fixture";
      actualZoom = false;
      fullOriginal = undefined;
    },
    setFullCrop(width, height) {
      actualZoom = true;
      fullOriginal = { width, height, compositionKey: JSON.stringify(photoComposition()) };
    },
    centeredCropForAspect, cropForAspectAtCenter, rotateCropPoint, rotateCropRectangle,
    resizeCropCorner, gradeWheelMarkerPosition, gradeWheelPointerHitsMarker, gradeWheelPointFromClient, gradeWheelValuesAtPoint, sourcePointToOutput,
    outputPointToSource, sourceToOutputMatrix, cropPointToScreen,
    screenPointToCrop, rotatedDimensions,
    editComposition(action, value) {
      const originalChangeComposition = changeComposition;
      const originalSetStatus = setStatus;
      changeComposition = (mutator) => mutator(photos[0].settings.composition);
      setStatus = () => {};
      try {
        if (action === "rotate") rotateComposition(value);
        else chooseAspect(value);
        return JSON.parse(JSON.stringify(photos[0].settings.composition));
      } finally {
        changeComposition = originalChangeComposition;
        setStatus = originalSetStatus;
      }
    }
  };
`, context);
const api = context.geometry;
const defaults = { crop: null, aspect: "free", rotation: 0, straighten: 0 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const pointNear = (actual, expected, message) => {
  near(actual.x, expected.x, message + ": x");
  near(actual.y, expected.y, message + ": y");
};
api.setComposition(defaults);
assert.deepEqual(Array.from(api.sourceToOutputMatrix()), [1, 0, 0, 1, 0, 0]);

for (const hue of [0, 30, 90, 180, 240, 315]) {
  for (const saturation of [0, 1, 50, 83, 100]) {
    const marker = api.gradeWheelMarkerPosition(hue, saturation);
    const rect = { left: 17, top: 29, width: 114, height: 114 };
    const metrics = { borderLeft: 1, borderTop: 1, width: 112, height: 112 };
    const click = api.gradeWheelPointFromClient(
      rect.left + metrics.borderLeft + marker.x * metrics.width,
      rect.top + metrics.borderTop + marker.y * metrics.height,
      rect,
      metrics
    );
    near(click.x, marker.x, "border-box marker click x");
    near(click.y, marker.y, "border-box marker click y");
    const values = api.gradeWheelValuesAtPoint(click.x, click.y, hue);
    assert.equal(values.hue, hue, "marker click preserves hue");
    assert.equal(values.saturation, saturation, `marker click preserves ${hue}°/${saturation}%`);
    const roundedPixelClick = { x: click.x + 0.5 / metrics.width, y: click.y - 0.5 / metrics.height };
    assert.equal(api.gradeWheelPointerHitsMarker(roundedPixelClick, hue, saturation, metrics.width), true,
      `pixel-rounded click on ${hue}°/${saturation}% marker is treated as the same marker`);
  }
}

for (const rotation of [0, 90, 180, 270]) {
  const composition = { ...defaults, rotation };
  api.setComposition(composition);
  for (const [preset, ratio] of [["1:1", 1], ["4:5", 4 / 5], ["3:2", 3 / 2], ["16:9", 16 / 9]]) {
    const crop = api.centeredCropForAspect(preset, composition);
    const dimensions = api.rotatedDimensions(composition);
    near(crop.width * dimensions.width / (crop.height * dimensions.height), ratio, preset + " aspect");
    near(crop.x + crop.width / 2, 0.5, "centered crop x");
    near(crop.y + crop.height / 2, 0.5, "centered crop y");
  }
  assert.equal(JSON.stringify(api.centeredCropForAspect("original", composition)), JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }));
}

api.setComposition({ ...defaults });
const selectedBeforeRotation = api.editComposition("aspect", "4:5");
const rotatedAfterSelection = api.editComposition("rotate", 90);
assert.equal(rotatedAfterSelection.aspect, "4:5", "rotating must retain the selected output ratio");
let rotatedDimensions = api.rotatedDimensions(rotatedAfterSelection);
let rotatedCrop = rotatedAfterSelection.crop;
near(rotatedCrop.width * rotatedDimensions.width / (rotatedCrop.height * rotatedDimensions.height), 4 / 5,
  "select 4:5 then rotate keeps exact output ratio");
assert.ok(rotatedCrop.x >= 0 && rotatedCrop.y >= 0 && rotatedCrop.x + rotatedCrop.width <= 1 &&
  rotatedCrop.y + rotatedCrop.height <= 1, "rotated fixed-ratio crop stays inside the image");

const history = new PhotoHistory();
const snapshot = (composition) => ({ settings: { composition: JSON.parse(JSON.stringify(composition)) }, lutId: null });
history.reset("ratio-rotation", snapshot(selectedBeforeRotation));
assert.equal(history.record("ratio-rotation", snapshot(selectedBeforeRotation), snapshot(rotatedAfterSelection)), true);
assert.deepEqual(history.undo("ratio-rotation", snapshot(rotatedAfterSelection)), snapshot(selectedBeforeRotation),
  "undo restores the pre-rotation crop and ratio");
assert.deepEqual(history.redo("ratio-rotation", snapshot(selectedBeforeRotation)), snapshot(rotatedAfterSelection),
  "redo restores the recomputed rotated crop and ratio");

api.setComposition({ ...defaults, rotation: 90 });
const selectedAfterRotation = api.editComposition("aspect", "4:5");
assert.equal(selectedAfterRotation.aspect, "4:5", "selecting a fixed ratio after rotation retains the ratio");
rotatedDimensions = api.rotatedDimensions(selectedAfterRotation);
rotatedCrop = selectedAfterRotation.crop;
near(rotatedCrop.width * rotatedDimensions.width / (rotatedCrop.height * rotatedDimensions.height), 4 / 5,
  "rotate then select 4:5 keeps exact output ratio");

api.setComposition({
  ...defaults,
  aspect: "4:5",
  crop: { x: 0.31, y: 0.4, width: 0.32, height: 0.6 }
});
const offCenterRotated = api.editComposition("rotate", 90);
const offCenterCrop = offCenterRotated.crop;
near(offCenterCrop.x + offCenterCrop.width / 2, 0.5, "rotated crop center is clamped horizontally");
near(offCenterCrop.y + offCenterCrop.height / 2, 0.47, "rotated crop favors the transformed previous center");
rotatedDimensions = api.rotatedDimensions(offCenterRotated);
near(offCenterCrop.width * rotatedDimensions.width / (offCenterCrop.height * rotatedDimensions.height), 4 / 5,
  "off-center crop remains 4:5 after rotation");

const initial = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
for (const [handle, point] of [["nw", { x: 0.2, y: 0.2 }], ["ne", { x: 0.8, y: 0.2 }], ["se", { x: 0.8, y: 0.8 }], ["sw", { x: 0.2, y: 0.8 }]]) {
  const crop = api.resizeCropCorner(initial, handle, point, defaults);
  near(crop.width, 0.7, handle + " width");
  near(crop.height, 0.7, handle + " height");
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1 && crop.y + crop.height <= 1);
}
const locked = { ...defaults, aspect: "4:5" };
api.setComposition(locked);
const singleAxis = api.resizeCropCorner({ x: 0.2, y: 0.1, width: 0.4, height: 0.75 }, "nw", { x: 0.3, y: 0.1 }, locked);
near(singleAxis.width, 0.3, "locked aspect horizontal shrink");
near(singleAxis.height, 0.5625, "locked aspect coupled height");
for (const aspect of ["free", "original", "1:1", "4:5", "3:2", "16:9"]) {
  const composition = { ...defaults, aspect };
  api.setComposition(composition);
  for (const handle of ["nw", "ne", "se", "sw"]) {
    for (const point of [{ x: -0.3, y: -0.2 }, { x: 1.2, y: 1.5 }, { x: 0.5, y: 0.5 }]) {
      const crop = api.resizeCropCorner(initial, handle, point, composition);
      assert.ok(crop.width > 0 && crop.height > 0, "resize must never submit a zero-area crop");
      assert.ok(crop.x >= -1e-9 && crop.y >= -1e-9 && crop.x + crop.width <= 1 + 1e-9 && crop.y + crop.height <= 1 + 1e-9);
    }
  }
}

for (const rotation of [0, 90, 180, 270]) {
  for (const straighten of [-15, -5.4, 0, 0.1, 5.4, 15]) {
    const composition = { ...defaults, rotation, straighten, crop: { x: 0.13, y: 0.17, width: 0.71, height: 0.69 } };
    api.setComposition(composition);
    for (const point of [{ x: 0, y: 0 }, { x: 0.23, y: 0.67 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }]) {
      const output = api.sourcePointToOutput(point);
      pointNear(api.outputPointToSource(output), point, "mask source/output roundtrip");
      const matrix = api.sourceToOutputMatrix();
      pointNear({ x: matrix[0] * point.x + matrix[2] * point.y + matrix[4] / 1000, y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] / 1000 }, output, "SVG matrix");
      pointNear(api.screenPointToCrop(api.cropPointToScreen(point, composition), composition), point, "crop screen/source roundtrip");
    }
  }
}
api.setComposition({ ...defaults, straighten: 15 });
api.setFullCrop(4000, 3000);
// Reference: imaging._largest_inscribed_size(4000, 3000, 15) == (3045, 2284).
pointNear(api.sourcePointToOutput({ x: 0.75, y: 0.5 }), { x: 0.8172170201277729, y: 0.6133183209730826 }, "full-resolution straighten mapping");
console.log("Frontend composition geometry: all assertions passed.");
