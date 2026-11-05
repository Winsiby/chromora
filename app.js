"use strict";

const byId = (id) => document.getElementById(id);
const selectAll = (selector) => [...document.querySelectorAll(selector)];
const svgIcon = (name) => '<svg aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const imageExtensions = /\.(jpeg|jpg|png|tif|tiff|3fr|arw|cr2|cr3|dng|erf|iiq|kdc|mef|mrw|nef|nrw|orf|pef|raf|raw|rw2|srw|x3f)$/i;
const tabs = {
  landscape: ["调色", "先调整原片，再应用风格，最后微调成片。"],
  portrait: ["人像调整", "把肤色与纹理调整限制在指定区域。"],
  masks: ["局部调整", "添加渐变或径向蒙版，只影响选定区域。"],
  composition: ["构图", "裁剪、旋转照片，并细调水平。"],
  styles: ["风格与配方", "选好风格后，可以继续微调成片。"],
  project: ["项目", "保存工作状态，或在 Patchy 中继续精修。"]
};
const hslBands = {
  red: ["红色", "#e06668"],
  orange: ["橙色", "#e39661"],
  yellow: ["黄色", "#d8bd65"],
  green: ["绿色", "#81ad77"],
  aqua: ["青色", "#63b7b5"],
  blue: ["蓝色", "#78a5e5"],
  purple: ["紫色", "#a68ad7"],
  magenta: ["洋红", "#d38dbb"]
};
const gradeBands = { shadow: ["阴影"], midtone: ["中间调"], highlight: ["高光"] };
const hslAdjustments = { Hue: "色相", Sat: "饱和度", Lum: "明亮度" };
const gradeAdjustments = { Hue: "色相", Sat: "饱和度" };
const bandKeys = (band, adjustments) => Object.keys(adjustments).map((adjustment) => band + adjustment);
const controls = {
  exposure: ["曝光", -3, 3, 0.05, 0],
  temperature: ["色温偏移", -100, 100, 1, 0],
  tint: ["色调", -100, 100, 1, 0],
  highlights: ["高光", -100, 100, 1, 0],
  shadows: ["阴影", -100, 100, 1, 0],
  whites: ["白色色阶", -100, 100, 1, 0],
  blacks: ["黑色色阶", -100, 100, 1, 0],
  clarity: ["清晰度", -100, 100, 1, 0],
  contrast: ["对比度", -100, 100, 1, 0],
  saturation: ["饱和度", -100, 100, 1, 0],
  vibrance: ["自然饱和度", -100, 100, 1, 0],
  dehaze: ["去雾", -100, 100, 1, 0],
  sharpening: ["锐化", 0, 100, 1, 0],
  denoise: ["降噪", 0, 100, 1, 0],
  colorBalance: ["平衡", -100, 100, 1, 0],
  blemishes: ["弱化瑕疵", 0, 100, 1, 0],
  smoothing: ["平滑皮肤", 0, 100, 1, 0],
  skinTone: ["均匀肤色", 0, 100, 1, 0],
  texture: ["皮肤纹理", 0, 100, 1, 0],
  lutStrength: ["滤镜强度", 0, 100, 1, 100],
  postExposure: ["曝光", -3, 3, 0.05, 0],
  postTemperature: ["色温偏移", -100, 100, 1, 0],
  postContrast: ["对比度", -100, 100, 1, 0]
};
for (const band of Object.keys(hslBands)) {
  for (const [adjustment, label] of Object.entries(hslAdjustments)) {
    controls[band + adjustment] = [label, -100, 100, 1, 0];
  }
}
for (const band of Object.keys(gradeBands)) {
  controls[band + "Hue"] = ["色相", 0, 360, 1, 0];
  controls[band + "Sat"] = ["饱和度", 0, 100, 1, 0];
}
const baseKeys = ["temperature", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "clarity", "vibrance", "saturation"];
const postKeys = ["postExposure", "postTemperature", "postContrast"];
const detailKeys = ["dehaze", "sharpening", "denoise"];
const colorKeys = [...baseKeys, ...postKeys, ...detailKeys, "colorBalance",
  ...Object.keys(hslBands).flatMap((band) => bandKeys(band, hslAdjustments)),
  ...Object.keys(gradeBands).flatMap((band) => bandKeys(band, gradeAdjustments))];
const curveColors = { rgb: "#e8c397", red: "#ee8a89", green: "#a0c692", blue: "#9abaf0" };
let curveChannel = "rgb";
let curvePoint = 0;
const defaults = Object.fromEntries(Object.entries(controls).map(([key, [, , , , value]]) => [key, value]));
defaults.masks = [];
const inputPairs = new Map();
const originals = new Map();
const preferences = { luts: [], favorites: [], presets: {} };
let pendingPreferences = Promise.resolve();
let photos = [];
let currentId = null;
let tab = "landscape";
let capability = null;
let dirty = false;
let savedProjectBaseline = null;
const photoHistory = typeof ChromoraHistory !== "undefined" ? new ChromoraHistory.PhotoHistory() : null;
const photoGestures = new Map();
let projectSaveInFlight = false;
let comparing = true;
let split = 50;
let zoom = 1;
let aspect = 1;
let peekingOriginal = false;
let actualZoom = false;
let fullOriginal;
let favoritesOnly = false;
let photoFlagFilter = "all";
let photoMinimumRating = 0;
let editingRegion = false;
let regionDraft = null;
let regionEditBefore = null;
let regionStartDraft = null;
let pointerStart = null;
let selectedMaskId = null;
let maskDrawType = null;
let maskGesture = null;
let photoSequence = 0;
let renderSequence = 0;
let renderTimer;
let fullRenderTimer;
let previewController;
let originalUrl;
let editedUrl;
let comparisonOriginalUrl;
let comparisonCompositionKey;
let sourceImageSize = { width: 0, height: 0 };
let compositionBaseUrl;
let compositionBaseImage;
let compositionBaseId;
let compositionController;
let compositionLoadSequence = 0;
let compositionGesture = null;
let loadingFiles = false;
let whiteBalanceActive = false;
let whiteBalanceBusy = false;
let whiteBalanceController;
let whiteBalanceSequence = 0;
// Viewing aids intentionally live outside photos/settings and project/export payloads.
let clippingEnabled = false;
let compositionPaintSequence = 0;
const clippingMasks = new WeakMap();

const compositionDefaults = { crop: null, aspect: "free", rotation: 0, straighten: 0 };

function loadPreferences(saved) {
  return {
    luts: Array.isArray(saved.luts) ? saved.luts.filter((lut) => lut && typeof lut.id === "string" && typeof lut.name === "string") : [],
    favorites: Array.isArray(saved.favorites) ? saved.favorites.filter((id) => typeof id === "string") : [],
    presets: Object.fromEntries(["landscape", "portrait"].map((group) => [group,
      Array.isArray(saved.presets?.[group]) ? saved.presets[group].filter((preset) => preset && typeof preset.name === "string" && preset.values) : []
    ]))
  };
}

function savePreferences() {
  const snapshot = JSON.parse(JSON.stringify(preferences));
  pendingPreferences = pendingPreferences.then(() => post("/api/preferences", snapshot)).catch((error) => {
    setStatus("无法保存本机偏好：" + error.message, "error");
  });
}

function currentPhoto() {
  return photos.find((photo) => photo.id === currentId);
}

function photoComposition(photo = currentPhoto()) {
  return { ...compositionDefaults, ...(photo?.settings?.composition || {}) };
}

function ensureComposition(photo = currentPhoto()) {
  if (!photo) return null;
  if (!photo.settings.composition) photo.settings.composition = { ...compositionDefaults };
  return photo.settings.composition;
}

function sourceDimensions() {
  return { ...sourceImageSize };
}

function rotatedDimensions(composition = photoComposition()) {
  const { width, height } = sourceDimensions();
  return composition.rotation % 180 === 90
    ? { width: height, height: width }
    : { width, height };
}

function namedAspectRatio(value, composition = photoComposition()) {
  if (value === "original") {
    const { width, height } = rotatedDimensions(composition);
    return width && height ? width / height : 1;
  }
  if (value === "free") return null;
  const [width, height] = String(value).split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function cropForAspectAtCenter(value, center, composition = photoComposition()) {
  const target = namedAspectRatio(value, composition);
  const dimensions = rotatedDimensions(composition);
  const imageAspect = dimensions.width && dimensions.height ? dimensions.width / dimensions.height : 1;
  if (!target) return null;
  const normalizedAspect = target / imageAspect;
  const width = Math.min(1, normalizedAspect);
  const height = width / normalizedAspect;
  const centerX = Math.max(width / 2, Math.min(1 - width / 2, center.x));
  const centerY = Math.max(height / 2, Math.min(1 - height / 2, center.y));
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

function centeredCropForAspect(value, composition = photoComposition()) {
  return cropForAspectAtCenter(value, { x: 0.5, y: 0.5 }, composition);
}

function rotateCropPoint(point, direction) {
  const turn = (direction % 360 + 360) % 360;
  if (turn === 90) return { x: 1 - point.y, y: point.x };
  if (turn === 180) return { x: 1 - point.x, y: 1 - point.y };
  if (turn === 270) return { x: point.y, y: 1 - point.x };
  return { ...point };
}

function rotateCropRectangle(crop, direction) {
  const turn = (direction % 360 + 360) % 360;
  if (turn === 90) return {
    x: 1 - crop.y - crop.height, y: crop.x,
    width: crop.height, height: crop.width
  };
  if (turn === 180) return {
    x: 1 - crop.x - crop.width, y: 1 - crop.y - crop.height,
    width: crop.width, height: crop.height
  };
  if (turn === 270) return {
    x: crop.y, y: 1 - crop.x - crop.width,
    width: crop.height, height: crop.width
  };
  return { ...crop };
}

function cropRect(composition = photoComposition()) {
  return composition.crop ? { ...composition.crop } : { x: 0, y: 0, width: 1, height: 1 };
}

function compositionHasEffect(composition) {
  const crop = composition?.crop;
  const cropped = crop && (crop.x > 1e-6 || crop.y > 1e-6 || crop.width < 1 - 1e-6 || crop.height < 1 - 1e-6);
  return Boolean(cropped || composition?.rotation || Math.abs(composition?.straighten || 0) > 1e-6);
}

function syncCompositionPanel() {
  const photo = currentPhoto();
  const composition = photoComposition(photo);
  for (const button of selectAll("[data-aspect]")) {
    button.setAttribute("aria-pressed", String(button.dataset.aspect === composition.aspect));
    button.disabled = !photo;
  }
  byId("clear-crop").disabled = !photo || !composition.crop;
  byId("rotate-left").disabled = !photo;
  byId("rotate-right").disabled = !photo;
  byId("rotation-value").textContent = composition.rotation + "°";
  byId("straighten-range").disabled = !photo;
  byId("straighten-range").value = composition.straighten;
  byId("straighten-value").textContent = (composition.straighten > 0 ? "+" : "") + composition.straighten.toFixed(1) + "°";
  updateCompositionOverlay();
}

function setStatus(message, tone = "") {
  byId("status").textContent = message;
  byId("status").title = message;
  byId("status-dot").className = "status-dot " + tone;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error || "本机服务返回 " + response.status);
  }
  return response;
}

async function post(url, data, signal) {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal
  });
}

function renderPayload(photo) {
  return { id: photo.id, name: photo.name, settings: photo.settings, lutId: photo.lutId };
}

function cloneData(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function photoSnapshot(photo) {
  return { settings: cloneData(photo.settings), lutId: photo.lutId ?? null };
}

function normalizePhotoCullingMetadata(photo) {
  if (!photo || typeof photo !== "object") return photo;
  photo.rating = Number.isInteger(photo.rating) && photo.rating >= 0 && photo.rating <= 5 ? photo.rating : 0;
  photo.flag = photo.flag === "pick" || photo.flag === "reject" ? photo.flag : null;
  return photo;
}

function photoMatchesFilter(photo, flagFilter = "all", minimumRating = 0) {
  if (!photo) return false;
  const validFilter = ["all", "pick", "reject", "unflagged"].includes(flagFilter) ? flagFilter : "all";
  const minRating = Number.isInteger(minimumRating) && minimumRating >= 0 && minimumRating <= 5 ? minimumRating : 0;
  const rating = Number.isInteger(photo.rating) && photo.rating >= 0 && photo.rating <= 5 ? photo.rating : 0;
  const flag = photo.flag === "pick" || photo.flag === "reject" ? photo.flag : null;
  if (rating < minRating) return false;
  if (validFilter === "pick" && flag !== "pick") return false;
  if (validFilter === "reject" && flag !== "reject") return false;
  if (validFilter === "unflagged" && flag !== null) return false;
  return true;
}

function filteredPhotos(list = photos, flagFilter = photoFlagFilter, minimumRating = photoMinimumRating) {
  return list.filter((photo) => photoMatchesFilter(photo, flagFilter, minimumRating));
}

function firstPhotoToSelectAfterFilter(currentPhotoId, matchingPhotos) {
  if (!matchingPhotos.length || matchingPhotos.some((photo) => photo.id === currentPhotoId)) return null;
  return matchingPhotos[0];
}

function setPhotoRating(photo, rating) {
  if (!photo || !Number.isInteger(rating) || rating < 0 || rating > 5 || (photo.rating ?? 0) === rating) return false;
  photo.rating = rating;
  return true;
}

function setPhotoFlag(photo, flag) {
  if (!photo || ![null, "pick", "reject"].includes(flag) || (photo.flag ?? null) === flag) return false;
  photo.flag = flag;
  return true;
}

function isPhotoCullingShortcutTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') || target?.isContentEditable);
}

function photoCullingShortcutAction(event, dialogOpen = false) {
  if (!event || event.defaultPrevented || event.isComposing || dialogOpen || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      isPhotoCullingShortcutTarget(event.target)) return null;
  const key = String(event.key || "").toLowerCase();
  if (/^[0-5]$/.test(key)) return { type: "rating", value: Number(key) };
  const flags = { p: "pick", x: "reject", u: null };
  return Object.prototype.hasOwnProperty.call(flags, key) ? { type: "flag", value: flags[key] } : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function dirtyProjectSnapshot(name = byId("project-name")?.value.trim() || "未命名项目", list = photos) {
  return JSON.stringify(stableValue({
    name,
    photos: list.map((photo) => ({
      id: photo.id,
      name: photo.name,
      settings: photo.settings,
      lutId: photo.lutId ?? null,
      rating: photo.rating ?? 0,
      flag: photo.flag ?? null
    }))
  }));
}

function updateDirtyState() {
  dirty = photos.length > 0 && (savedProjectBaseline === null ||
    dirtyProjectSnapshot() !== savedProjectBaseline);
  const photo = currentPhoto();
  const title = byId("workspace-title");
  const indicator = byId("project-dirty-indicator");
  if (indicator) indicator.hidden = !dirty;
  if (title) title.textContent = photo
    ? byId("project-name").value + (dirty ? " •" : "")
    : "未打开照片";
}

function syncHistoryButtons() {
  const photo = currentPhoto();
  const undo = byId("undo-edit");
  const redo = byId("redo-edit");
  if (undo) undo.disabled = !photo || !photoHistory?.canUndo(photo.id);
  if (redo) redo.disabled = !photo || !photoHistory?.canRedo(photo.id);
}

function findPhoto(photoId) {
  return photos.find((photo) => photo.id === photoId);
}

function applyPhotoSnapshot(photo, snapshot) {
  photo.settings = cloneData(snapshot.settings);
  photo.lutId = snapshot.lutId ?? null;
}

function recordPhotoEdit(photo, before) {
  if (!photo || !photoHistory) return false;
  const changed = photoHistory.record(photo.id, before, photoSnapshot(photo));
  updateDirtyState();
  syncHistoryButtons();
  return changed;
}

function runPhotoEdit(photo, mutate) {
  if (!photo) return false;
  const before = photoSnapshot(photo);
  mutate(photo);
  return recordPhotoEdit(photo, before);
}

function mutatePhoto(photo, mutate) {
  if (!photo) return false;
  const gesture = activeGestureFor(photo.id);
  const before = gesture?.before || photoSnapshot(photo);
  mutate(photo);
  return gesture ? false : recordPhotoEdit(photo, before);
}

function beginPhotoGesture(owner, photo = currentPhoto(), before = null) {
  if (!photo || photoGestures.has(owner)) return;
  photoGestures.set(owner, { photoId: photo.id, before: before || photoSnapshot(photo) });
}

function activeGestureFor(photoId) {
  for (const gesture of photoGestures.values()) {
    if (gesture.photoId === photoId) return gesture;
  }
  return null;
}

function finishPhotoGesture(owner, cancel = false) {
  const gesture = photoGestures.get(owner);
  if (!gesture) return;
  photoGestures.delete(owner);
  const photo = findPhoto(gesture.photoId);
  if (!photo) return;
  if (cancel) applyPhotoSnapshot(photo, gesture.before);
  else recordPhotoEdit(photo, gesture.before);
  if (cancel && photo.id === currentId) {
    selectedMaskId = currentMasks(photo).some((mask) => mask.id === selectedMaskId)
      ? selectedMaskId : (currentMasks(photo)[0]?.id || null);
    drawLuts();
    syncControls();
    schedulePreview();
  }
  updateDirtyState();
  syncHistoryButtons();
}

function finishPhotoGestures(cancel = false) {
  for (const owner of [...photoGestures.keys()]) finishPhotoGesture(owner, cancel);
}

function bindRangeGesture(input, onInput) {
  const keys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    beginPhotoGesture(input);
    try { input.setPointerCapture(event.pointerId); } catch {}
  });
  input.addEventListener("input", (event) => {
    if (!photoGestures.has(input)) beginPhotoGesture(input);
    onInput(event);
  });
  input.addEventListener("pointerup", () => finishPhotoGesture(input));
  input.addEventListener("pointercancel", () => finishPhotoGesture(input, true));
  input.addEventListener("lostpointercapture", () => finishPhotoGesture(input, true));
  input.addEventListener("keydown", (event) => {
    if (keys.has(event.key)) beginPhotoGesture(input);
  });
  input.addEventListener("keyup", (event) => {
    if (keys.has(event.key)) finishPhotoGesture(input);
  });
  input.addEventListener("change", () => finishPhotoGesture(input));
  input.addEventListener("blur", () => finishPhotoGesture(input));
}

