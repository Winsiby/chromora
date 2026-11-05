"use strict";

const byId = (id) => document.getElementById(id);
const selectAll = (selector) => [...document.querySelectorAll(selector)];
const svgIcon = (name) => '<svg aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const imageExtensions = /\.(jpeg|jpg|png|tif|tiff|3fr|arw|cr2|cr3|dng|erf|iiq|kdc|mef|mrw|nef|nrw|orf|pef|raf|raw|rw2|srw|x3f)$/i;
const tabs = {
  landscape: ["调色", "先调整原片，再应用风格，最后微调成片。"],
  portrait: ["人像调整", "把肤色与纹理调整限制在指定区域。"],
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
const inputPairs = new Map();
const originals = new Map();
const preferences = { luts: [], favorites: [], presets: {} };
let pendingPreferences = Promise.resolve();
let photos = [];
let currentId = null;
let tab = "landscape";
let capability = null;
let dirty = false;
let comparing = true;
let split = 50;
let zoom = 1;
let aspect = 1;
let peekingOriginal = false;
let actualZoom = false;
let fullOriginal;
let favoritesOnly = false;
let editingRegion = false;
let regionDraft = null;
let pointerStart = null;
let photoSequence = 0;
let renderSequence = 0;
let renderTimer;
let fullRenderTimer;
let previewController;
let originalUrl;
let editedUrl;
let loadingFiles = false;

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
    slider.addEventListener("input", () => setControl(key, slider.valueAsNumber));
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

function setControl(key, value) {
  const photo = currentPhoto();
  if (!photo) return;
  const [, min, max, step] = controls[key];
  const rounded = Number((Math.round(value / step) * step).toFixed(2));
  photo.settings[key] = Math.max(min, Math.min(max, rounded));
  dirty = true;
  syncControls();
  schedulePreview();
}

function syncControls() {
  const photo = currentPhoto();
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

  byId("reset-photo").disabled = !photo;
  byId("project-save").disabled = !photo;
  byId("patchy-open").disabled = !photo || !capability?.patchy;
  byId("choose-region").disabled = !photo;
  byId("clear-region").disabled = !photo?.settings.skinRegion;
  byId("region-caption").textContent = capability?.portrait === "rapidretouch"
    ? "可使用外部人像引擎。也可手动框选指定区域。"
    : "先框选皮肤区域，再调整下方滑杆。建议避开眼睛、嘴唇和头发。";
  byId("workspace-title").textContent = photo ? byId("project-name").value + (dirty ? " •" : "") : "未打开照片";
  byId("landscape-lut-name").textContent = preferences.luts.find((lut) => lut.id === photo?.lutId)?.name || "未应用滤镜";
  byId("export-open").disabled = !photo;
  if (byId("curve-section").open) drawCurve();
  updateViewControls();
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
  const curves = { ...photo.settings.curves };
  if (points) curves[curveChannel] = points;
  else delete curves[curveChannel];
  if (Object.keys(curves).length) photo.settings.curves = curves;
  else delete photo.settings.curves;
  dirty = true;
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
    if (!currentPhoto() || event.button !== 0) return;
    const handle = event.target.dataset.curveIndex;
    if (handle !== undefined) {
      curvePoint = Number(handle);
      drawCurve();
    } else if (!addCurvePoint(...coordinate(event))) {
      return;
    }
    event.preventDefault();
    pointer = event.pointerId;
    graph.setPointerCapture(pointer);
  });
  graph.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointer && currentPhoto()) moveCurvePoint(...coordinate(event));
  });
  graph.addEventListener("lostpointercapture", () => { pointer = null; });
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

function preparePanels() {
  const landscape = byId("panel-landscape");
  const histogram = document.createElement("div");
  histogram.className = "histogram";
  histogram.innerHTML = '<span>RGB 直方图</span><canvas id="histogram" width="270" height="77" aria-label="当前效果的 RGB 直方图"></canvas>';
  landscape.append(histogram);
  controlGroup(editorSection(landscape, "base-section", "基础调色", true), "", baseKeys);
  prepareCurve(editorSection(landscape, "curve-section", "曲线"));
  bandControls(editorSection(landscape, "mixer-section", "色彩混合"), "hsl", hslBands, hslAdjustments);
  const grading = editorSection(landscape, "grade-section", "色彩分级");
  bandControls(grading, "grade", gradeBands, gradeAdjustments);
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
    delete photo.settings.skinRegion;
    finishRegion(false);
    dirty = true;
    syncControls();
    schedulePreview();
  });
  controlGroup(byId("style-sliders"), "应用强度", ["lutStrength"]);
  controlGroup(byId("style-sliders"), "成片微调", postKeys, "-styles");
}

