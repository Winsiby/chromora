"use strict";

// Run with: node tests/test_composition_frontend.js
// Exercise the production geometry functions without initializing the DOM/workbench.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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
    centeredCropForAspect, resizeCropCorner, sourcePointToOutput,
    outputPointToSource, sourceToOutputMatrix, cropPointToScreen,
    screenPointToCrop, rotatedDimensions
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