function refreshAfterHistory(photo) {
  selectedMaskId = currentMasks(photo).some((mask) => mask.id === selectedMaskId)
    ? selectedMaskId : (currentMasks(photo)[0]?.id || null);
  maskDrawType = null;
  drawLuts();
  renderMaskList();
  syncControls();
  updateRegionOverlay();
  schedulePreview();
}

function undoCurrentPhoto() {
  const photo = currentPhoto();
  if (!photo || !photoHistory) return;
  const snapshot = photoHistory.undo(photo.id, photoSnapshot(photo));
  if (!snapshot) return;
  applyPhotoSnapshot(photo, snapshot);
  refreshAfterHistory(photo);
  syncHistoryButtons();
  setStatus("已撤销上一步");
}

function redoCurrentPhoto() {
  const photo = currentPhoto();
  if (!photo || !photoHistory) return;
  const snapshot = photoHistory.redo(photo.id, photoSnapshot(photo));
  if (!snapshot) return;
  applyPhotoSnapshot(photo, snapshot);
  refreshAfterHistory(photo);
  syncHistoryButtons();
  setStatus("已重做上一步");
}

function isEditableShortcutTarget(target) {
  return Boolean(target?.closest?.('input:not([type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]') || target?.isContentEditable);
}

function whiteBalancePreviewPending() {
  const chip = byId("render-chip");
  return !chip.hidden && chip.textContent.startsWith("正在");
}

function syncWhiteBalanceTool() {
  const button = byId("white-balance-sample");
  if (!button) return;
  const pending = whiteBalancePreviewPending();
  button.disabled = !currentPhoto() || !originalUrl || byId("view").hidden;
  // Keep focus on the tool after a successful sample while the new preview renders.
  button.setAttribute("aria-disabled", String(pending && !whiteBalanceActive));
  button.setAttribute("aria-pressed", String(whiteBalanceActive));
  button.setAttribute("aria-busy", String(whiteBalanceBusy));
  button.title = whiteBalanceActive ? "取消白平衡取样（Esc）"
    : pending ? "正在更新预览，请稍候" : "从中性灰或白色区域取样";
  const instruction = byId("white-balance-instruction");
  instruction.hidden = !whiteBalanceActive;
  instruction.textContent = whiteBalanceBusy ? "正在取样，Esc 取消。"
    : pending ? "正在更新预览，Esc 取消。" : "点击中性灰或白色区域，Esc 取消。";
  byId("photo-stack").classList.toggle("sampling-white-balance", whiteBalanceActive);
  byId("view").setAttribute("aria-label", whiteBalanceActive
    ? "照片画布，点击中性灰或白色区域取样白平衡，Escape 取消"
    : "照片画布，按住空格暂看原图");
  if (whiteBalanceActive) byId("view").setAttribute("aria-describedby", instruction.id);
  else byId("view").removeAttribute("aria-describedby");
}

function setWhiteBalanceMode(active, restoreFocus = false) {
  whiteBalanceSequence++;
  whiteBalanceController?.abort();
  whiteBalanceController = undefined;
  whiteBalanceBusy = false;
  whiteBalanceActive = Boolean(active && currentPhoto() && originalUrl && !byId("view").hidden && tab === "landscape" && !whiteBalancePreviewPending());
  if (whiteBalanceActive) peekingOriginal = false;
  syncWhiteBalanceTool();
  updateViewControls();
  if (whiteBalanceActive) byId("view").focus({ preventScroll: true });
  else if (restoreFocus) byId("white-balance-sample").focus({ preventScroll: true });
}

async function sampleWhiteBalance(event) {
  if (!whiteBalanceActive || event.button !== 0 || event.isPrimary === false) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (whiteBalanceBusy) return;
  if (whiteBalancePreviewPending()) {
    setStatus("预览正在更新，完成后再点击照片取样。");
    return;
  }
  const photo = currentPhoto();
  const rect = byId("image-edited").getBoundingClientRect();
  if (!photo || !rect.width || !rect.height) return;
  const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
  const source = outputPointToSource(point, photo);
  if (source.x < -1e-6 || source.x > 1 + 1e-6 || source.y < -1e-6 || source.y > 1 + 1e-6) return;
  const sequence = ++whiteBalanceSequence;
  const sourceSequence = photoSequence;
  const controller = new AbortController();
  whiteBalanceController = controller;
  whiteBalanceBusy = true;
  syncWhiteBalanceTool();
  setStatus("正在取样白平衡…", "busy");
  try {
    const response = await post("/api/white-balance", {
      id: photo.id, x: Math.max(0, Math.min(1, source.x)), y: Math.max(0, Math.min(1, source.y))
    }, controller.signal);
    const result = await response.json();
    if (sequence !== whiteBalanceSequence || sourceSequence !== photoSequence || currentId !== photo.id) return;
    if (![result.temperature, result.tint].every((value) => Number.isInteger(value) && value >= -100 && value <= 100)) {
      throw new Error("取样返回的白平衡数值无效，请重试。");
    }
    // The endpoint returns absolute slider values, never deltas.
    const before = photoSnapshot(photo);
    photo.settings.temperature = result.temperature;
    photo.settings.tint = result.tint;
    recordPhotoEdit(photo, before);
    setWhiteBalanceMode(false, true);
    syncControls();
    schedulePreview();
    setStatus("已取样白平衡，可继续用色温和色调滑杆微调。");
  } catch (error) {
    if (error.name !== "AbortError" && sequence === whiteBalanceSequence && sourceSequence === photoSequence) {
      setStatus("白平衡取样失败：" + error.message, "error");
    }
  } finally {
    if (sequence === whiteBalanceSequence) {
      whiteBalanceBusy = false;
      whiteBalanceController = undefined;
      syncWhiteBalanceTool();
    }
  }
}

function controlGroup(container, title, keys, suffix) {
  const group = document.createElement("div");
  group.className = "control-group";
  if (title) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    group.append(heading);
  }

  for (const key of keys) {
    const [label, min, max, step, initial] = controls[key];
    const row = document.createElement("div");
    row.className = "control-row";
    row.dataset.control = key;
    const titleLabel = document.createElement("label");
    titleLabel.textContent = label;
    titleLabel.htmlFor = "slider-" + key + (suffix || "");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = titleLabel.htmlFor;
    const number = document.createElement("input");
    number.type = "number";
    number.setAttribute("aria-label", (title ? title + " " : "") + label + "数值");
    for (const input of [slider, number]) {
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = initial;
      input.disabled = true;
    }
    bindRangeGesture(slider, () => setControl(key, slider.valueAsNumber));
    number.addEventListener("change", () => {
      if (!Number.isFinite(number.valueAsNumber)) {
        syncControls();
        return;
      }
      setControl(key, number.valueAsNumber);
    });
    row.append(titleLabel, slider, number);
    group.append(row);
    if (!inputPairs.has(key)) inputPairs.set(key, []);
    inputPairs.get(key).push([slider, number]);
  }
  container.append(group);
}

function normalizedGradeHue(hue) {
  const numeric = Number.isFinite(hue) ? hue : 0;
  return ((numeric % 360) + 360) % 360;
}

const GRADE_WHEEL_MARKER_RADIUS = 0.425;
const GRADE_WHEEL_MARKER_HIT_RADIUS_PX = 6;

function gradeWheelMarkerPosition(hue, saturation) {
  const angle = normalizedGradeHue(hue) * Math.PI / 180;
  const radius = GRADE_WHEEL_MARKER_RADIUS * Math.max(0, Math.min(100, Number(saturation) || 0)) / 100;
  return { x: 0.5 + Math.sin(angle) * radius, y: 0.5 - Math.cos(angle) * radius };
}

function gradeWheelPointFromClient(clientX, clientY, rect, metrics) {
  const size = Math.min(metrics.width, metrics.height);
  if (!size) return { x: 0.5, y: 0.5 };
  const left = rect.left + metrics.borderLeft + (metrics.width - size) / 2;
  const top = rect.top + metrics.borderTop + (metrics.height - size) / 2;
  return { x: (clientX - left) / size, y: (clientY - top) / size };
}

function gradeWheelPointerHitsMarker(point, hue, saturation, size) {
  const marker = gradeWheelMarkerPosition(hue, saturation);
  return Math.hypot((point.x - marker.x) * size, (point.y - marker.y) * size) <= GRADE_WHEEL_MARKER_HIT_RADIUS_PX;
}

function gradeWheelValuesAtPoint(x, y, previousHue = 0) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const distance = Math.min(0.5, Math.hypot(dx, dy));
  const hue = distance < 0.005
    ? normalizedGradeHue(previousHue)
    : Math.round(normalizedGradeHue(Math.atan2(dx, -dy) * 180 / Math.PI)) % 360;
  return { hue, saturation: Math.max(0, Math.min(100, Math.round(distance / GRADE_WHEEL_MARKER_RADIUS * 100))) };
}

function gradeNumberField(band, key, label, unit) {
  const [, min, max, step, initial] = controls[key];
  const field = document.createElement("div");
  field.className = "grade-number-field";
  const title = document.createElement("label");
  title.htmlFor = "grade-number-" + key;
  title.textContent = label;
  const wrap = document.createElement("div");
  wrap.className = "grade-number-wrap";
  const input = document.createElement("input");
  input.type = "number";
  input.id = title.htmlFor;
  input.className = "grade-number-input";
  input.setAttribute("aria-label", gradeBands[band][0] + label + (unit === "°" ? "（度）" : "（百分比）"));
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = initial;
  input.disabled = true;
  input.addEventListener("change", () => {
    if (!Number.isFinite(input.valueAsNumber)) {
      syncControls();
      return;
    }
    setControl(key, input.valueAsNumber);
  });
  const suffix = document.createElement("span");
  suffix.setAttribute("aria-hidden", "true");
  suffix.textContent = unit;
  wrap.append(input, suffix);
  field.append(title, wrap);
  if (!inputPairs.has(key)) inputPairs.set(key, []);
  inputPairs.get(key).push([input]);
  return field;
}

function syncGradeWheels() {
  const photo = currentPhoto();
  for (const wheel of selectAll("[data-grade-wheel]")) {
    const band = wheel.dataset.gradeWheel;
    const hue = photo?.settings[band + "Hue"] ?? defaults[band + "Hue"];
    const saturation = photo?.settings[band + "Sat"] ?? defaults[band + "Sat"];
    const marker = gradeWheelMarkerPosition(hue, saturation);
    wheel.style.setProperty("--marker-x", (marker.x * 100) + "%");
    wheel.style.setProperty("--marker-y", (marker.y * 100) + "%");
    wheel.setAttribute("aria-label", gradeBands[band][0] + "色轮，色相 " + hue + " 度，饱和度 " + saturation + "%");
    wheel.setAttribute("aria-disabled", String(!photo));
    wheel.tabIndex = photo ? 0 : -1;
  }
}

function gradeWheelControls(parent) {
  const stack = document.createElement("div");
  stack.className = "grade-wheel-stack";
  const help = document.createElement("p");
  help.id = "grade-wheel-help";
  help.className = "grade-wheel-help";
  help.textContent = "拖动或点选色轮；←/→ 调色相，↑/↓ 调饱和度。按住 Shift 加大步进，Home/End 调至 0/100%。";
  stack.append(help);

  for (const [band, [label]] of Object.entries(gradeBands)) {
    const section = document.createElement("section");
    section.className = "grade-band";
    const heading = document.createElement("h3");
    heading.textContent = label;
    const row = document.createElement("div");
    row.className = "grade-wheel-row";
    const wheel = document.createElement("div");
    wheel.className = "grade-wheel";
    wheel.dataset.gradeWheel = band;
    wheel.tabIndex = -1;
    wheel.setAttribute("role", "group");
    wheel.setAttribute("aria-describedby", help.id);
    const marker = document.createElement("span");
    marker.className = "grade-wheel-marker";
    marker.setAttribute("aria-hidden", "true");
    wheel.append(marker);
    const fields = document.createElement("div");
    fields.className = "grade-field-grid";
    fields.setAttribute("role", "group");
    fields.setAttribute("aria-label", label + "色轮数值");
    fields.append(
      gradeNumberField(band, band + "Hue", "色相", "°"),
      gradeNumberField(band, band + "Sat", "饱和度", "%")
    );
    row.append(wheel, fields);
    section.append(heading, row);
    stack.append(section);

    let pointerId = null;
    const updateFromPointer = (event) => {
      const rect = wheel.getBoundingClientRect();
      const point = gradeWheelPointFromClient(event.clientX, event.clientY, rect, {
        borderLeft: wheel.clientLeft,
        borderTop: wheel.clientTop,
        width: wheel.clientWidth,
        height: wheel.clientHeight
      });
      const photo = currentPhoto();
      if (!photo) return;
      const currentHue = photo.settings[band + "Hue"] ?? defaults[band + "Hue"];
      const currentSaturation = photo.settings[band + "Sat"] ?? defaults[band + "Sat"];
      if (event.type === "pointerdown" && gradeWheelPointerHitsMarker(point, currentHue, currentSaturation, Math.min(wheel.clientWidth, wheel.clientHeight))) return;
      const values = gradeWheelValuesAtPoint(
        point.x,
        point.y,
        currentHue
      );
      if (photo.settings[band + "Hue"] !== values.hue) setControl(band + "Hue", values.hue);
      if (photo.settings[band + "Sat"] !== values.saturation) setControl(band + "Sat", values.saturation);
    };
    wheel.addEventListener("pointerdown", (event) => {
      if (!currentPhoto() || event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      pointerId = event.pointerId;
      beginPhotoGesture(wheel);
      wheel.setPointerCapture(pointerId);
      updateFromPointer(event);
    });
    wheel.addEventListener("pointermove", (event) => {
      if (event.pointerId === pointerId) updateFromPointer(event);
    });
    wheel.addEventListener("pointerup", (event) => {
      if (event.pointerId !== pointerId) return;
      updateFromPointer(event);
      pointerId = null;
      finishPhotoGesture(wheel);
    });
    wheel.addEventListener("pointercancel", () => { pointerId = null; finishPhotoGesture(wheel, true); });
    wheel.addEventListener("lostpointercapture", () => { pointerId = null; finishPhotoGesture(wheel, true); });
    wheel.addEventListener("keydown", (event) => {
      const photo = currentPhoto();
      if (!photo) return;
      const step = event.shiftKey ? 10 : 1;
      const hueKey = band + "Hue";
      const saturationKey = band + "Sat";
      const hue = photo.settings[hueKey] ?? defaults[hueKey];
      const saturation = photo.settings[saturationKey] ?? defaults[saturationKey];
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setControl(hueKey, normalizedGradeHue(hue + (event.key === "ArrowRight" ? step : -step)));
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setControl(saturationKey, saturation + (event.key === "ArrowUp" ? step : -step));
      } else if (event.key === "PageUp" || event.key === "PageDown") {
        event.preventDefault();
        setControl(saturationKey, saturation + (event.key === "PageUp" ? 10 : -10));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setControl(saturationKey, event.key === "End" ? 100 : 0);
      }
    });
  }
  parent.append(stack);
}

function setControl(key, value) {
  const photo = currentPhoto();
  if (!photo) return;
  if (whiteBalanceBusy && (key === "temperature" || key === "tint")) setWhiteBalanceMode(false);
  const [, min, max, step] = controls[key];
  const rounded = Number((Math.round(value / step) * step).toFixed(2));
  const next = Math.max(min, Math.min(max, rounded));
  const before = photoSnapshot(photo);
  if (photo.settings[key] === next) return;
  photo.settings[key] = next;
  if (!activeGestureFor(photo.id)) recordPhotoEdit(photo, before);
  syncControls();
  schedulePreview();
}