function selectTab(next) {
  if (!tabs[next]) return;
  if (editingRegion) finishRegion(false);
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

function drawFilmstrip() {
  const container = byId("film-items");
  const previousScroll = container.scrollLeft;
  container.replaceChildren(...photos.map((photo) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "film-item";
    button.title = photo.name;
    button.setAttribute("aria-pressed", String(photo.id === currentId));
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.src = "/api/thumb?id=" + encodeURIComponent(photo.id);
    const name = document.createElement("span");
    name.textContent = photo.name;
    button.append(image, name);
    button.addEventListener("click", () => selectPhoto(photo.id));
    return button;
  }));
  container.scrollLeft = previousScroll;
  byId("photo-count").textContent = photos.length + " 张";
}

function updateFilmSelection() {
  const index = photos.findIndex((photo) => photo.id === currentId);
  [...byId("film-items").children].forEach((button, buttonIndex) => {
    button.setAttribute("aria-pressed", String(index === buttonIndex));
    if (index === buttonIndex) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
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
          photos.push({ id: info.id, name: info.name || file.name, raw: Boolean(info.raw), settings: { ...defaults }, lutId: null });
        }
        imported.push(info.id);
      } catch (error) {
        failures.push(file.name + "：" + error.message);
      }
    }
    if (imported.length) {
      dirty = true;
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
  const peek = ready && peekingOriginal && !editingRegion;
  byId("compare-toggle").disabled = !ready;
  byId("compare-toggle").setAttribute("aria-pressed", String(comparing));
  byId("compare-ui").hidden = !comparing || editingRegion || peek;
  const stack = byId("photo-stack");
  stack.classList.toggle("solo", !comparing || editingRegion);
  stack.classList.toggle("peek-original", peek);
  byId("peek-label").hidden = !peek;
  byId("zoom-in").disabled = !ready || (!actualZoom && zoom >= 4);
  byId("zoom-out").disabled = !ready || (!actualZoom && zoom <= 1);
  byId("zoom-fit").disabled = !ready || (!actualZoom && zoom === 1);
  byId("zoom-actual").disabled = !ready;
  byId("zoom-actual").setAttribute("aria-pressed", String(actualZoom));
  byId("zoom-label").textContent = actualZoom && fullOriginal
    ? "实际像素"
    : (zoom === 1 ? "适合窗口" : "适合 ×" + Math.round(zoom * 100) / 100);
}