function syncWorkspaceTitle() {
  updateDirtyState();
}

function syncControls() {
  const photo = currentPhoto();
  syncPhotoCullingControls();
  const requiresRegion = capability?.portrait !== "rapidretouch";
  for (const [key, pairs] of inputPairs) {
    const isPortrait = ["blemishes", "smoothing", "skinTone", "texture"].includes(key);
    const disabled = !photo || (isPortrait && requiresRegion && !photo.settings.skinRegion) || (key === "lutStrength" && !photo.lutId);
    for (const pair of pairs) {
      for (const input of pair) {
        input.value = photo?.settings[key] ?? defaults[key];
        input.disabled = disabled;
      }
    }
  }
  syncGradeWheels();

  byId("reset-photo").disabled = !photo;
  byId("project-save").disabled = !photo || projectSaveInFlight;
  byId("patchy-open").disabled = !photo || !capability?.patchy;
  byId("choose-region").disabled = !photo;
  byId("clear-region").disabled = !photo?.settings.skinRegion;
  byId("region-caption").textContent = capability?.portrait === "rapidretouch"
    ? "可使用外部人像引擎。也可手动框选指定区域。"
    : "先框选皮肤区域，再调整下方滑杆。建议避开眼睛、嘴唇和头发。";
  syncWorkspaceTitle();
  byId("landscape-lut-name").textContent = preferences.luts.find((lut) => lut.id === photo?.lutId)?.name || "未应用滤镜";
  byId("export-open").disabled = !photo;
  if (byId("curve-section").open) drawCurve();
  syncMaskPanel();
  syncCompositionPanel();
  syncWhiteBalanceTool();
  updateViewControls();
  syncHistoryButtons();
}

function editorSection(parent, id, title, open = false) {
  const section = document.createElement("details");
  section.className = "editor-section";
  section.id = id;
  section.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const body = document.createElement("div");
  body.className = "editor-section-body";
  section.append(summary, body);
  parent.append(section);
  return body;
}

function bandControls(parent, type, bands, adjustments) {
  const buttons = document.createElement("div");
  buttons.className = "band-buttons " + (type === "hsl" ? "swatches" : "tonal-bands");
  buttons.setAttribute("role", "group");
  buttons.setAttribute("aria-label", type === "hsl" ? "颜色通道" : "明暗区域");
  const selection = document.createElement("p");
  selection.className = "band-selection";
  parent.append(buttons, selection);
  const groups = new Map();
  for (const [band, [label, color]] of Object.entries(bands)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset[type + "Band"] = band;
    button.setAttribute("aria-label", label);
    button.title = label;
    if (color) button.style.setProperty("--swatch", color);
    else button.textContent = label;
    buttons.append(button);

    const panel = document.createElement("div");
    panel.className = "band-panel";
    parent.append(panel);
    controlGroup(panel, "", bandKeys(band, adjustments));
    groups.set(band, { button, panel, label });
    button.addEventListener("click", () => select(band));
  }

  function select(band) {
    selection.textContent = groups.get(band).label;
    for (const [key, { button, panel }] of groups) {
      button.setAttribute("aria-pressed", String(key === band));
      panel.hidden = key !== band;
    }
  }

  select(groups.keys().next().value);
}

function readCurve() {
  const points = currentPhoto()?.settings.curves?.[curveChannel];
  return Array.isArray(points) && points.length >= 2 && points.length <= 12 &&
    points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
    ? points : [[0, 0], [1, 1]];
}

function drawCurve() {
  const photo = currentPhoto();
  const points = readCurve();
  curvePoint = Math.min(curvePoint, points.length - 1);
  const graph = byId("curve-graph");
  graph.style.setProperty("--curve-color", curveColors[curveChannel]);
  byId("curve-line").setAttribute("d", points.map(([x, y], index) => (
    (index ? "L" : "M") + (10 + x * 200) + "," + (210 - y * 200)
  )).join(" "));
  byId("curve-handles").replaceChildren(...points.map(([x, y], index) => {
    const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    point.setAttribute("cx", 10 + x * 200);
    point.setAttribute("cy", 210 - y * 200);
    point.setAttribute("r", index === curvePoint ? 5.5 : 4.25);
    point.classList.toggle("selected", index === curvePoint);
    point.dataset.curveIndex = index;
    return point;
  }));
  const pointPicker = byId("curve-point");
  if (pointPicker.options.length !== points.length) {
    pointPicker.replaceChildren(...points.map((_, index) => new Option(
      index === 0 ? "黑端" : index === points.length - 1 ? "白端" : "点 " + index,
      String(index)
    )));
  }
  pointPicker.value = String(curvePoint);
  byId("curve-x").value = Math.round(points[curvePoint][0] * 100);
  byId("curve-y").value = Math.round(points[curvePoint][1] * 100);
  const inner = curvePoint > 0 && curvePoint < points.length - 1;
  byId("curve-channel").disabled = !photo;
  pointPicker.disabled = !photo;
  byId("curve-x").disabled = !photo || !inner;
  byId("curve-y").disabled = !photo;
  byId("curve-remove").disabled = !photo || !inner;
  byId("curve-add").disabled = !photo || points.length >= 12;
  byId("curve-reset").disabled = !photo?.settings.curves?.[curveChannel];
}

function saveCurve(points) {
  const photo = currentPhoto();
  if (!photo) return;
  const before = photoSnapshot(photo);
  const curves = { ...photo.settings.curves };
  if (points) curves[curveChannel] = points;
  else delete curves[curveChannel];
  if (Object.keys(curves).length) photo.settings.curves = curves;
  else delete photo.settings.curves;
  if (!activeGestureFor(photo.id)) recordPhotoEdit(photo, before);
  syncControls();
  schedulePreview();
}

function moveCurvePoint(x, y) {
  const points = readCurve().map((point) => [...point]);
  const inner = curvePoint > 0 && curvePoint < points.length - 1;
  if (inner) {
    const lower = points[curvePoint - 1][0] + 0.01;
    const upper = points[curvePoint + 1][0] - 0.01;
    if (upper >= lower - 1e-8) points[curvePoint][0] = Math.round(100 * Math.min(upper, Math.max(lower, x))) / 100;
  }
  points[curvePoint][1] = Math.round(100 * Math.min(1, Math.max(0, y))) / 100;
  saveCurve(points);
}

function addCurvePoint(x, y) {
  const points = readCurve().map((point) => [...point]);
  if (points.length >= 12) return false;
  const next = points.findIndex(([pointX]) => pointX > x);
  if (next < 1 || x - points[next - 1][0] < 0.0099 || points[next][0] - x < 0.0099) return false;
  points.splice(next, 0, [x, y]);
  curvePoint = next;
  saveCurve(points);
  return true;
}

function prepareCurve(parent) {
  parent.innerHTML = `
    <label class="field curve-channel">曲线通道
      <select id="curve-channel"><option value="rgb">复合 RGB</option><option value="red">红色</option><option value="green">绿色</option><option value="blue">蓝色</option></select>
    </label>
    <svg id="curve-graph" viewBox="0 0 220 220" role="img" aria-label="曲线图。点击添加控制点，拖动控制点。也可使用下方数值输入。">
      <path class="curve-grid" d="M10 10H210V210H10ZM60 10V210M110 10V210M160 10V210M10 60H210M10 110H210M10 160H210"/>
      <path class="curve-reference" d="M10 210L210 10"/>
      <path id="curve-line"/>
      <g id="curve-handles"></g>
    </svg>
    <div class="curve-fields">
      <label class="field">控制点<select id="curve-point"></select></label>
      <label class="field">输入 %<input type="number" id="curve-x" min="0" max="100" step="1" inputmode="numeric"></label>
      <label class="field">输出 %<input type="number" id="curve-y" min="0" max="100" step="1" inputmode="numeric"></label>
    </div>
    <div class="curve-actions">
      <button type="button" class="button small outline" id="curve-add">添加点</button>
      <button type="button" class="button small outline" id="curve-remove">删除点</button>
      <button type="button" class="button small quiet" id="curve-reset">重置通道</button>
    </div>`;
  const graph = byId("curve-graph");
  let pointer = null;
  function coordinate(event) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(graph.getScreenCTM().inverse());
    const round = (value) => Math.min(1, Math.max(0, Math.round(value) / 100));
    return [round((point.x - 10) / 2), round((210 - point.y) / 2)];
  }
  graph.addEventListener("pointerdown", (event) => {
    const photo = currentPhoto();
    if (!photo || event.button !== 0 || event.isPrimary === false) return;
    const before = photoSnapshot(photo);
    beginPhotoGesture(graph, photo, before);
    const handle = event.target.dataset.curveIndex;
    if (handle !== undefined) {
      curvePoint = Number(handle);
      drawCurve();
    } else if (!addCurvePoint(...coordinate(event))) {
      finishPhotoGesture(graph, true);
      return;
    }
    event.preventDefault();
    pointer = event.pointerId;
    graph.setPointerCapture(pointer);
  });
  graph.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointer && currentPhoto()) moveCurvePoint(...coordinate(event));
  });
  graph.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointer) return;
    moveCurvePoint(...coordinate(event));
    pointer = null;
    finishPhotoGesture(graph);
  });
  graph.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    finishPhotoGesture(graph, true);
  });
  graph.addEventListener("lostpointercapture", () => {
    if (pointer === null) return;
    pointer = null;
    finishPhotoGesture(graph, true);
  });
  byId("curve-section").addEventListener("toggle", () => {
    if (byId("curve-section").open) drawCurve();
  });
  byId("curve-channel").addEventListener("change", (event) => {
    curveChannel = event.target.value;
    curvePoint = 0;
    drawCurve();
  });
  byId("curve-point").addEventListener("change", (event) => {
    curvePoint = Number(event.target.value);
    drawCurve();
  });
  for (const id of ["curve-x", "curve-y"]) {
    byId(id).addEventListener("change", () => {
      const x = byId("curve-x").valueAsNumber / 100;
      const y = byId("curve-y").valueAsNumber / 100;
      if (Number.isFinite(x) && Number.isFinite(y)) moveCurvePoint(x, y);
      else drawCurve();
    });
  }
  byId("curve-add").addEventListener("click", () => {
    const points = readCurve();
    let gap = 0;
    for (let index = 1; index < points.length - 1; index++) {
      if (points[index + 1][0] - points[index][0] > points[gap + 1][0] - points[gap][0]) gap = index;
    }
    const [left, right] = [points[gap], points[gap + 1]];
    addCurvePoint(Math.round(50 * (left[0] + right[0])) / 100, Math.round(50 * (left[1] + right[1])) / 100);
  });
  byId("curve-remove").addEventListener("click", () => {
    const points = readCurve().map((point) => [...point]);
    points.splice(curvePoint, 1);
    curvePoint -= 1;
    saveCurve(points);
  });
  byId("curve-reset").addEventListener("click", () => { curvePoint = 0; saveCurve(null); });
  drawCurve();
}

function currentMasks(photo = currentPhoto()) {
  if (!photo) return [];
  if (!Array.isArray(photo.settings.masks)) photo.settings.masks = [];
  return photo.settings.masks;
}

function selectedMask() {
  return currentMasks().find((mask) => mask.id === selectedMaskId) || null;
}

function createMask(type) {
  const masks = currentMasks();
  const number = masks.filter((mask) => mask.type === type).length + 1;
  const id = crypto.randomUUID ? crypto.randomUUID() : "mask-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  return {
    id,
    name: (type === "linear" ? "线性渐变 " : "径向蒙版 ") + number,
    type,
    enabled: true,
    geometry: type === "linear"
      ? { start: { x: 0.5, y: 0.12 }, end: { x: 0.5, y: 0.88 } }
      : { center: { x: 0.5, y: 0.5 }, radius: { x: 0.24, y: 0.24 } },
    feather: 0.35,
    invert: false,
    adjustments: { exposure: 0, highlights: 0, shadows: 0, temperature: 0, saturation: 0 }
  };
}

function renderMaskList() {
  const list = byId("mask-list");
  if (!list) return;
  const photo = currentPhoto();
  const masks = currentMasks(photo);
  if (selectedMaskId && !masks.some((mask) => mask.id === selectedMaskId)) selectedMaskId = masks[0]?.id || null;
  list.replaceChildren(...masks.map((mask) => {
    const row = document.createElement("div");
    row.className = "mask-row";
    row.classList.toggle("is-selected", mask.id === selectedMaskId);
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "mask-select";
    choose.setAttribute("aria-pressed", String(mask.id === selectedMaskId));
    choose.title = "编辑 " + mask.name;
    const name = document.createElement("span");
    name.className = "mask-row-name";
    name.textContent = mask.name;
    const kind = document.createElement("span");
    kind.className = "mask-row-type";
    kind.textContent = mask.type === "linear" ? "线性" : "径向";
    choose.append(name, kind);
    choose.addEventListener("click", () => {
      selectedMaskId = mask.id;
      renderMaskList();
      syncMaskPanel();
      updateMaskOverlay();
    });

    const enabled = document.createElement("button");
    enabled.type = "button";
    enabled.className = "mask-enable";
    enabled.setAttribute("aria-pressed", String(mask.enabled));
    enabled.setAttribute("aria-label", (mask.enabled ? "停用 " : "启用 ") + mask.name);
    enabled.title = mask.enabled ? "停用蒙版" : "启用蒙版";
    enabled.textContent = mask.enabled ? "开" : "关";
    enabled.addEventListener("click", () => {
      mutatePhoto(photo, () => { mask.enabled = !mask.enabled; });
      syncWorkspaceTitle();
      renderMaskList();
      syncMaskPanel();
      updateMaskOverlay();
      schedulePreview();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mask-delete icon-button";
    remove.setAttribute("aria-label", "删除 " + mask.name);
    remove.title = "删除蒙版";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const index = masks.findIndex((entry) => entry.id === mask.id);
      mutatePhoto(photo, () => { if (index >= 0) masks.splice(index, 1); });
      if (selectedMaskId === mask.id) selectedMaskId = masks[Math.min(index, masks.length - 1)]?.id || null;
      syncWorkspaceTitle();
      renderMaskList();
      syncMaskPanel();
      updateMaskOverlay();
      schedulePreview();
      setStatus("已删除蒙版");
    });
    row.append(choose, enabled, remove);
    return row;
  }));
  byId("mask-count").textContent = masks.length + " 个";
  byId("mask-empty").hidden = masks.length > 0;
}

function syncMaskPanel() {
  const photo = currentPhoto();
  const mask = selectedMask();
  byId("mask-add-linear").disabled = !photo;
  byId("mask-add-radial").disabled = !photo;
  byId("mask-empty").hidden = !photo || currentMasks(photo).length > 0;
  byId("mask-no-photo").hidden = Boolean(photo);
  byId("mask-editor").hidden = !mask;
  if (mask) {
    byId("mask-name").value = mask.name;
    byId("mask-type-note").textContent = mask.type === "linear"
      ? "起点为完整效果，终点为零效果；两点距离决定过渡宽度。"
      : "拖动中心和边缘控制点调整椭圆；羽化只作用于径向边缘。";
    byId("mask-feather-group").hidden = mask.type !== "radial";
    byId("mask-feather").value = mask.feather;
    byId("mask-feather-value").textContent = Math.round(mask.feather * 100) + "%";
    byId("mask-invert").setAttribute("aria-pressed", String(mask.invert));
    byId("mask-invert").textContent = mask.invert ? "已反选" : "反选蒙版";
    for (const input of selectAll("[data-mask-control]")) {
      const key = input.dataset.maskControl;
      input.value = mask.adjustments[key] ?? 0;
    }
  }
  byId("mask-instruction").textContent = maskDrawType
    ? (maskDrawType === "linear" ? "在画布上拖动，设置渐变方向和过渡宽度。" : "在画布上从中心向外拖动，设置椭圆位置和大小。")
    : "选择蒙版后可拖动画布控制点；添加蒙版后也可直接在画布上绘制。";
  updateMaskOverlay();
}

function prepareMaskPanel() {
  const panel = byId("panel-masks");
  panel.innerHTML = `
    <div class="mask-create-actions">
      <button type="button" class="button outline" id="mask-add-linear">线性渐变</button>
      <button type="button" class="button outline" id="mask-add-radial">径向蒙版</button>
    </div>
    <p class="section-note mask-instruction" id="mask-instruction"></p>
    <div class="mask-list-heading"><h3>蒙版</h3><span id="mask-count">0 个</span></div>
    <div class="mask-list" id="mask-list" aria-label="蒙版列表"></div>
    <p class="section-note mask-empty" id="mask-empty">还没有蒙版。添加渐变压暗天空，或用径向蒙版局部提亮。</p>
    <p class="section-note mask-empty" id="mask-no-photo" hidden>打开照片后即可添加局部蒙版。</p>
    <section class="mask-editor" id="mask-editor" hidden aria-label="蒙版设置">
      <label class="field">名称<input id="mask-name" maxlength="60" autocomplete="off"></label>
      <p class="section-note" id="mask-type-note"></p>
      <div class="mask-option-row">
        <button type="button" class="button small outline" id="mask-invert" aria-pressed="false">反选蒙版</button>
      </div>
      <div class="control-group mask-feather-group" id="mask-feather-group">
        <div class="mask-feather-heading"><label for="mask-feather">羽化</label><output id="mask-feather-value">35%</output></div>
        <input id="mask-feather" type="range" min="0" max="1" step="0.01" value="0.35">
      </div>
      <div class="control-group mask-adjustments">
        <h3>局部调整</h3>
        <div id="mask-adjustments"></div>
      </div>
    </section>`;

  for (const [id, type] of [["mask-add-linear", "linear"], ["mask-add-radial", "radial"]]) {
    byId(id).addEventListener("click", () => {
      const mask = createMask(type);
      runPhotoEdit(currentPhoto(), (photo) => currentMasks(photo).push(mask));
      selectedMaskId = mask.id;
      maskDrawType = type;
      syncWorkspaceTitle();
      renderMaskList();
      syncMaskPanel();
      setStatus(type === "linear" ? "已添加线性渐变；在画布上拖动以设置方向和宽度。" : "已添加径向蒙版；在画布上拖动以设置位置和大小。");
    });
  }

  const specs = [
    ["exposure", "曝光", -3, 3, 0.05],
    ["highlights", "高光", -100, 100, 1],
    ["shadows", "阴影", -100, 100, 1],
    ["temperature", "色温偏移", -100, 100, 1],
    ["saturation", "饱和度", -100, 100, 1]
  ];
  const container = byId("mask-adjustments");
  for (const [key, label, min, max, step] of specs) {
    const row = document.createElement("div");
    row.className = "control-row mask-adjustment-row";
    const title = document.createElement("label");
    title.htmlFor = "mask-control-" + key;
    title.textContent = label;
    const range = document.createElement("input");
    range.type = "range";
    range.id = title.htmlFor;
    range.min = min;
    range.max = max;
    range.step = step;
    range.dataset.maskControl = key;
    range.setAttribute("aria-label", label);
    const number = document.createElement("input");
    number.type = "number";
    number.min = min;
    number.max = max;
    number.step = step;
    number.dataset.maskControl = key;
    number.setAttribute("aria-label", label + "数值");
    const change = (event) => {
      const mask = selectedMask();
      if (!mask) return;
      const raw = Number(event.currentTarget.value);
      if (!Number.isFinite(raw)) return;
      const value = Math.max(min, Math.min(max, Number((Math.round(raw / step) * step).toFixed(2))));
      mutatePhoto(currentPhoto(), () => { mask.adjustments[key] = value; });
      for (const input of selectAll('[data-mask-control="' + key + '"]')) input.value = value;
      syncWorkspaceTitle();
      schedulePreview();
    };
    bindRangeGesture(range, change);
    number.addEventListener("change", change);
    row.append(title, range, number);
    container.append(row);
  }
  byId("mask-name").addEventListener("change", (event) => {
    const mask = selectedMask();
    if (!mask) return;
    const name = event.currentTarget.value.trim();
    if (!name) {
      event.currentTarget.value = mask.name;
      return;
    }
    mutatePhoto(currentPhoto(), () => { mask.name = name.slice(0, 60); });
    syncWorkspaceTitle();
    renderMaskList();
  });
  bindRangeGesture(byId("mask-feather"), (event) => {
    const mask = selectedMask();
    if (!mask || mask.type !== "radial") return;
    mutatePhoto(currentPhoto(), () => { mask.feather = event.currentTarget.valueAsNumber; });
    byId("mask-feather-value").textContent = Math.round(mask.feather * 100) + "%";
    syncWorkspaceTitle();
    updateMaskOverlay();
    schedulePreview();
  });
  byId("mask-invert").addEventListener("click", () => {
    const mask = selectedMask();
    if (!mask) return;
    mutatePhoto(currentPhoto(), () => { mask.invert = !mask.invert; });
    syncWorkspaceTitle();
    syncMaskPanel();
    schedulePreview();
  });
  renderMaskList();
  syncMaskPanel();
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function maskHandle(group, mask, name, x, y, label) {
  const circle = svgElement("circle", {
    cx: x * 1000, cy: y * 1000, r: 11,
    class: "mask-handle", "data-mask-handle": name, "data-mask-id": mask.id,
    tabindex: 0, role: "slider", "aria-label": mask.name + "：" + label,
    "aria-valuemin": 0, "aria-valuemax": 1, "aria-valuenow": Math.round((name.startsWith("radius") ? mask.geometry.radius[name === "radius-x" ? "x" : "y"] : (name === "center" ? mask.geometry.center[name === "center" ? "x" : "y"] : mask.geometry[name].x)) * 100) / 100
  });
  const title = svgElement("title");
  title.textContent = label;
  circle.append(title);
  group.append(circle);
}

function sourcePointToOutput(point, photo = currentPhoto()) {
  const composition = photoComposition(photo);
  const rotated = rotatedDimensions(composition);
  let x = point.x;
  let y = point.y;
  if (composition.rotation === 90) [x, y] = [1 - y, x];
  else if (composition.rotation === 180) [x, y] = [1 - x, 1 - y];
  else if (composition.rotation === 270) [x, y] = [y, 1 - x];
  const crop = cropRect(composition);
  const cropX = (x - crop.x) / Math.max(crop.width, 1e-8);
  const cropY = (y - crop.y) / Math.max(crop.height, 1e-8);
  const fullCrop = actualZoom && fullOriginal?.compositionKey === JSON.stringify(composition) ? fullOriginal : null;
  const cropPixelWidth = fullCrop?.width || Math.max(1, rotated.width * crop.width);
  const cropPixelHeight = fullCrop?.height || Math.max(1, rotated.height * crop.height);
  const localX = (cropX - 0.5) * cropPixelWidth;
  const localY = (cropY - 0.5) * cropPixelHeight;
  const angle = (composition.straighten || 0) * Math.PI / 180;
  if (Math.abs(angle) < 1e-6) return { x: cropX, y: cropY };
  const aspect = cropPixelWidth / cropPixelHeight;
  const cosine = Math.cos(Math.abs(angle));
  const sine = Math.sin(Math.abs(angle));
  const innerHeight = Math.max(1, Math.floor(Math.min(
    cropPixelWidth / (aspect * cosine + sine),
    cropPixelHeight / (aspect * sine + cosine)
  )) - 4);
  const innerWidth = Math.max(1, Math.min(cropPixelWidth, Math.round(innerHeight * aspect)));
  const turnedX = Math.cos(angle) * localX - Math.sin(angle) * localY;
  const turnedY = Math.sin(angle) * localX + Math.cos(angle) * localY;
  return {
    x: 0.5 + turnedX / innerWidth,
    y: 0.5 + turnedY / innerHeight
  };
}

function outputPointToSource(point, photo = currentPhoto()) {
  const origin = sourcePointToOutput({ x: 0, y: 0 }, photo);
  const across = sourcePointToOutput({ x: 1, y: 0 }, photo);
  const down = sourcePointToOutput({ x: 0, y: 1 }, photo);
  const a = across.x - origin.x;
  const b = across.y - origin.y;
  const c = down.x - origin.x;
  const d = down.y - origin.y;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) return point;
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  return { x: (d * x - c * y) / determinant, y: (-b * x + a * y) / determinant };
}

function sourceToOutputMatrix(photo = currentPhoto()) {
  const origin = sourcePointToOutput({ x: 0, y: 0 }, photo);
  const across = sourcePointToOutput({ x: 1, y: 0 }, photo);
  const down = sourcePointToOutput({ x: 0, y: 1 }, photo);
  return [
    across.x - origin.x,
    across.y - origin.y,
    down.x - origin.x,
    down.y - origin.y,
    origin.x * 1000,
    origin.y * 1000
  ];
}

function updateMaskOverlay() {
  const overlay = byId("mask-overlay");
  if (!overlay) return;
  const photo = currentPhoto();
  overlay.hidden = tab !== "masks" || !photo || byId("view").hidden;
  overlay.classList.toggle("is-drawing", Boolean(maskDrawType));
  overlay.replaceChildren();
  if (overlay.hidden) return;
  const defs = svgElement("defs");
  overlay.append(defs);
  const stackRect = byId("photo-stack").getBoundingClientRect();
  const shortEdge = Math.min(stackRect.width, stackRect.height) || 1;
  for (const [index, mask] of currentMasks(photo).entries()) {
    const selected = mask.id === selectedMaskId;
    const color = mask.enabled ? "#dfb588" : "#87919c";
    const matrix = sourceToOutputMatrix(photo).join(" ");
    const group = svgElement("g", { class: "mask-shape" + (selected ? " is-selected" : ""), "data-mask-select": mask.id, opacity: mask.enabled ? 1 : 0.55, transform: "matrix(" + matrix + ")" });
    if (mask.type === "linear") {
      const gradientId = "mask-gradient-" + index;
      const gradient = svgElement("linearGradient", {
        id: gradientId, gradientUnits: "userSpaceOnUse",
        x1: mask.geometry.start.x * 1000, y1: mask.geometry.start.y * 1000,
        x2: mask.geometry.end.x * 1000, y2: mask.geometry.end.y * 1000
      });
      gradient.append(
        svgElement("stop", { offset: "0%", "stop-color": color, "stop-opacity": mask.enabled ? (mask.invert ? "0.01" : "0.22") : "0.08" }),
        svgElement("stop", { offset: "78%", "stop-color": color, "stop-opacity": "0.08" }),
        svgElement("stop", { offset: "100%", "stop-color": color, "stop-opacity": mask.invert ? "0.22" : "0.01" })
      );
      defs.append(gradient);
      group.append(svgElement("rect", { x: 0, y: 0, width: 1000, height: 1000, fill: "url(#" + gradientId + ")", "pointer-events": "none" }));
      group.append(svgElement("line", {
        x1: mask.geometry.start.x * 1000, y1: mask.geometry.start.y * 1000,
        x2: mask.geometry.end.x * 1000, y2: mask.geometry.end.y * 1000,
        class: "mask-axis", stroke: color, "stroke-width": selected ? 2.5 : 1.5,
        "stroke-dasharray": selected ? "none" : "6 8", "vector-effect": "non-scaling-stroke"
      }));
      if (selected) {
        maskHandle(group, mask, "start", mask.geometry.start.x, mask.geometry.start.y, "渐变起点");
        maskHandle(group, mask, "end", mask.geometry.end.x, mask.geometry.end.y, "渐变终点");
      }
    } else {
      const center = mask.geometry.center;
      const radius = mask.geometry.radius;
      const featherX = mask.feather * shortEdge / (stackRect.width || shortEdge);
      const featherY = mask.feather * shortEdge / (stackRect.height || shortEdge);
      const coverageId = "mask-coverage-" + index;
      const coverage = svgElement("mask", { id: coverageId, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 1000, height: 1000 });
      coverage.append(svgElement("rect", { x: 0, y: 0, width: 1000, height: 1000, fill: mask.invert ? "white" : "black" }));
      coverage.append(svgElement("ellipse", {
        cx: center.x * 1000, cy: center.y * 1000,
        rx: radius.x * 1000, ry: radius.y * 1000,
        fill: mask.invert ? "black" : "white"
      }));
      defs.append(coverage);
      group.append(svgElement("rect", {
        x: 0, y: 0, width: 1000, height: 1000, fill: color,
        "fill-opacity": mask.enabled ? "0.12" : "0.045", mask: "url(#" + coverageId + ")", "pointer-events": "none"
      }));
      group.append(svgElement("ellipse", {
        cx: center.x * 1000, cy: center.y * 1000,
        rx: radius.x * 1000, ry: radius.y * 1000,
        fill: "none",
        stroke: color, "stroke-width": selected ? 2 : 1.4,
        "stroke-dasharray": selected ? "none" : "6 8", "vector-effect": "non-scaling-stroke"
      }));
      if (selected && mask.feather > 0) {
        group.append(svgElement("ellipse", {
          cx: center.x * 1000, cy: center.y * 1000,
          rx: Math.min(1, radius.x + featherX) * 1000,
          ry: Math.min(1, radius.y + featherY) * 1000,
          fill: "none", stroke: color, "stroke-width": 1.2, "stroke-dasharray": "3 6",
          "vector-effect": "non-scaling-stroke", "pointer-events": "none", opacity: 0.72
        }));
      }
      if (selected) {
        maskHandle(group, mask, "center", center.x, center.y, "蒙版中心");
        maskHandle(group, mask, "radius-x", Math.min(1, center.x + radius.x), center.y, "椭圆横向大小");
        maskHandle(group, mask, "radius-y", center.x, Math.min(1, center.y + radius.y), "椭圆纵向大小");
      }
    }
    overlay.append(group);
  }
}

function maskPoint(event) {
  const bounds = byId("mask-overlay").getBoundingClientRect();
  const limit = (value) => Math.max(0, Math.min(1, value));
  const outputPoint = { x: limit((event.clientX - bounds.left) / bounds.width), y: limit((event.clientY - bounds.top) / bounds.height) };
  const sourcePoint = outputPointToSource(outputPoint);
  return { x: limit(sourcePoint.x), y: limit(sourcePoint.y) };
}

function moveMaskHandle(mask, handle, point) {
  if (mask.type === "linear") {
    if (handle === "start" || handle === "end") mask.geometry[handle] = { ...point };
  } else if (handle === "center") {
    const radius = mask.geometry.radius;
    mask.geometry.center = {
      x: Math.max(radius.x, Math.min(1 - radius.x, point.x)),
      y: Math.max(radius.y, Math.min(1 - radius.y, point.y))
    };
  } else if (handle === "radius-x") {
    mask.geometry.radius.x = Math.max(0.01, Math.min(1, Math.abs(point.x - mask.geometry.center.x)));
  } else if (handle === "radius-y") {
    mask.geometry.radius.y = Math.max(0.01, Math.min(1, Math.abs(point.y - mask.geometry.center.y)));
  }
}

function updateMaskGesture(event) {
  if (!maskGesture) return;
  const mask = currentMasks().find((entry) => entry.id === maskGesture.id);
  if (!mask) return;
  const point = maskPoint(event);
  if (maskGesture.drawType === "linear") mask.geometry.end = point;
  else if (maskGesture.drawType === "radial") {
    mask.geometry.center = { ...maskGesture.start };
    mask.geometry.radius = {
      x: Math.max(0.01, Math.abs(point.x - maskGesture.start.x)),
      y: Math.max(0.01, Math.abs(point.y - maskGesture.start.y))
    };
  } else moveMaskHandle(mask, maskGesture.handle, point);
  updateMaskOverlay();
}

function preparePanels() {
  const landscape = byId("panel-landscape");
  const histogram = document.createElement("div");
  histogram.className = "histogram";
  histogram.innerHTML = '<span>RGB 直方图</span><canvas id="histogram" width="270" height="77" aria-label="当前效果的 RGB 直方图"></canvas>';
  landscape.append(histogram);
  const base = editorSection(landscape, "base-section", "基础调色", true);
  const whiteBalanceTools = document.createElement("div");
  whiteBalanceTools.className = "white-balance-tools";
  whiteBalanceTools.innerHTML = '<span>白平衡</span><button type="button" class="button small outline" id="white-balance-sample" aria-pressed="false" aria-describedby="white-balance-instruction" disabled>取样白平衡</button>';
  const whiteBalanceInstruction = document.createElement("p");
  whiteBalanceInstruction.id = "white-balance-instruction";
  whiteBalanceInstruction.className = "white-balance-instruction";
  whiteBalanceInstruction.hidden = true;
  base.append(whiteBalanceTools, whiteBalanceInstruction);
  controlGroup(base, "", baseKeys);
  byId("white-balance-sample").addEventListener("click", () => {
    if (whiteBalancePreviewPending() && !whiteBalanceActive) return;
    const active = !whiteBalanceActive;
    setWhiteBalanceMode(active, !active);
    setStatus(active ? "白平衡取样已开启：点击照片中的中性灰或白色区域。" : "已取消白平衡取样。");
  });
  prepareCurve(editorSection(landscape, "curve-section", "曲线"));
  bandControls(editorSection(landscape, "mixer-section", "色彩混合"), "hsl", hslBands, hslAdjustments);
  const grading = editorSection(landscape, "grade-section", "色彩分级");
  gradeWheelControls(grading);
  controlGroup(grading, "", ["colorBalance"]);
  controlGroup(editorSection(landscape, "detail-section", "细节"), "", detailKeys);
  const styleShortcut = document.createElement("div");
  styleShortcut.className = "section-heading workflow-link";
  styleShortcut.innerHTML = '<div><h3>应用风格</h3><p class="section-note" id="landscape-lut-name">未应用滤镜</p></div><button class="button small outline" type="button" id="show-styles">打开风格库</button>';
  landscape.append(styleShortcut);
  controlGroup(landscape, "应用强度", ["lutStrength"], "-shortcut");
  controlGroup(landscape, "成片微调", postKeys);
  byId("show-styles").addEventListener("click", () => selectTab("styles"));
  byId("show-base").addEventListener("click", () => selectTab("landscape"));

  const portrait = byId("panel-portrait");
  const region = document.createElement("div");
  region.className = "region-tools";
  region.innerHTML = '<div class="section-heading"><h3>皮肤区域</h3></div><p class="section-note" id="region-caption"></p><div class="two-buttons"><button type="button" class="button outline" id="choose-region">框选皮肤区域</button><button type="button" class="button quiet" id="clear-region">清除区域</button></div><p id="region-instructions" class="section-note" hidden>拖出矩形。也可用方向键移动，Shift + 方向键调大小，Enter 确认，Esc 取消。</p><button type="button" class="button small outline" id="region-apply" hidden>确认区域</button>';
  portrait.append(region);
  controlGroup(portrait, "局部修饰", ["blemishes", "smoothing", "skinTone", "texture"]);
  byId("choose-region").addEventListener("click", beginRegion);
  byId("clear-region").addEventListener("click", () => {
    const photo = currentPhoto();
    if (!photo) return;
    runPhotoEdit(photo, (target) => { delete target.settings.skinRegion; });
    finishRegion(false);
    syncControls();
    schedulePreview();
  });
  prepareMaskPanel();
  prepareCompositionPanel();
  controlGroup(byId("style-sliders"), "应用强度", ["lutStrength"]);
  controlGroup(byId("style-sliders"), "成片微调", postKeys, "-styles");
}