function fitImage() {
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

function renderBlob(photo, settings, lutId, signal, resolution = "preview") {
  return post("/api/render", { id: photo.id, settings, lutId, resolution }, signal).then((response) => response.blob());
}

function hasAdjustments(photo) {
  return Boolean(photo.lutId) || Boolean(Object.keys(photo.settings.curves || {}).length) || Object.entries(defaults).some(([key, value]) => key !== "lutStrength" && (photo.settings[key] ?? value) !== value);
}

function renderStatus(label) {
  byId("render-chip").textContent = label;
  byId("render-chip").hidden = !label;
}

function updateZoom(next, actual = false) {
  if (!actualZoom && !actual && zoom === next) return;
  const changingQuality = actual !== actualZoom;
  actualZoom = actual;
  zoom = next;
  if (!actual) byId("image-original").src = originalUrl;
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
  clearTimeout(renderTimer);
  clearTimeout(fullRenderTimer);
  previewController?.abort();
  if (editingRegion) finishRegion(false);
  currentId = id;
  zoom = 1;
  actualZoom = false;
  peekingOriginal = false;
  byId("view").classList.remove("actual-size", "scrollable");
  setSplit(50);
  const sequence = ++photoSequence;
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (editedUrl) URL.revokeObjectURL(editedUrl);
  if (fullOriginal) URL.revokeObjectURL(fullOriginal.url);
  fullOriginal = undefined;
  originalUrl = undefined;
  editedUrl = undefined;
  byId("view").hidden = true;
  const photo = currentPhoto();
  byId("canvas-name").textContent = photo?.name || "照片预览";
  byId("empty").hidden = Boolean(photo);
  byId("footer-meta").textContent = photo?.raw ? "RAW 照片 / 本机处理" : "仅在本机处理";
  updateFilmSelection();
  drawLuts();
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
    aspect = original.naturalWidth / original.naturalHeight;
    byId("view").hidden = false;
    fitImage();
    drawHistogram();
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
  byId("image-edited").src = nextUrl;
}

async function renderFull(photo, controller, current) {
  if (!current() || !actualZoom) return;
  renderStatus("正在读取实际像素");
  let candidateUrl;
  try {
    if (!fullOriginal) {
      const blob = await renderBlob(photo, {}, null, controller.signal, "full");
      if (!current() || !actualZoom) return;
      const image = new Image();
      candidateUrl = URL.createObjectURL(blob);
      image.src = candidateUrl;
      await waitForImage(image);
      if (!current() || !actualZoom) return;
      fullOriginal = { url: candidateUrl, width: image.naturalWidth, height: image.naturalHeight };
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
  photo.lutId = id;
  dirty = true;
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
    photo.settings.skinRegion = { ...regionDraft };
    dirty = true;
    setStatus("已设置皮肤区域");
  } else {
    apply = false;
  }
  editingRegion = false;
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
    for (const key of keys) photo.settings[key] = preset.values[key] ?? defaults[key];
    if (group === "landscape") {
      if (preset.values.curves) photo.settings.curves = structuredClone(preset.values.curves);
      else delete photo.settings.curves;
    }
    dirty = true;
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
  if (!currentPhoto()) return;
  const name = byId("project-name").value.trim();
  if (!name) {
    setStatus("请输入项目名称。", "error");
    byId("project-name").focus();
    return;
  }
  const state = { photos, currentId, luts: preferences.luts, favorites: preferences.favorites };
  try {
    await post("/api/project", { name, state });
    dirty = false;
    byId("project-info").textContent = "已保存 " + name + "。";
    syncControls();
    setStatus("项目已保存到本机");
  } catch (error) {
    setStatus("保存项目失败：" + error.message, "error");
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
    if (!Array.isArray(project.state?.photos)) throw new Error("项目中的照片列表无效。");
    photos = project.state.photos.map((photo) => ({ ...photo, settings: { ...defaults, ...photo.settings } }));
    for (const lut of project.state.luts || []) {
      if (!preferences.luts.some((entry) => entry.id === lut.id)) preferences.luts.push(lut);
    }
    preferences.favorites = [...new Set([...preferences.favorites, ...(project.state.favorites || [])])];
    savePreferences();
    byId("project-name").value = project.name;
    byId("project-info").textContent = "已打开 " + project.name + "。";
    dirty = false;
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
    if (event.code !== "Space" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
        !originalUrl || byId("view").hidden || editingRegion || document.querySelector("dialog[open]") ||
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
  on("image-edited", "load", drawHistogram);
  on("reset-photo", "click", () => {
    const photo = currentPhoto();
    if (!photo) return;
    photo.settings = { ...defaults };
    photo.lutId = null;
    dirty = true;
    if (editingRegion) finishRegion(false);
    updateRegionOverlay();
    drawLuts();
    syncControls();
    schedulePreview();
  });
  for (const [id, favorites] of [["filter-all", false], ["filter-favorites", true]]) {
    on(id, "click", () => { favoritesOnly = favorites; drawLuts(); });
  }

  const stack = byId("photo-stack");
  on("photo-stack", "pointerdown", (event) => {
    if (!editingRegion || event.button !== 0) return;
    event.preventDefault();
    pointerStart = regionPoint(event);
    stack.setPointerCapture(event.pointerId);
  });
  on("photo-stack", "pointermove", regionMove);
  on("photo-stack", "pointerup", (event) => {
    if (!pointerStart) return;
    regionMove(event);
    pointerStart = null;
    if (regionDraft.width >= 0.02 && regionDraft.height >= 0.02) finishRegion(true);
  });
  on("photo-stack", "pointercancel", () => { pointerStart = null; });
  on("photo-stack", "keydown", regionKey);
  on("region-apply", "click", () => finishRegion(true));

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

  on("project-name", "input", () => { if (currentPhoto()) dirty = true; syncControls(); });
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