function prepareCompositionPanel() {
  for (const button of selectAll("[data-aspect]")) {
    button.addEventListener("click", () => chooseAspect(button.dataset.aspect));
  }
  byId("clear-crop").addEventListener("click", () => {
    changeComposition((composition) => {
      composition.crop = null;
      composition.aspect = "free";
    });
    setStatus("已清除裁剪，保留旋转和拉直");
  });
  byId("rotate-left").addEventListener("click", () => rotateComposition(-90));
  byId("rotate-right").addEventListener("click", () => rotateComposition(90));
  bindRangeGesture(byId("straighten-range"), (event) => {
    const value = Math.max(-15, Math.min(15, Math.round(event.currentTarget.valueAsNumber * 10) / 10));
    changeComposition((composition) => { composition.straighten = value; });
  });
}

function selectTab(next) {
  if (!tabs[next]) return;
  if (next !== "landscape" && whiteBalanceActive) setWhiteBalanceMode(false);
  if (editingRegion) finishRegion(false);
  if (next !== "composition") {
    discardCompositionBase();
  }
  if (next !== "masks") {
    maskDrawType = null;
    maskGesture = null;
  }
  tab = next;
  const [title, caption] = tabs[next];
  byId("inspector-title").textContent = title;
  byId("inspector-caption").textContent = caption;
  for (const key of Object.keys(tabs)) {
    byId("panel-" + key).hidden = key !== next;
  }
  for (const button of selectAll("[data-tab]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tab === next));
  }
  updateRegionOverlay();
  syncMaskPanel();
  syncCompositionPanel();
  updateViewControls();
  if (next === "composition" && currentPhoto()) {
    fitCompositionStage();
    loadCompositionBase(currentPhoto());
  } else if (next !== "composition" && !byId("view").hidden) {
    fitImage();
  }
  if (next === "project" && capability) loadProjectList();
  if (next === "landscape") drawHistogram();
}

function showCapabilities() {
  const entries = [
    capability.raw ? "RAW 显影已连接" + (capability.raw_engine ? "（" + capability.raw_engine + "）" : "") : "RAW 显影引擎不可用，仍可导入普通照片",
    capability.portrait === "rapidretouch" ? "已连接外部人像引擎" : "本地人像处理需要手动框选",
    capability.patchy ? "Patchy 已连接，可交接当前照片" : "未配置 Patchy 路径"
  ];
  const list = byId("capabilities");
  list.replaceChildren(...entries.map((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    return item;
  }));
}

function syncPhotoFilterControls() {
  for (const [id, filter] of [["film-filter-all", "all"], ["film-filter-pick", "pick"], ["film-filter-reject", "reject"], ["film-filter-unflagged", "unflagged"]]) {
    const button = byId(id);
    if (button) button.setAttribute("aria-pressed", String(photoFlagFilter === filter));
  }
  const rating = byId("film-min-rating");
  if (rating) rating.value = String(photoMinimumRating);
}

function syncPhotoCullingControls() {
  const photo = currentPhoto();
  for (let rating = 1; rating <= 5; rating += 1) {
    const button = byId("photo-rating-" + rating);
    if (!button) continue;
    button.disabled = !photo;
    button.setAttribute("aria-pressed", String(Boolean(photo && rating <= photo.rating)));
  }
  const clearRating = byId("photo-rating-clear");
  if (clearRating) {
    clearRating.disabled = !photo;
    clearRating.setAttribute("aria-pressed", String(Boolean(photo && photo.rating === 0)));
  }
  for (const [id, flag] of [["photo-flag-pick", "pick"], ["photo-flag-reject", "reject"], ["photo-flag-clear", null]]) {
    const button = byId(id);
    if (!button) continue;
    button.disabled = !photo;
    button.setAttribute("aria-pressed", String(Boolean(photo && (photo.flag ?? null) === flag)));
  }
}

function drawFilmstrip() {
  const container = byId("film-items");
  const previousScroll = container.scrollLeft;
  const visiblePhotos = filteredPhotos();
  const items = visiblePhotos.map((photo) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "film-item";
    const flagLabel = photo.flag === "pick" ? "入选" : photo.flag === "reject" ? "剔除" : "未标记";
    button.title = photo.name + "，" + (photo.rating ? photo.rating + " 星" : "未评分") + "，" + flagLabel;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(photo.id === currentId));
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.src = "/api/thumb?id=" + encodeURIComponent(photo.id);
    const name = document.createElement("span");
    name.className = "film-item-name";
    name.textContent = photo.name;
    const marks = document.createElement("span");
    marks.className = "film-markers";
    marks.setAttribute("aria-hidden", "true");
    if (photo.rating > 0) {
      const rating = document.createElement("span");
      rating.textContent = photo.rating + "★";
      marks.append(rating);
    }
    if (photo.flag) {
      const flag = document.createElement("span");
      flag.className = photo.flag === "pick" ? "film-marker-pick" : "film-marker-reject";
      flag.textContent = photo.flag === "pick" ? "✓" : "×";
      marks.append(flag);
    }
    button.append(image, name, marks);
    button.addEventListener("click", () => selectPhoto(photo.id));
    return button;
  });
  if (items.length) {
    container.replaceChildren(...items);
  } else {
    const empty = document.createElement("div");
    empty.className = "film-empty";
    empty.setAttribute("role", "status");
    const message = document.createElement("span");
    message.textContent = photos.length ? "没有符合条件的照片。调整筛选条件，或清除筛选。" : "暂无照片。添加照片后即可开始挑片。";
    empty.append(message);
    if (photos.length) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.id = "film-filter-clear";
      clear.className = "button small outline";
      clear.textContent = "清除筛选";
      clear.addEventListener("click", () => setPhotoFilter("all", 0));
      empty.append(clear);
    }
    container.replaceChildren(empty);
  }
  container.scrollLeft = previousScroll;
  byId("photo-count").textContent = photoFlagFilter === "all" && photoMinimumRating === 0
    ? photos.length + " 张" : visiblePhotos.length + " / " + photos.length + " 张";
  syncPhotoFilterControls();
}

function updateFilmSelection() {
  const index = filteredPhotos().findIndex((photo) => photo.id === currentId);
  [...byId("film-items").children].forEach((button, buttonIndex) => {
    button.setAttribute("aria-pressed", String(index === buttonIndex));
    if (index === buttonIndex) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function setPhotoFilter(flagFilter = photoFlagFilter, minimumRating = photoMinimumRating) {
  photoFlagFilter = ["all", "pick", "reject", "unflagged"].includes(flagFilter) ? flagFilter : "all";
  photoMinimumRating = Number.isInteger(minimumRating) && minimumRating >= 0 && minimumRating <= 5 ? minimumRating : 0;
  syncPhotoFilterControls();
  drawFilmstrip();
  const visible = filteredPhotos();
  const nextPhoto = firstPhotoToSelectAfterFilter(currentId, visible);
  if (nextPhoto) void selectPhoto(nextPhoto.id);
}

function refreshFilmstripAfterMetadataChange() {
  drawFilmstrip();
  const visible = filteredPhotos();
  const nextPhoto = firstPhotoToSelectAfterFilter(currentId, visible);
  if (nextPhoto) void selectPhoto(nextPhoto.id);
}

function setCurrentPhotoRating(rating) {
  const photo = currentPhoto();
  if (!setPhotoRating(photo, rating)) return;
  syncPhotoCullingControls();
  updateDirtyState();
  refreshFilmstripAfterMetadataChange();
  setStatus(rating ? "已设为 " + rating + " 星" : "已清除星级");
}

function setCurrentPhotoFlag(flag) {
  const photo = currentPhoto();
  if (!setPhotoFlag(photo, flag)) return;
  syncPhotoCullingControls();
  updateDirtyState();
  refreshFilmstripAfterMetadataChange();
  setStatus(flag === "pick" ? "已标记为入选" : flag === "reject" ? "已标记为剔除" : "已清除旗标");
}

async function importPhotos(files) {
  if (loadingFiles) return;
  const selected = [...files];
  if (!selected.length) return;
  loadingFiles = true;
  const imported = [];
  const failures = [];
  try {
    for (const [index, file] of selected.entries()) {
      setStatus("正在导入 " + (index + 1) + "/" + selected.length + "  " + file.name, "busy");
      try {
        const response = await request("/api/import?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
        const info = await response.json();
        if (typeof info.id !== "string") throw new Error("未取得照片编号");
        const existing = photos.find((photo) => photo.id === info.id);
        if (!existing) {
          const photo = normalizePhotoCullingMetadata({ id: info.id, name: info.name || file.name, raw: Boolean(info.raw), settings: { ...defaults, masks: [] }, lutId: null });
          photos.push(photo);
          photoHistory?.reset(photo.id, photoSnapshot(photo));
        }
        imported.push(info.id);
      } catch (error) {
        failures.push(file.name + "：" + error.message);
      }
    }
    if (imported.length) {
      updateDirtyState();
      drawFilmstrip();
      await selectPhoto(imported[0]);
    }
    const message = "已导入 " + imported.length + " 张照片";
    setStatus(failures.length ? message + "，" + failures.length + " 张失败。 " + failures[0] : message, failures.length ? "error" : "");
  } finally {
    loadingFiles = false;
  }
}

function setSplit(value) {
  split = value;
  byId("split").value = value;
  byId("photo-stack").style.setProperty("--split", value + "%");
}

function updateViewControls() {
  const ready = Boolean(currentPhoto() && originalUrl);
  const composing = tab === "composition";
  const peek = ready && peekingOriginal && !editingRegion && !composing && !whiteBalanceActive;
  byId("compare-toggle").disabled = !ready || composing || whiteBalanceActive;
  byId("compare-toggle").setAttribute("aria-pressed", String(comparing));
  byId("compare-ui").hidden = !comparing || editingRegion || peek || composing || whiteBalanceActive;
  const stack = byId("photo-stack");
  stack.classList.toggle("solo", !comparing || editingRegion || composing || whiteBalanceActive);
  stack.classList.toggle("peek-original", peek);
  stack.classList.toggle("composing", composing);
  byId("composition-canvas").hidden = !composing;
  byId("peek-label").hidden = !peek;
  byId("zoom-in").disabled = !ready || composing || (!actualZoom && zoom >= 4);
  byId("zoom-out").disabled = !ready || composing || (!actualZoom && zoom <= 1);
  byId("zoom-fit").disabled = !ready || composing || (!actualZoom && zoom === 1);
  byId("zoom-actual").disabled = !ready || composing;
  byId("zoom-actual").setAttribute("aria-pressed", String(actualZoom));
  byId("zoom-label").textContent = actualZoom && fullOriginal
    ? "实际像素"
    : (zoom === 1 ? "适合窗口" : "适合 ×" + Math.round(zoom * 100) / 100);
  updateMaskOverlay();
  updateCompositionOverlay();
  if (composing) fitCompositionStage();
  syncWhiteBalanceTool();
  updateClippingOverlay();
}

function fitImage() {
  if (tab === "composition") {
    fitCompositionStage();
    return;
  }
  const view = byId("view");
  const stack = byId("photo-stack");
  const actual = actualZoom && fullOriginal;
  const center = actual && !view.classList.contains("actual-size");
  const scale = window.devicePixelRatio || 1;
  const canvas = byId("canvas");
  const availableWidth = Math.max(1, canvas.clientWidth - 30);
  const availableHeight = Math.max(1, canvas.clientHeight - 30);
  const width = actual ? fullOriginal.width / scale : Math.min(availableWidth, availableHeight * aspect) * zoom;
  const height = actual ? fullOriginal.height / scale : width / aspect;
  view.classList.toggle("actual-size", Boolean(actual));
  view.classList.toggle("scrollable", Boolean(actual || zoom > 1));
  stack.style.width = width + "px";
  stack.style.height = height + "px";
  if (center) {
    view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2;
    view.scrollTop = (view.scrollHeight - view.clientHeight) / 2;
  }
  updateViewControls();
}

function compositionGeometry(composition = photoComposition()) {
  const dimensions = compositionBaseImage
    ? { width: compositionBaseImage.naturalWidth, height: compositionBaseImage.naturalHeight }
    : sourceDimensions();
  const rotatedWidth = composition.rotation % 180 === 90 ? dimensions.height : dimensions.width;
  const rotatedHeight = composition.rotation % 180 === 90 ? dimensions.width : dimensions.height;
  const angle = (composition.straighten || 0) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(angle));
  const sine = Math.abs(Math.sin(angle));
  return {
    ...dimensions,
    rotatedWidth,
    rotatedHeight,
    boundsWidth: cosine * rotatedWidth + sine * rotatedHeight,
    boundsHeight: sine * rotatedWidth + cosine * rotatedHeight,
    angle
  };
}

function fitCompositionStage() {
  if (tab !== "composition" || !currentPhoto() || byId("view").hidden) return;
  const geometry = compositionGeometry();
  if (!(geometry.boundsWidth > 0 && geometry.boundsHeight > 0)) return;
  const canvas = byId("canvas");
  const maxWidth = Math.max(1, canvas.clientWidth - 30);
  const maxHeight = Math.max(1, canvas.clientHeight - 30);
  const scale = Math.min(maxWidth / geometry.boundsWidth, maxHeight / geometry.boundsHeight);
  const stack = byId("photo-stack");
  stack.style.width = (geometry.boundsWidth * scale) + "px";
  stack.style.height = (geometry.boundsHeight * scale) + "px";
  drawCompositionImage();
  updateCompositionOverlay();
}

function drawCompositionImage() {
  const canvas = byId("composition-canvas");
  const context = canvas.getContext("2d");
  const rect = byId("photo-stack").getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  compositionPaintSequence++;
  if (!compositionBaseImage?.naturalWidth) return;
  const composition = photoComposition();
  const geometry = compositionGeometry(composition);
  const scale = Math.min(width / geometry.boundsWidth, height / geometry.boundsHeight);
  context.translate(width / 2, height / 2);
  context.scale(scale, scale);
  context.rotate((composition.rotation + composition.straighten) * Math.PI / 180);
  context.drawImage(compositionBaseImage, -geometry.width / 2, -geometry.height / 2, geometry.width, geometry.height);
  updateClippingOverlay();
}

function cropPointToScreen(point, composition = photoComposition()) {
  const geometry = compositionGeometry(composition);
  const x = (point.x - 0.5) * geometry.rotatedWidth;
  const y = (point.y - 0.5) * geometry.rotatedHeight;
  const cosine = Math.cos(geometry.angle);
  const sine = Math.sin(geometry.angle);
  return {
    x: 0.5 + (cosine * x - sine * y) / geometry.boundsWidth,
    y: 0.5 + (sine * x + cosine * y) / geometry.boundsHeight
  };
}

function screenPointToCrop(point, composition = photoComposition()) {
  const geometry = compositionGeometry(composition);
  const x = (point.x - 0.5) * geometry.boundsWidth;
  const y = (point.y - 0.5) * geometry.boundsHeight;
  const cosine = Math.cos(geometry.angle);
  const sine = Math.sin(geometry.angle);
  return {
    x: 0.5 + (cosine * x + sine * y) / geometry.rotatedWidth,
    y: 0.5 + (-sine * x + cosine * y) / geometry.rotatedHeight
  };
}

function cropPathPoints(crop, composition = photoComposition()) {
  return [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.width, y: crop.y },
    { x: crop.x + crop.width, y: crop.y + crop.height },
    { x: crop.x, y: crop.y + crop.height }
  ].map((point) => cropPointToScreen(point, composition));
}

function updateCompositionOverlay() {
  const overlay = byId("composition-overlay");
  if (!overlay) return;
  const photo = currentPhoto();
  overlay.hidden = tab !== "composition" || !photo || byId("view").hidden;
  overlay.classList.toggle("is-active", !overlay.hidden);
  overlay.replaceChildren();
  if (overlay.hidden) return;
  const composition = photoComposition(photo);
  const crop = cropRect(composition);
  const points = cropPathPoints(crop, composition);
  const pointString = points.map((point) => (point.x * 1000) + "," + (point.y * 1000)).join(" ");
  const defs = svgElement("defs");
  const clip = svgElement("clipPath", { id: "crop-guide-clip", clipPathUnits: "userSpaceOnUse" });
  clip.append(svgElement("polygon", { points: pointString }));
  defs.append(clip);
  overlay.append(defs);
  const outside = svgElement("path", {
    d: "M0 0H1000V1000H0Z M" + pointString.replace(/ /g, "L") + "Z",
    "fill-rule": "evenodd", fill: "#05080c", "fill-opacity": "0.62", "pointer-events": "none"
  });
  overlay.append(outside);
  for (const fraction of [1 / 3, 2 / 3]) {
    const top = cropPointToScreen({ x: crop.x + crop.width * fraction, y: crop.y }, composition);
    const bottom = cropPointToScreen({ x: crop.x + crop.width * fraction, y: crop.y + crop.height }, composition);
    const left = cropPointToScreen({ x: crop.x, y: crop.y + crop.height * fraction }, composition);
    const right = cropPointToScreen({ x: crop.x + crop.width, y: crop.y + crop.height * fraction }, composition);
    overlay.append(
      svgElement("line", { x1: top.x * 1000, y1: top.y * 1000, x2: bottom.x * 1000, y2: bottom.y * 1000, class: "crop-guide", "clip-path": "url(#crop-guide-clip)" }),
      svgElement("line", { x1: left.x * 1000, y1: left.y * 1000, x2: right.x * 1000, y2: right.y * 1000, class: "crop-guide", "clip-path": "url(#crop-guide-clip)" })
    );
  }
  overlay.append(svgElement("polygon", {
    points: pointString, class: "crop-boundary", "data-crop-move": "true", fill: "transparent"
  }));
  overlay.append(svgElement("polygon", { points: pointString, class: "crop-outline", "pointer-events": "none" }));
  const names = ["nw", "ne", "se", "sw"];
  const stage = byId("photo-stack").getBoundingClientRect();
  const unitX = 1000 / Math.max(1, stage.width);
  const unitY = 1000 / Math.max(1, stage.height);
  points.forEach((point, index) => {
    overlay.append(svgElement("ellipse", {
      cx: point.x * 1000, cy: point.y * 1000, rx: 18 * unitX, ry: 18 * unitY,
      class: "crop-handle-hit", "data-crop-handle": names[index], "aria-hidden": "true"
    }));
    const handle = svgElement("ellipse", {
      cx: point.x * 1000, cy: point.y * 1000, rx: 6 * unitX, ry: 6 * unitY,
      class: "crop-handle", "data-crop-handle": names[index],
      tabindex: 0, role: "slider", "aria-label": ["左上", "右上", "右下", "左下"][index] + "裁剪角点",
      "aria-valuemin": 0, "aria-valuemax": 1, "aria-valuenow": Math.round(([1, 2].includes(index) ? crop.x + crop.width : crop.x) * 100) / 100
    });
    overlay.append(handle);
  });
  updateClippingOverlay();
}

function compositionPointerPoint(event) {
  const rect = byId("composition-overlay").getBoundingClientRect();
  return screenPointToCrop({
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  });
}

function normalizedAspectForCrop(composition) {
  const target = namedAspectRatio(composition.aspect, composition);
  const dimensions = rotatedDimensions(composition);
  const imageAspect = dimensions.width && dimensions.height ? dimensions.width / dimensions.height : 1;
  return target ? target / imageAspect : null;
}

function resizeCropCorner(start, handle, point, composition) {
  const sx = handle.includes("w") ? 1 : -1;
  const sy = handle.includes("n") ? 1 : -1;
  const anchorX = sx > 0 ? start.x + start.width : start.x;
  const anchorY = sy > 0 ? start.y + start.height : start.y;
  let width = Math.max(0.02, Math.abs(point.x - anchorX));
  let height = Math.max(0.02, Math.abs(point.y - anchorY));
  const aspect = normalizedAspectForCrop(composition);
  if (aspect) {
    const widthChange = Math.abs(width - start.width) / Math.max(start.width, 1e-8);
    const heightChange = Math.abs(height - start.height) / Math.max(start.height, 1e-8);
    if (widthChange >= heightChange) height = width / aspect;
    else width = height * aspect;
  }
  let maxWidth = sx > 0 ? anchorX : 1 - anchorX;
  let maxHeight = sy > 0 ? anchorY : 1 - anchorY;
  if (aspect) {
    maxWidth = Math.min(maxWidth, maxHeight * aspect);
    maxHeight = Math.min(maxHeight, maxWidth / aspect);
  }
  width = Math.min(width, maxWidth);
  height = Math.min(height, maxHeight);
  if (aspect) {
    if (width / Math.max(height, 1e-8) > aspect) width = height * aspect;
    else height = width / aspect;
  }
  return {
    x: sx > 0 ? anchorX - width : anchorX,
    y: sy > 0 ? anchorY - height : anchorY,
    width,
    height
  };
}

function updateCompositionGesture(event) {
  if (!compositionGesture || compositionGesture.pointerId !== event.pointerId) return;
  const photo = currentPhoto();
  if (!photo) return;
  const point = compositionPointerPoint(event);
  const composition = ensureComposition(photo);
  const start = compositionGesture.startCrop;
  if (compositionGesture.kind === "move") {
    const dx = point.x - compositionGesture.startPoint.x;
    const dy = point.y - compositionGesture.startPoint.y;
    composition.crop = {
      ...start,
      x: Math.max(0, Math.min(1 - start.width, start.x + dx)),
      y: Math.max(0, Math.min(1 - start.height, start.y + dy))
    };
  } else {
    composition.crop = resizeCropCorner(start, compositionGesture.handle, point, composition);
  }
  updateDirtyState();
  updateCompositionOverlay();
}

function changeComposition(mutator, preview = true) {
  const photo = currentPhoto();
  if (!photo) return;
  mutatePhoto(photo, (target) => mutator(ensureComposition(target)));
  actualZoom = false;
  zoom = 1;
  byId("view").classList.remove("actual-size", "scrollable");
  syncCompositionPanel();
  if (tab === "composition") {
    fitCompositionStage();
    drawCompositionImage();
  }
  if (preview) schedulePreview();
}

function chooseAspect(value) {
  changeComposition((composition) => {
    composition.aspect = value;
    if (value !== "free") composition.crop = centeredCropForAspect(value, composition);
  });
  setStatus(value === "free" ? "已切换为自由裁剪" : "已应用 " + (value === "original" ? "原比例" : value) + " 构图");
}

function rotateComposition(direction) {
  changeComposition((composition) => {
    const previousCrop = composition.crop ? { ...composition.crop } : null;
    const previousCenter = previousCrop
      ? { x: previousCrop.x + previousCrop.width / 2, y: previousCrop.y + previousCrop.height / 2 }
      : { x: 0.5, y: 0.5 };
    const nextCenter = rotateCropPoint(previousCenter, direction);
    composition.rotation = (composition.rotation + direction + 360) % 360;
    if (composition.aspect === "free") {
      if (previousCrop) composition.crop = rotateCropRectangle(previousCrop, direction);
    } else {
      composition.crop = cropForAspectAtCenter(composition.aspect, nextCenter, composition);
    }
  });
  setStatus("已旋转照片 " + (direction > 0 ? "90°" : "-90°"));
}

function loadCompositionBase(photo) {
  if (!photo || !originalUrl || tab !== "composition") return;
  if (compositionBaseImage && compositionBaseId === photo.id) {
    fitCompositionStage();
    return;
  }
  compositionController?.abort();
  const controller = new AbortController();
  compositionController = controller;
  const loadSequence = ++compositionLoadSequence;
  const settings = {
    ...photo.settings,
    composition: { crop: null, aspect: "free", rotation: 0, straighten: 0 }
  };
  renderBlob(photo, settings, photo.lutId, controller.signal).then(async (blob) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await waitForImage(image);
    if (loadSequence !== compositionLoadSequence || currentId !== photo.id || tab !== "composition") {
      URL.revokeObjectURL(url);
      return;
    }
    if (compositionBaseUrl) URL.revokeObjectURL(compositionBaseUrl);
    compositionBaseUrl = url;
    compositionBaseImage = image;
    compositionBaseId = photo.id;
    fitCompositionStage();
    setStatus("构图预览已就绪");
  }).catch((error) => {
    if (error.name !== "AbortError" && loadSequence === compositionLoadSequence) {
      setStatus("无法准备构图预览：" + error.message, "error");
    }
  });
}

function discardCompositionBase() {
  compositionController?.abort();
  compositionController = null;
  compositionLoadSequence++;
  if (compositionBaseUrl) URL.revokeObjectURL(compositionBaseUrl);
  compositionBaseUrl = undefined;
  compositionBaseImage = undefined;
  compositionBaseId = undefined;
  compositionGesture = null;
}

function renderBlob(photo, settings, lutId, signal, resolution = "preview") {
  return post("/api/render", { id: photo.id, settings, lutId, resolution }, signal).then((response) => response.blob());
}

function hasAdjustments(photo) {
  const hasMaskAdjustments = (photo.settings.masks || []).some((mask) => mask.enabled && Object.values(mask.adjustments || {}).some((value) => Number(value) !== 0));
  return hasMaskAdjustments || compositionHasEffect(photoComposition(photo)) || Boolean(photo.lutId) || Boolean(Object.keys(photo.settings.curves || {}).length) || Object.entries(defaults).some(([key, value]) => key !== "lutStrength" && key !== "masks" && (photo.settings[key] ?? value) !== value);
}

function renderStatus(label) {
  byId("render-chip").textContent = label;
  byId("render-chip").hidden = !label;
  syncWhiteBalanceTool();
}

function updateZoom(next, actual = false) {
  if (!actualZoom && !actual && zoom === next) return;
  const changingQuality = actual !== actualZoom;
  actualZoom = actual;
  zoom = next;
  if (!actual) byId("image-original").src = comparisonOriginalUrl || originalUrl;
  fitImage();
  if (changingQuality) schedulePreview();
}

function waitForImage(image) {
  if (typeof image.decode === "function") return image.decode();
  if (image.complete) return Promise.resolve();
  return new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", reject, { once: true });
  });
}

async function selectPhoto(id, force = false) {
  if (id === currentId && originalUrl && !force) return;
  finishPhotoGestures(false); // Browsing commits an in-progress edit instead of reverting its settings.
  setWhiteBalanceMode(false);
  clearTimeout(renderTimer);
  clearTimeout(fullRenderTimer);
  previewController?.abort();
  discardCompositionBase();
  if (editingRegion) finishRegion(false);
  currentId = id;
  selectedMaskId = currentMasks().find((mask) => mask.id === selectedMaskId)?.id || currentMasks()[0]?.id || null;
  maskDrawType = null;
  maskGesture = null;
  zoom = 1;
  actualZoom = false;
  peekingOriginal = false;
  byId("view").classList.remove("actual-size", "scrollable");
  setSplit(50);
  const sequence = ++photoSequence;
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (editedUrl) URL.revokeObjectURL(editedUrl);
  if (comparisonOriginalUrl) URL.revokeObjectURL(comparisonOriginalUrl);
  if (fullOriginal) URL.revokeObjectURL(fullOriginal.url);
  fullOriginal = undefined;
  originalUrl = undefined;
  editedUrl = undefined;
  comparisonOriginalUrl = undefined;
  comparisonCompositionKey = undefined;
  sourceImageSize = { width: 0, height: 0 };
  byId("view").hidden = true;
  const photo = currentPhoto();
  byId("canvas-name").textContent = photo?.name || "照片预览";
  byId("empty").hidden = Boolean(photo);
  byId("footer-meta").textContent = photo?.raw ? "RAW 照片 / 本机处理" : "仅在本机处理";
  updateFilmSelection();
  drawLuts();
  renderMaskList();
  updateRegionOverlay();
  syncControls();
  if (!photo) {
    renderStatus("");
    drawHistogram();
    return;
  }

  renderStatus("正在读取原图");
  try {
    let blob = originals.get(id);
    if (!blob) {
      blob = await renderBlob(photo, {}, null);
      if (originals.size >= 10) originals.delete(originals.keys().next().value);
      originals.set(id, blob);
    }
    if (sequence !== photoSequence) return;
    originalUrl = URL.createObjectURL(blob);
    const original = byId("image-original");
    const edited = byId("image-edited");
    original.src = originalUrl;
    edited.src = originalUrl;
    await waitForImage(original);
    if (sequence !== photoSequence) return;
    sourceImageSize = { width: original.naturalWidth, height: original.naturalHeight };
    aspect = original.naturalWidth / original.naturalHeight;
    byId("view").hidden = false;
    fitImage();
    drawHistogram();
    if (tab === "composition") loadCompositionBase(photo);
    if (hasAdjustments(photo)) schedulePreview();
    else renderStatus("预览");
  } catch (error) {
    if (sequence !== photoSequence) return;
    renderStatus("");
    byId("empty").hidden = false;
    setStatus("无法显示 " + photo.name + "：" + error.message, "error");
  }
}

function showEdited(blob, fallbackUrl) {
  const nextUrl = blob ? URL.createObjectURL(blob) : fallbackUrl;
  if (editedUrl) URL.revokeObjectURL(editedUrl);
  editedUrl = blob ? nextUrl : undefined;
  byId("clipping-overlay").hidden = true;
  byId("image-edited").src = nextUrl;
}

async function refreshComparisonOriginal(photo, controller, current) {
  const composition = photoComposition(photo);
  const key = JSON.stringify(composition);
  if (!compositionHasEffect(composition)) {
    if (comparisonOriginalUrl) URL.revokeObjectURL(comparisonOriginalUrl);
    comparisonOriginalUrl = undefined;
    comparisonCompositionKey = undefined;
    byId("image-original").src = originalUrl;
    return;
  }
  if (comparisonCompositionKey === key && comparisonOriginalUrl) {
    byId("image-original").src = comparisonOriginalUrl;
    return;
  }
  const blob = await renderBlob(photo, { composition }, null, controller.signal);
  if (!current()) return;
  const url = URL.createObjectURL(blob);
  if (comparisonOriginalUrl) URL.revokeObjectURL(comparisonOriginalUrl);
  comparisonOriginalUrl = url;
  comparisonCompositionKey = key;
  byId("image-original").src = url;
  await waitForImage(byId("image-original"));
}

async function renderFull(photo, controller, current) {
  if (!current() || !actualZoom) return;
  renderStatus("正在读取实际像素");
  let candidateUrl;
  try {
    const composition = photoComposition(photo);
    const compositionKey = JSON.stringify(composition);
    if (fullOriginal && fullOriginal.compositionKey !== compositionKey) {
      URL.revokeObjectURL(fullOriginal.url);
      fullOriginal = undefined;
    }
    if (!fullOriginal) {
      const blob = await renderBlob(photo, { composition }, null, controller.signal, "full");
      if (!current() || !actualZoom) return;
      const image = new Image();
      candidateUrl = URL.createObjectURL(blob);
      image.src = candidateUrl;
      await waitForImage(image);
      if (!current() || !actualZoom) return;
      fullOriginal = { url: candidateUrl, width: image.naturalWidth, height: image.naturalHeight, compositionKey };
      candidateUrl = undefined;
    }
    const blob = hasAdjustments(photo)
      ? await renderBlob(photo, photo.settings, photo.lutId, controller.signal, "full")
      : null;
    if (!current() || !actualZoom) return;
    if (blob) {
      const image = new Image();
      candidateUrl = URL.createObjectURL(blob);
      image.src = candidateUrl;
      await waitForImage(image);
      if (!current() || !actualZoom) return;
      if (editedUrl) URL.revokeObjectURL(editedUrl);
      editedUrl = candidateUrl;
      candidateUrl = undefined;
      byId("image-edited").src = editedUrl;
    } else {
      showEdited(null, fullOriginal.url);
    }
    byId("image-original").src = fullOriginal.url;
    fitImage();
    renderStatus("全分辨率");
  } catch (error) {
    if (error.name !== "AbortError" && current() && actualZoom) {
      if (!byId("view").classList.contains("actual-size")) {
        actualZoom = false;
        fitImage();
      }
      renderStatus("预览");
      setStatus("读取实际像素失败：" + error.message, "error");
    }
  } finally {
    if (candidateUrl) URL.revokeObjectURL(candidateUrl);
  }
}

function schedulePreview() {
  const photo = currentPhoto();
  if (!photo || !originalUrl) return;
  const sequence = ++renderSequence;
  const sourceSequence = photoSequence;
  const current = () => sequence === renderSequence && sourceSequence === photoSequence;
  clearTimeout(renderTimer);
  clearTimeout(fullRenderTimer);
  previewController?.abort();
  renderStatus("正在生成预览");
  renderTimer = setTimeout(async () => {
    const controller = new AbortController();
    previewController = controller;
    try {
      const blob = hasAdjustments(photo)
        ? await renderBlob(photo, photo.settings, photo.lutId, controller.signal)
        : null;
      if (!current()) return;
      showEdited(blob, originalUrl);
      if (blob) {
        await waitForImage(byId("image-edited"));
        if (!current()) return;
        aspect = byId("image-edited").naturalWidth / byId("image-edited").naturalHeight;
      } else {
        const source = sourceDimensions();
        aspect = source.width && source.height ? source.width / source.height : aspect;
      }
      if (!actualZoom) await refreshComparisonOriginal(photo, controller, current);
      if (!current()) return;
      if (!actualZoom && tab !== "composition") fitImage();
      renderStatus("预览");
      if (actualZoom) fullRenderTimer = setTimeout(() => renderFull(photo, controller, current), 450);
    } catch (error) {
      if (error.name !== "AbortError" && current()) {
        renderStatus("预览");
        setStatus("预览失败：" + error.message, "error");
      }
    }
  }, 170);
}

function clippingMask(source, key) {
  const cached = clippingMasks.get(source);
  if (cached?.key === key) return cached.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    const highlight = pixels[index] >= 250 || pixels[index + 1] >= 250 || pixels[index + 2] >= 250;
    const shadow = pixels[index] <= 5 && pixels[index + 1] <= 5 && pixels[index + 2] <= 5;
    if (alpha && (highlight || shadow)) {
      pixels[index] = highlight ? 255 : 48;
      pixels[index + 1] = highlight ? 48 : 112;
      pixels[index + 2] = highlight ? 48 : 255;
      pixels[index + 3] = Math.min(alpha, 225);
    } else pixels[index + 3] = 0;
  }
  context.putImageData(image, 0, 0);
  clippingMasks.set(source, { key, canvas });
  return canvas;
}

function updateClippingOverlay() {
  const overlay = byId("clipping-overlay");
  if (!overlay) return;
  const ready = Boolean(currentPhoto() && originalUrl && !byId("view").hidden);
  byId("clipping-toggle").disabled = !ready;
  byId("clipping-toggle").setAttribute("aria-pressed", String(clippingEnabled));
  const composing = tab === "composition";
  const source = byId(composing ? "composition-canvas" : "image-edited");
  const sourceReady = composing ? compositionBaseId === currentId && Boolean(compositionBaseImage) : source.complete && source.naturalWidth > 0;
  const visible = Boolean(clippingEnabled && ready && sourceReady && !byId("photo-stack").classList.contains("peek-original"));
  overlay.hidden = !visible;
  byId("clipping-legend").hidden = !visible;
  if (!visible) return;
  const mask = clippingMask(source, composing ? compositionPaintSequence : source.currentSrc || source.src);
  overlay.width = mask.width;
  overlay.height = mask.height;
  const context = overlay.getContext("2d");
  context.save();
  if (composing) {
    // Composition shows the whole transformed photo, not the cropped output image.
    // Clip the viewing aid to both the active crop polygon and the image's alpha.
    const points = cropPathPoints(cropRect());
    context.beginPath();
    points.forEach((point, index) => {
      const x = point.x * overlay.width;
      const y = point.y * overlay.height;
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.closePath();
    context.clip();
  }
  context.drawImage(mask, 0, 0);
  context.restore();
}

const histogramSample = document.createElement("canvas");
histogramSample.width = 180;
histogramSample.height = 110;
const sampleContext = histogramSample.getContext("2d", { willReadFrequently: true });

function drawHistogram() {
  const graph = byId("histogram");
  const context = graph.getContext("2d");
  const { width, height } = graph;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#303841";
  context.beginPath();
  for (const part of [0.25, 0.5, 0.75]) {
    context.moveTo(width * part, 1);
    context.lineTo(width * part, height);
  }
  context.moveTo(0, height - 0.5);
  context.lineTo(width, height - 0.5);
  context.stroke();

  const image = byId("image-edited");
  if (!currentPhoto() || byId("view").hidden || !image.complete || !image.naturalWidth) return;
  sampleContext.drawImage(image, 0, 0, histogramSample.width, histogramSample.height);
  const data = sampleContext.getImageData(0, 0, histogramSample.width, histogramSample.height).data;
  const buckets = Array.from({ length: 3 }, () => new Uint32Array(128));
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) buckets[channel][data[index + channel] >> 1] += 1;
  }
  const peak = Math.max(1, ...buckets.flatMap((values) => [...values]));
  const colors = ["#e78074a8", "#93c18cad", "#78a4d4ad"];
  for (const [channel, values] of buckets.entries()) {
    context.fillStyle = colors[channel];
    context.beginPath();
    context.moveTo(0, height);
    values.forEach((value, index) => {
      context.lineTo(index * width / (values.length - 1), height - Math.sqrt(value / peak) * (height - 4));
    });
    context.lineTo(width, height);
    context.fill();
  }
}


function drawLuts() {
  const photo = currentPhoto();
  const entries = preferences.luts.filter((lut) => !favoritesOnly || preferences.favorites.includes(lut.id));
  const container = byId("lut-list");
  byId("filter-all").setAttribute("aria-pressed", String(!favoritesOnly));
  byId("filter-favorites").setAttribute("aria-pressed", String(favoritesOnly));
  const rowFor = (lut) => {
    const row = document.createElement("div");
    row.className = "lut-row";
    row.setAttribute("aria-current", String((photo?.lutId || null) === lut.id));
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "lut-choice";
    choice.textContent = lut.name;
    choice.title = lut.name;
    choice.disabled = !photo;
    choice.addEventListener("click", () => applyLut(lut.id));
    row.append(choice);
    if (lut.id) {
      const favorite = preferences.favorites.includes(lut.id);
      const star = document.createElement("button");
      star.type = "button";
      star.className = "icon-button lut-star";
      star.setAttribute("aria-label", (favorite ? "取消收藏 " : "收藏 ") + lut.name);
      star.setAttribute("aria-pressed", String(favorite));
      star.innerHTML = svgIcon("star");
      star.addEventListener("click", () => {
        preferences.favorites = favorite
          ? preferences.favorites.filter((id) => id !== lut.id)
          : [...preferences.favorites, lut.id];
        savePreferences();
        drawLuts();
      });
      row.append(star);
    }
    return row;
  };

  const rows = entries.map(rowFor);
  if (!favoritesOnly) rows.unshift(rowFor({ id: null, name: "无滤镜" }));
  if (!entries.length) {
    const hint = document.createElement("p");
    hint.className = "section-note";
    hint.textContent = favoritesOnly ? "还没有收藏的滤镜。" : "导入 .cube 后即可在这里应用和收藏。";
    rows.push(hint);
  }
  container.replaceChildren(...rows);
}

function applyLut(id) {
  const photo = currentPhoto();
  if (!photo) return;
  mutatePhoto(photo, () => { photo.lutId = id; });
  drawLuts();
  syncControls();
  schedulePreview();
}

async function importLut(file) {
  if (!file) return;
  setStatus("正在读取滤镜 " + file.name, "busy");
  try {
    const response = await request("/api/lut?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
    const lut = await response.json();
    if (!preferences.luts.some((entry) => entry.id === lut.id)) preferences.luts.push(lut);
    savePreferences();
    favoritesOnly = false;
    applyLut(lut.id);
    drawLuts();
    setStatus("已导入滤镜 " + lut.name);
  } catch (error) {
    setStatus("导入滤镜失败：" + error.message, "error");
  }
}

function updateRegionOverlay() {
  const region = editingRegion ? regionDraft : currentPhoto()?.settings.skinRegion;
  const overlay = byId("skin-overlay");
  overlay.hidden = tab !== "portrait" || !region;
  if (!overlay.hidden) {
    overlay.style.left = region.x * 100 + "%";
    overlay.style.top = region.y * 100 + "%";
    overlay.style.width = region.width * 100 + "%";
    overlay.style.height = region.height * 100 + "%";
  }
}

function beginRegion() {
  const photo = currentPhoto();
  if (!photo || byId("view").hidden) return;
  if (editingRegion) {
    finishRegion(false);
    return;
  }
  editingRegion = true;
  regionEditBefore = photoSnapshot(photo);
  peekingOriginal = false;
  regionDraft = { ...(photo.settings.skinRegion || { x: 0.28, y: 0.24, width: 0.44, height: 0.52 }) };
  const stack = byId("photo-stack");
  stack.classList.add("selecting");
  stack.tabIndex = 0;
  stack.focus();
  byId("choose-region").textContent = "取消框选";
  byId("region-instructions").hidden = false;
  byId("region-apply").hidden = false;
  updateViewControls();
  updateRegionOverlay();
}

function finishRegion(apply) {
  const photo = currentPhoto();
  if (apply && photo && regionDraft?.width >= 0.02 && regionDraft?.height >= 0.02) {
    const before = regionEditBefore || photoSnapshot(photo);
    photo.settings.skinRegion = { ...regionDraft };
    recordPhotoEdit(photo, before);
    setStatus("已设置皮肤区域");
  } else {
    apply = false;
  }
  editingRegion = false;
  regionEditBefore = null;
  pointerStart = null;
  regionDraft = null;
  const stack = byId("photo-stack");
  stack.classList.remove("selecting");
  stack.removeAttribute("tabindex");
  byId("choose-region").textContent = "框选皮肤区域";
  byId("region-instructions").hidden = true;
  byId("region-apply").hidden = true;
  updateRegionOverlay();
  syncControls();
  if (apply) schedulePreview();
}

function regionPoint(event) {
  const bounds = byId("photo-stack").getBoundingClientRect();
  const limit = (value) => Math.max(0, Math.min(1, value));
  return {
    x: limit((event.clientX - bounds.left) / bounds.width),
    y: limit((event.clientY - bounds.top) / bounds.height)
  };
}

function regionMove(event) {
  if (!pointerStart) return;
  const point = regionPoint(event);
  regionDraft = {
    x: Math.min(point.x, pointerStart.x),
    y: Math.min(point.y, pointerStart.y),
    width: Math.abs(point.x - pointerStart.x),
    height: Math.abs(point.y - pointerStart.y)
  };
  updateRegionOverlay();
}

function regionKey(event) {
  if (!editingRegion) return;
  if (event.key === "Escape" || event.key === "Enter") {
    event.preventDefault();
    finishRegion(event.key === "Enter");
    byId("choose-region").focus();
    return;
  }
  const directions = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] };
  const delta = directions[event.key];
  if (!delta || !regionDraft) return;
  event.preventDefault();
  const box = regionDraft;
  if (event.shiftKey) {
    box.width = Math.max(0.02, Math.min(1 - box.x, box.width + delta[0]));
    box.height = Math.max(0.02, Math.min(1 - box.y, box.height + delta[1]));
  } else {
    box.x = Math.max(0, Math.min(1 - box.width, box.x + delta[0]));
    box.y = Math.max(0, Math.min(1 - box.height, box.y + delta[1]));
  }
  updateRegionOverlay();
}

function setupPresets(panel, group, keys) {
  const section = document.createElement("div");
  section.className = "presets";
  section.innerHTML = '<div class="section-heading"><h3>我的预设</h3></div><label class="field">选择预设<select><option value="">选择预设</option></select></label><form class="preset-form"><label class="field">保存当前调整<input maxlength="40" required placeholder="输入预设名称"></label><button type="submit" class="button outline">保存预设</button></form>';
  panel.append(section);
  const picker = section.querySelector("select");
  const form = section.querySelector("form");
  const nameInput = form.querySelector("input");
  const refresh = () => {
    picker.replaceChildren(new Option("选择预设", ""));
    (preferences.presets[group] || []).forEach((preset, index) => picker.add(new Option(preset.name, String(index))));
  };
  picker.addEventListener("change", () => {
    const photo = currentPhoto();
    const preset = (preferences.presets[group] || [])[Number(picker.value)];
    if (!photo || picker.value === "" || !preset) return;
    runPhotoEdit(photo, (target) => {
      for (const key of keys) target.settings[key] = preset.values[key] ?? defaults[key];
      if (group === "landscape") {
        if (preset.values.curves) target.settings.curves = cloneData(preset.values.curves);
        else delete target.settings.curves;
      }
    });
    syncControls();
    schedulePreview();
    picker.value = "";
    setStatus("已应用预设 " + preset.name);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const photo = currentPhoto();
    const name = nameInput.value.trim();
    if (!photo || !name) {
      setStatus("请先选择照片并输入预设名称。", "error");
      return;
    }
    const saved = preferences.presets[group] || [];
    const values = Object.fromEntries(keys.map((key) => [key, photo.settings[key]]));
    if (group === "landscape" && photo.settings.curves) values.curves = structuredClone(photo.settings.curves);
    const preset = { name, values };
    preferences.presets[group] = [...saved.filter((entry) => entry.name !== name), preset];
    savePreferences();
    refresh();
    nameInput.value = "";
    setStatus("已保存预设 " + name);
  });
  refresh();
}

async function loadProjectList() {
  try {
    const response = await request("/api/projects");
    const { projects } = await response.json();
    const picker = byId("project-picker");
    picker.replaceChildren(new Option(projects.length ? "选择项目" : "暂无已保存的项目", ""));
    for (const item of projects) picker.add(new Option(item.name, item.name));
    byId("project-load").disabled = true;
  } catch (error) {
    setStatus("无法读取项目列表：" + error.message, "error");
  }
}

async function saveProject() {
  if (!currentPhoto() || projectSaveInFlight) return;
  const name = byId("project-name").value.trim();
  if (!name) {
    setStatus("请输入项目名称。", "error");
    byId("project-name").focus();
    return;
  }
  const state = cloneData({ photos, currentId, luts: preferences.luts, favorites: preferences.favorites });
  const submittedBaseline = dirtyProjectSnapshot(name, state.photos);
  projectSaveInFlight = true;
  byId("project-save").disabled = true;
  try {
    await post("/api/project", { name, state });
    savedProjectBaseline = submittedBaseline;
    byId("project-info").textContent = "已保存 " + name + "。";
    updateDirtyState();
    syncControls();
    setStatus("项目已保存到本机");
  } catch (error) {
    setStatus("保存项目失败：" + error.message, "error");
  } finally {
    projectSaveInFlight = false;
    syncControls();
  }
}

async function openProject() {
  await loadProjectList();
  byId("project-dialog").showModal();
}

async function restoreProject(event) {
  event.preventDefault();
  const name = byId("project-picker").value;
  if (!name) return;
  if (dirty && !window.confirm("当前修改还未保存。打开另一个项目？")) return;
  try {
    const response = await request("/api/project?name=" + encodeURIComponent(name));
    const project = await response.json();
    if (!Array.isArray(project.state?.photos) || typeof project.name !== "string") throw new Error("项目中的照片列表或名称无效。");
    const nextPhotos = project.state.photos.map((photo) => ({
      ...normalizePhotoCullingMetadata(photo),
      settings: { ...defaults, ...photo.settings, masks: Array.isArray(photo.settings?.masks) ? photo.settings.masks : [] }
    }));
    finishPhotoGestures(true);
    photos = nextPhotos;
    photoHistory?.resetAll(photos.map((photo) => [photo.id, photoSnapshot(photo)]));
    selectedMaskId = null;
    maskDrawType = null;
    for (const lut of project.state.luts || []) {
      if (!preferences.luts.some((entry) => entry.id === lut.id)) preferences.luts.push(lut);
    }
    photoFlagFilter = "all";
    photoMinimumRating = 0;
    syncPhotoFilterControls();
    preferences.favorites = [...new Set([...preferences.favorites, ...(project.state.favorites || [])])];
    savePreferences();
    byId("project-name").value = project.name;
    byId("project-info").textContent = "已打开 " + project.name + "。";
    savedProjectBaseline = dirtyProjectSnapshot(project.name, photos);
    updateDirtyState();
    byId("project-dialog").close();
    drawFilmstrip();
    await selectPhoto(photos.some((photo) => photo.id === project.state.currentId)
      ? project.state.currentId : (photos[0]?.id || null), true);
    setStatus("已打开项目 " + project.name);
  } catch (error) {
    setStatus("打开项目失败：" + error.message, "error");
  }
}

const formatNotes = {
  jpeg: "JPG，适合分享和交付。",
  tiff: "16 位 TIFF，适合工具间交接和后续精修。",
  psd: "PSD，保留原图和修图效果两个像素图层。"
};

function showExport() {
  if (!currentPhoto()) return;
  byId("export-error").hidden = true;
  byId("export-result").hidden = true;
  byId("export-submit").disabled = false;
  byId("format-note").textContent = formatNotes[byId("export-format").value];
  byId("export-dialog").showModal();
}

async function exportPhoto(event) {
  event.preventDefault();
  const photo = currentPhoto();
  if (!photo) return;
  const button = byId("export-submit");
  const errorBox = byId("export-error");
  const resultBox = byId("export-result");
  errorBox.hidden = true;
  resultBox.hidden = true;
  button.disabled = true;
  button.textContent = "正在导出";
  try {
    const response = await post("/api/export", { ...renderPayload(photo), format: byId("export-format").value });
    const { file } = await response.json();
    resultBox.textContent = "已保存到 " + file;
    resultBox.hidden = false;
    setStatus("已导出到 " + file);
  } catch (error) {
    errorBox.textContent = "导出失败：" + error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "导出照片";
  }
}

async function launchPatchy() {
  const photo = currentPhoto();
  if (!photo) return;
  byId("patchy-open").disabled = true;
  setStatus("正在准备 16 位 TIFF", "busy");
  try {
    const response = await post("/api/editor", renderPayload(photo));
    const { file } = await response.json();
    setStatus("已交给 Patchy：" + file);
  } catch (error) {
    setStatus("打开 Patchy 失败：" + error.message, "error");
  } finally {
    syncControls();
  }
}

function wireEvents() {
  const on = (id, event, handler) => byId(id).addEventListener(event, handler);
  syncPhotoFilterControls();
  syncPhotoCullingControls();
  for (const id of ["open-files", "empty-open", "film-add"]) on(id, "click", () => byId("file-input").click());
  on("open-folder", "click", () => byId("folder-input").click());
  on("import-lut", "click", () => byId("lut-input").click());
  on("file-input", "change", (event) => {
    importPhotos(event.target.files);
    event.target.value = "";
  });
  on("folder-input", "change", (event) => {
    importPhotos([...event.target.files].filter((file) => imageExtensions.test(file.name)));
    event.target.value = "";
  });
  on("lut-input", "change", (event) => {
    importLut(event.target.files[0]);
    event.target.value = "";
  });

  for (const [id, flag] of [["film-filter-all", "all"], ["film-filter-pick", "pick"], ["film-filter-reject", "reject"], ["film-filter-unflagged", "unflagged"]]) {
    on(id, "click", () => setPhotoFilter(flag, photoMinimumRating));
  }
  on("film-min-rating", "change", (event) => setPhotoFilter(photoFlagFilter, Number(event.target.value)));
  for (let rating = 1; rating <= 5; rating += 1) {
    on("photo-rating-" + rating, "click", () => setCurrentPhotoRating(rating));
  }
  on("photo-rating-clear", "click", () => setCurrentPhotoRating(0));
  on("photo-flag-pick", "click", () => setCurrentPhotoFlag("pick"));
  on("photo-flag-reject", "click", () => setCurrentPhotoFlag("reject"));
  on("photo-flag-clear", "click", () => setCurrentPhotoFlag(null));

  for (const button of selectAll("[data-tab]")) button.addEventListener("click", () => selectTab(button.dataset.tab));
  on("compare-toggle", "click", () => {
    comparing = !comparing;
    updateViewControls();
  });
  on("split", "input", (event) => setSplit(event.target.valueAsNumber));
  on("zoom-in", "click", () => updateZoom(actualZoom ? 1.25 : Math.min(4, zoom * 1.25)));
  on("zoom-out", "click", () => updateZoom(actualZoom ? 1 : Math.max(1, zoom / 1.25)));
  on("zoom-fit", "click", () => updateZoom(1));
  on("zoom-actual", "click", () => updateZoom(1, !actualZoom));
  const fitVisibleImage = () => { if (!byId("view").hidden) fitImage(); };
  new ResizeObserver(fitVisibleImage).observe(byId("canvas"));
  window.addEventListener("resize", fitVisibleImage);

  window.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey && !event.defaultPrevented && !isEditableShortcutTarget(event.target) && !document.querySelector("dialog[open]")) {
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        event.preventDefault();
        if (key === "y" || event.shiftKey) redoCurrentPhoto();
        else undoCurrentPhoto();
        return;
      }
    }
    const cullingAction = photoCullingShortcutAction(event, Boolean(document.querySelector("dialog[open]")));
    if (currentPhoto() && cullingAction) {
      event.preventDefault();
      if (cullingAction.type === "rating") setCurrentPhotoRating(cullingAction.value);
      else setCurrentPhotoFlag(cullingAction.value);
      return;
    }
    if (event.key === "Escape" && whiteBalanceActive) {
      event.preventDefault();
      setWhiteBalanceMode(false, true);
      setStatus("已取消白平衡取样。");
      return;
    }
    if (event.code !== "Space" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
        !originalUrl || byId("view").hidden || editingRegion || whiteBalanceActive || document.querySelector("dialog[open]") ||
        event.target.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
    event.preventDefault();
    if (peekingOriginal) return;
    peekingOriginal = true;
    updateViewControls();
  });
  const stopPeeking = () => {
    if (!peekingOriginal) return;
    peekingOriginal = false;
    updateViewControls();
  };
  window.addEventListener("keyup", (event) => { if (event.code === "Space") stopPeeking(); });
  window.addEventListener("blur", stopPeeking);
  on("image-edited", "load", () => { drawHistogram(); updateClippingOverlay(); });
  on("clipping-toggle", "click", () => {
    clippingEnabled = !clippingEnabled;
    updateClippingOverlay();
    setStatus(clippingEnabled ? "已显示剪切提示：红色为高光，蓝色为阴影；仅供查看，不影响导出。" : "已隐藏剪切提示。");
  });
  on("reset-photo", "click", () => {
    const photo = currentPhoto();
    if (!photo) return;
    setWhiteBalanceMode(false);
    runPhotoEdit(photo, (target) => {
      target.settings = { ...defaults, masks: [] };
      target.lutId = null;
    });
    selectedMaskId = null;
    maskDrawType = null;
    if (editingRegion) finishRegion(false);
    updateRegionOverlay();
    renderMaskList();
    drawLuts();
    syncControls();
    schedulePreview();
  });
  for (const [id, favorites] of [["filter-all", false], ["filter-favorites", true]]) {
    on(id, "click", () => { favoritesOnly = favorites; drawLuts(); });
  }

  const stack = byId("photo-stack");
  stack.addEventListener("pointerdown", sampleWhiteBalance, true);
  on("photo-stack", "pointerdown", (event) => {
    if (!editingRegion || event.button !== 0) return;
    event.preventDefault();
    regionStartDraft = regionDraft ? { ...regionDraft } : null;
    pointerStart = regionPoint(event);
    stack.setPointerCapture(event.pointerId);
  });
  on("photo-stack", "pointermove", regionMove);
  on("photo-stack", "pointerup", (event) => {
    if (!pointerStart) return;
    regionMove(event);
    pointerStart = null;
    regionStartDraft = null;
    if (regionDraft.width >= 0.02 && regionDraft.height >= 0.02) finishRegion(true);
  });
  on("photo-stack", "pointercancel", () => {
    pointerStart = null;
    regionDraft = regionStartDraft ? { ...regionStartDraft } : regionDraft;
    regionStartDraft = null;
    updateRegionOverlay();
  });
  on("photo-stack", "keydown", regionKey);
  on("region-apply", "click", () => finishRegion(true));

  const maskCanvas = byId("mask-overlay");
  maskCanvas.addEventListener("pointerdown", (event) => {
    if (tab !== "masks" || !currentPhoto() || event.button !== 0) return;
    const photo = currentPhoto();
    const handle = event.target.closest?.("[data-mask-handle]");
    if (handle) {
      beginPhotoGesture(maskCanvas, photo);
      selectedMaskId = handle.dataset.maskId;
      renderMaskList();
      syncMaskPanel();
      maskGesture = { id: selectedMaskId, handle: handle.dataset.maskHandle, pointerId: event.pointerId };
      event.preventDefault();
      maskCanvas.setPointerCapture(event.pointerId);
      return;
    }
    if (!maskDrawType || !event.target.closest?.(".mask-overlay")) return;
    const mask = selectedMask();
    if (!mask) return;
    beginPhotoGesture(maskCanvas, photo);
    const point = maskPoint(event);
    if (maskDrawType === "linear") mask.geometry = { start: { ...point }, end: { ...point } };
    else mask.geometry = { center: { ...point }, radius: { x: 0.01, y: 0.01 } };
    maskGesture = { id: mask.id, drawType: maskDrawType, start: point, pointerId: event.pointerId };
    event.preventDefault();
    maskCanvas.setPointerCapture(event.pointerId);
    updateMaskOverlay();
  });
  maskCanvas.addEventListener("pointermove", (event) => {
    if (!maskGesture || maskGesture.pointerId !== event.pointerId) return;
    updateMaskGesture(event);
  });
  maskCanvas.addEventListener("pointerup", (event) => {
    if (!maskGesture || maskGesture.pointerId !== event.pointerId) return;
    updateMaskGesture(event);
    const wasDrawing = Boolean(maskGesture.drawType);
    maskGesture = null;
    if (wasDrawing) maskDrawType = null;
    finishPhotoGesture(maskCanvas);
    syncWorkspaceTitle();
    syncMaskPanel();
    schedulePreview();
    setStatus("已更新蒙版");
  });
  maskCanvas.addEventListener("pointercancel", (event) => {
    if (!maskGesture || maskGesture.pointerId !== event.pointerId) return;
    const wasDrawing = Boolean(maskGesture.drawType);
    maskGesture = null;
    if (wasDrawing) maskDrawType = null;
    finishPhotoGesture(maskCanvas, true);
    syncWorkspaceTitle();
    syncMaskPanel();
    schedulePreview();
  });
  maskCanvas.addEventListener("lostpointercapture", () => {
    if (!maskGesture) return;
    const wasDrawing = Boolean(maskGesture.drawType);
    maskGesture = null;
    if (wasDrawing) maskDrawType = null;
    finishPhotoGesture(maskCanvas, true);
    syncMaskPanel();
    schedulePreview();
  });
  maskCanvas.addEventListener("keydown", (event) => {
    const handle = event.target.closest?.("[data-mask-handle]");
    if (!handle) return;
    const mask = currentMasks().find((entry) => entry.id === handle.dataset.maskId);
    const delta = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[event.key];
    if (!mask || !delta) return;
    const key = handle.dataset.maskHandle;
    if ((key === "radius-x" && delta[1]) || (key === "radius-y" && delta[0])) return;
    event.preventDefault();
    let point;
    if (mask.type === "linear") point = { ...mask.geometry[key] };
    else if (key === "center") point = { ...mask.geometry.center };
    else if (key === "radius-x") point = { x: mask.geometry.center.x + mask.geometry.radius.x, y: mask.geometry.center.y };
    else point = { x: mask.geometry.center.x, y: mask.geometry.center.y + mask.geometry.radius.y };
    const screenPoint = sourcePointToOutput(point);
    const sourcePoint = outputPointToSource({ x: screenPoint.x + delta[0], y: screenPoint.y + delta[1] });
    mutatePhoto(currentPhoto(), () => moveMaskHandle(mask, key, {
      x: Math.max(0, Math.min(1, sourcePoint.x)), y: Math.max(0, Math.min(1, sourcePoint.y))
    }));
    syncWorkspaceTitle();
    updateMaskOverlay();
    schedulePreview();
  });

  const cropCanvas = byId("composition-overlay");
  cropCanvas.addEventListener("pointerdown", (event) => {
    const photo = currentPhoto();
    if (tab !== "composition" || !photo || event.button !== 0) return;
    const handle = event.target.closest?.("[data-crop-handle]");
    const moveTarget = event.target.closest?.("[data-crop-move]");
    if (!handle && !moveTarget) return;
    event.preventDefault();
    const before = photo.settings.composition ? cloneData(photo.settings.composition) : null;
    beginPhotoGesture(cropCanvas, photo);
    const composition = photoComposition(photo);
    compositionGesture = {
      pointerId: event.pointerId,
      kind: handle ? "resize" : "move",
      handle: handle?.dataset.cropHandle || null,
      startPoint: compositionPointerPoint(event),
      startCrop: cropRect(composition),
      before
    };
    cropCanvas.setPointerCapture(event.pointerId);
  });
  cropCanvas.addEventListener("pointermove", updateCompositionGesture);
  cropCanvas.addEventListener("pointerup", (event) => {
    if (!compositionGesture || compositionGesture.pointerId !== event.pointerId) return;
    updateCompositionGesture(event);
    compositionGesture = null;
    finishPhotoGesture(cropCanvas);
    syncCompositionPanel();
    schedulePreview();
    setStatus("已更新裁剪范围");
  });
  cropCanvas.addEventListener("pointercancel", (event) => {
    if (!compositionGesture || compositionGesture.pointerId !== event.pointerId) return;
    finishPhotoGesture(cropCanvas, true);
    compositionGesture = null;
    syncCompositionPanel();
    fitCompositionStage();
  });
  cropCanvas.addEventListener("lostpointercapture", () => {
    if (!compositionGesture) return;
    compositionGesture = null;
    finishPhotoGesture(cropCanvas, true);
    syncCompositionPanel();
    fitCompositionStage();
  });
  cropCanvas.addEventListener("keydown", (event) => {
    const handle = event.target.closest?.("[data-crop-handle]");
    const photo = currentPhoto();
    if (!handle || !photo) return;
    const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!movement) return;
    event.preventDefault();
    const before = photoSnapshot(photo);
    const composition = ensureComposition(photo);
    const crop = cropRect(composition);
    const positions = {
      nw: { x: crop.x, y: crop.y },
      ne: { x: crop.x + crop.width, y: crop.y },
      se: { x: crop.x + crop.width, y: crop.y + crop.height },
      sw: { x: crop.x, y: crop.y + crop.height }
    };
    const screen = cropPointToScreen(positions[handle.dataset.cropHandle], composition);
    const step = (event.shiftKey ? 0.05 : 0.01);
    const next = screenPointToCrop({ x: screen.x + movement[0] * step, y: screen.y + movement[1] * step }, composition);
    composition.crop = resizeCropCorner(crop, handle.dataset.cropHandle, next, composition);
    recordPhotoEdit(photo, before);
    syncCompositionPanel();
    fitCompositionStage();
    schedulePreview();
    byId("composition-overlay").querySelector('.crop-handle[data-crop-handle="' + handle.dataset.cropHandle + '"]')?.focus();
  });

  window.addEventListener("blur", () => {
    finishPhotoGestures(true);
    if (maskGesture) {
      const wasDrawing = Boolean(maskGesture.drawType);
      maskGesture = null;
      if (wasDrawing) maskDrawType = null;
      syncMaskPanel();
    }
    if (compositionGesture) {
      compositionGesture = null;
      syncCompositionPanel();
      fitCompositionStage();
    }
    if (pointerStart) {
      pointerStart = null;
      regionDraft = regionStartDraft ? { ...regionStartDraft } : regionDraft;
      regionStartDraft = null;
      updateRegionOverlay();
    }
  });

  const drop = byId("drop-hint");
  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    drop.hidden = !byId("canvas").contains(event.target);
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !byId("canvas").contains(event.relatedTarget)) drop.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    drop.hidden = true;
    if (byId("canvas").contains(event.target)) importPhotos(event.dataTransfer.files);
  });

  on("project-name", "input", () => syncControls());
  on("undo-edit", "click", undoCurrentPhoto);
  on("redo-edit", "click", redoCurrentPhoto);
  on("project-save", "click", saveProject);
  on("project-open", "click", openProject);
  on("project-form", "submit", restoreProject);
  on("project-picker", "change", () => { byId("project-load").disabled = !byId("project-picker").value; });
  on("project-close", "click", () => byId("project-dialog").close());
  on("patchy-open", "click", launchPatchy);
  on("export-open", "click", showExport);
  for (const id of ["export-close", "export-cancel"]) on(id, "click", () => byId("export-dialog").close());
  on("export-format", "change", () => { byId("format-note").textContent = formatNotes[byId("export-format").value]; });
  on("export-form", "submit", exportPhoto);
  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function start() {
  const [saved, engines] = await Promise.allSettled([
    request("/api/preferences").then((response) => response.json()),
    request("/api/capabilities").then((response) => response.json())
  ]);
  if (saved.status === "fulfilled") Object.assign(preferences, loadPreferences(saved.value));
  preparePanels();
  setupPresets(byId("panel-landscape"), "landscape", colorKeys);
  setupPresets(byId("panel-portrait"), "portrait", ["blemishes", "smoothing", "skinTone", "texture"]);
  wireEvents();
  selectTab("landscape");
  drawLuts();
  if (engines.status === "fulfilled") {
    capability = engines.value;
    showCapabilities();
  }
  syncControls();
  const failure = [saved, engines].find((result) => result.status === "rejected");
  if (failure) setStatus("无法读取本机工作台状态：" + failure.reason.message, "error");
  else setStatus("本机工作台已就绪");
}

start();
