import { Engine, OUTPUTS } from './engine.js';
import { analyzeSpectrum, buildMask, TILE } from './mesh-filter.js';

const $ = (id) => document.getElementById(id);
const FADE_SEC = 0.2;
const CHUNK_BYTES = 96 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 워커 풀: 프레임마다 Y 평면을 여러 코어에 나눠 필터링
// ---------------------------------------------------------------------------
class Pool {
  constructor(size) {
    this.size = size;
    this.#spawn();
  }
  #spawn() {
    this.workers = Array.from({ length: this.size }, () => {
      const w = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => this.#done(w, e.data);
      w.onerror = (e) => this.#done(w, { id: w.jobId, ok: false, error: e.message || '워커 오류' });
      return w;
    });
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
  }
  #done(w, data) {
    const p = this.pending.get(data.id);
    this.pending.delete(data.id);
    w.busy = false;
    if (p) data.ok ? p.resolve(data) : p.reject(new Error(data.error));
    this.#pump();
  }
  #pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      w.busy = true;
      w.jobId = job.msg.id;
      w.postMessage(job.msg, job.transfer);
    }
  }
  run(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      msg.id = ++this.seq;
      this.pending.set(msg.id, { resolve, reject });
      this.queue.push({ msg, transfer });
      this.#pump();
    });
  }
  /** 모든 워커에 같은 메시지(마스크 갱신) */
  broadcast(msg) {
    return Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      const prev = w.onmessage;
      w.onmessage = (e) => {
        if (e.data.id === id) {
          w.onmessage = prev;
          this.pending.delete(id);
          e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
        } else prev(e);
      };
      w.postMessage({ ...msg, id });
    })));
  }
  reset() {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('취소됨'));
    this.#spawn();
  }
}

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
const engine = new Engine();
const pool = new Pool(Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)));
const state = {
  info: null,
  settings: { strength: 1, maxPeriod: 3.2, angleWidth: 22, diagonals: 'both' },
  detected: [],        // 분석에서 찾은 튀는 점들 {fx, fy, strength, on}
  custom: [],          // 사용자가 클릭으로 추가한 점
  spectrum: null,      // analyzeSpectrum 결과
  mask: null,
  ranges: null,        // null = 전체
  preview: { index: 0, raw: null, fixed: null },
  view: { zoom: 'fit', mode: 'split', split: 0.5, cx: 0, cy: 0 },
  running: false,
  resultURL: null,
};
if (new URLSearchParams(location.search).has('debug')) window.__mesh = { engine, pool, state };
const canvases = { orig: document.createElement('canvas'), fixed: document.createElement('canvas'), diff: document.createElement('canvas') };

let engineReady = (async () => {
  const pill = $('engineStatus');
  const label = pill.querySelector('.label');
  try {
    await engine.load((loaded, total) => {
      label.textContent = total ? `엔진 받는 중 ${Math.round((loaded / total) * 100)}%` : `엔진 받는 중 ${fmtBytes(loaded)}`;
    });
    pill.dataset.state = 'ready';
    label.textContent = '엔진 준비됨';
  } catch (err) {
    pill.dataset.state = 'error';
    label.textContent = '엔진 로딩 실패';
    throw err;
  }
})();
engineReady.catch(() => {});

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${u[i]}`;
}
function fmtTime(sec, precise = false) {
  if (!isFinite(sec)) return '-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return precise ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
function setFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function showError(err) {
  const box = $('errorBox');
  box.hidden = false;
  box.querySelector('p').textContent = typeof err === 'string' ? err : `${err.ffmpeg ? 'ffmpeg 오류\n' : ''}${err.message || err}`;
  console.error(err);
}
function clearError() { $('errorBox').hidden = true; }

/** 해당 프레임에 적용할 강도(0~1). 구간 밖은 0, 경계는 FADE_SEC에 걸쳐 부드럽게 */
function gainAt(index) {
  const s = state.settings.strength;
  if (!state.ranges) return s;
  const t = index / state.info.fps.value;
  let g = 0;
  for (const [a, b] of state.ranges) {
    if (t >= a && t <= b) return s;
    const d = t < a ? a - t : t - b;
    if (d < FADE_SEC) g = Math.max(g, 1 - d / FADE_SEC);
  }
  return g * s;
}

function parseRanges(text) {
  const parts = text.split(/[,\n]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('구간을 입력해 주세요. 예: 0-2, 6-9');
  const dur = state.info.duration || Infinity;
  const toSec = (s) => {
    s = s.trim();
    const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
    const v = m ? Number(m[1]) * 60 + Number(m[2]) : Number(s);
    if (!isFinite(v) || v < 0) throw new Error(`"${s}"은(는) 올바른 시간이 아니에요.`);
    return v;
  };
  return parts.map((p) => {
    const [a, b] = p.split(/\s*[-~]\s*/);
    if (b === undefined) throw new Error(`"${p}" → 시작-끝 형태로 적어 주세요.`);
    const s = toSec(a), e = Math.min(toSec(b), dur);
    if (e <= s) throw new Error(`"${p}" → 끝이 시작보다 뒤여야 해요.`);
    return [s, e];
  }).sort((x, y) => x[0] - y[0]);
}

// ---------------------------------------------------------------------------
// YUV → RGB (미리보기 전용. 저장 파일은 항상 원본 YUV 그대로 다룸)
// ---------------------------------------------------------------------------
function planeView(raw, byteOff, samples, bits) {
  if (bits <= 8) return raw.subarray(byteOff, byteOff + samples);
  const abs = raw.byteOffset + byteOff;
  if (abs % 2 === 0) return new Uint16Array(raw.buffer, abs, samples);
  return new Uint16Array(raw.slice(byteOff, byteOff + samples * 2).buffer);
}

function toImageData(raw, yPlane) {
  const { width: w, height: h, bits, layout, ySize, cSize, color } = state.info;
  const Y = yPlane || planeView(raw, 0, w * h, bits);
  const cwN = layout.gray ? 0 : Math.ceil(w / layout.cw);
  const chN = layout.gray ? 0 : Math.ceil(h / layout.ch);
  const U = layout.gray ? null : planeView(raw, ySize, cwN * chN, bits);
  const V = layout.gray ? null : planeView(raw, ySize + cSize, cwN * chN, bits);
  const sc = 1 << (bits - 8);
  const full = color.range === 'pc';
  const yOff = full ? 0 : 16 * sc, yDiv = full ? 255 * sc : 219 * sc;
  const cOff = 128 * sc, cDiv = full ? 255 * sc : 224 * sc;
  let kr = 0.299, kb = 0.114;
  if (color.space === 'bt709' || (!color.space && h >= 720)) { kr = 0.2126; kb = 0.0722; }
  else if (color.space && color.space.startsWith('bt2020')) { kr = 0.2627; kb = 0.0593; }
  const kg = 1 - kr - kb;
  const rv = 2 * (1 - kr), bu = 2 * (1 - kb), gu = -(bu * kb) / kg, gv = -(rv * kr) / kg;
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const crow = layout.gray ? 0 : Math.floor(y / layout.ch) * cwN;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const yy = (Y[i] - yOff) / yDiv;
      let u = 0, v = 0;
      if (U) {
        const ci = crow + Math.floor(x / layout.cw);
        u = (U[ci] - cOff) / cDiv;
        v = (V[ci] - cOff) / cDiv;
      }
      const o = i * 4;
      d[o] = (yy + rv * v) * 255;
      d[o + 1] = (yy + gu * u + gv * v) * 255;
      d[o + 2] = (yy + bu * u) * 255;
      d[o + 3] = 255;
    }
  }
  return img;
}

function diffImage(a, b) {
  const { width: w, height: h, bits } = state.info;
  const img = new ImageData(w, h);
  const d = img.data;
  const k = 8 / (1 << (bits - 8));
  for (let i = 0; i < a.length; i++) {
    const v = Math.min(255, Math.abs(a[i] - b[i]) * k);
    const o = i * 4;
    d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
  }
  return img;
}

function putCanvas(c, img) {
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// 파일 열기
// ---------------------------------------------------------------------------
const drop = $('drop');
const fileInput = $('fileInput');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files?.[0];
  if (f) openFile(f);
});
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) openFile(f); fileInput.value = ''; });
$('changeFile').addEventListener('click', () => { if (!state.running) fileInput.click(); });
// 작업 화면에서도 파일을 끌어다 놓으면 교체
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (state.running || drop.contains(e.target)) return;
  const f = e.dataTransfer.files?.[0];
  if (f) openFile(f);
});

async function openFile(file) {
  if (state.running) return;
  clearError();
  const busy = $('dropBusy');
  const inWorkspace = !$('workspace').hidden;
  if (!inWorkspace) { busy.hidden = false; drop.querySelector('.drop-inner').hidden = true; }
  $('dropBusyText').textContent = '엔진 준비 중';
  try {
    await engineReady;
    $('dropBusyText').textContent = '영상 정보를 읽는 중';
    const info = await engine.open(file);
    state.info = info;
    state.detected = []; state.custom = []; state.spectrum = null;
    resetResult();
    renderFileInfo();
    $('intro').hidden = true;
    $('workspace').hidden = false;
    setupScrub();
    sizeStage();
    await pushMask();
    const best = await analyze();
    await loadPreview(best);
    $('startBtn').disabled = false;
    updateEstimate();
  } catch (err) {
    if (!inWorkspace) { $('intro').hidden = false; $('workspace').hidden = true; }
    showError(err);
    if (!inWorkspace) {
      // 인트로 화면에서도 오류를 보여준다
      const note = drop.querySelector('.drop-note');
      note.textContent = `열 수 없어요: ${err.message || err}`;
      note.style.color = 'var(--status-negative)';
    }
  } finally {
    busy.hidden = true;
    drop.querySelector('.drop-inner').hidden = false;
  }
}

function renderFileInfo() {
  const i = state.info;
  $('fileName').textContent = i.name;
  const rows = [
    ['해상도', `${i.width}×${i.height}${i.rotation ? ` (회전 ${i.rotation}°)` : ''}`],
    ['프레임', `${(i.fps.value).toFixed(3).replace(/\.?0+$/, '')} fps · ${i.frames}장`],
    ['길이', fmtTime(i.duration, true)],
    ['크기', fmtBytes(i.size)],
    ['코덱', `${i.codec}${i.profile ? ` (${i.profile})` : ''}`],
    ['픽셀', `${i.srcPixFmt}${i.bits > 8 ? ` · ${i.bits}bit` : ''}`],
    ['오디오', i.audio.length ? i.audio.join(', ') + ' (원본 유지)' : '없음'],
    ['색공간', [i.color.space, i.color.range].filter(Boolean).join(' · ') || '미지정'],
  ];
  $('meta').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHTML(v)}</dd></div>`).join('');
  const notes = [];
  if (i.vfr) notes.push('가변 프레임레이트(VFR) 영상이에요. 결과는 고정 프레임레이트로 저장되어 타이밍이 미세하게 달라질 수 있어요.');
  if (i.converted) notes.push(`${i.srcPixFmt} 형식은 직접 다루지 못해 ${i.pixFmt}로 변환해 처리해요(아주 작은 변환 오차가 생길 수 있어요).`);
  if (i.bits > 8) notes.push(`${i.bits}bit 영상이라 무손실 MP4 대신 무손실 MKV(FFV1)로 저장해요.`);
  $('fileNotice').hidden = !notes.length;
  $('fileNotice').querySelector('p').textContent = notes.join(' ');
  // 저장 형식 가능 여부
  for (const input of document.querySelectorAll('input[name="output"]')) {
    const ok = i.bits <= OUTPUTS[input.value].maxBits;
    input.disabled = !ok;
    if (!ok && input.checked) document.querySelector('input[name="output"][value="ffv1"]').checked = true;
  }
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// 분석: 여러 프레임의 평균 주파수 지도에서 그물무늬를 찾는다
// ---------------------------------------------------------------------------
async function analyze() {
  const i = state.info;
  const badge = $('scoreBadge');
  badge.textContent = '분석 중';
  delete badge.dataset.level;
  drawSpectrum();
  let lo = 0, hi = i.frames - 1;
  if (state.ranges) {
    lo = Math.min(hi, Math.floor(state.ranges[0][0] * i.fps.value));
    hi = Math.min(hi, Math.floor(state.ranges[state.ranges.length - 1][1] * i.fps.value));
  }
  // 키프레임 바로 다음 프레임은 디코드가 싸다 → 가능하면 그 중에서 고르게 8장
  const cheap = engine.cheapStarts().filter((f) => f >= lo && f <= hi);
  const pickEven = (arr, n) => (arr.length <= n ? arr : Array.from({ length: n }, (_, k) => arr[Math.floor(((k + 0.5) * arr.length) / n)]));
  const idx = cheap.length >= 3
    ? pickEven(cheap, 8)
    : [...new Set(Array.from({ length: 5 }, (_, k) => Math.round(lo + ((hi - lo) * (k + 0.5)) / 5)))];
  const total = new Float64Array(TILE * TILE);
  let best = { index: idx[0], score: -1 };
  const addSample = async (f, planeBytes) => {
    const plane = planeBytes.buffer;
    const r = await pool.run({ type: 'spectrum', plane, width: i.width, height: i.height, bits: i.bits }, [plane]);
    const p = new Float64Array(r.power);
    for (let k = 0; k < p.length; k++) total[k] += p[k];
    const score = analyzeSpectrum(p, { maxPeriod: state.settings.maxPeriod }).meshScore;
    if (score > best.score) best = { index: f, score };
  };
  if (cheap.length >= 3) {
    for (const f of idx) {
      const { data, frames } = await engine.decode(f, 1);
      if (frames) await addSample(f, data.slice(0, i.ySize));
    }
  } else {
    // 키프레임이 드물면 seek마다 처음부터 디코드하게 되므로 한 번의 순차 디코드로 모두 뽑는다
    const { data, frames } = await engine.decodeSelect(idx);
    for (let j = 0; j < frames; j++) await addSample(idx[j], data.slice(j * i.frameBytes, j * i.frameBytes + i.ySize));
  }
  state.spectrum = analyzeSpectrum(total, { maxPeriod: state.settings.maxPeriod });
  const s = state.spectrum.meshScore;
  // 자동 노치: 대각선 근처에서 강하게 튀지만 쐐기 영역에 안 걸린 점만 기본으로 켠다
  const wedge = buildMask({ ...state.settings, peaks: [] });
  state.detected = state.spectrum.peaks.map((p) => {
    const kx = Math.round(p.fx * TILE + TILE) % TILE, ky = Math.round(p.fy * TILE + TILE) % TILE;
    let ang = (Math.atan2(p.fy, p.fx) * 180) / Math.PI;
    ang = ((ang % 180) + 180) % 180;
    const diag = Math.min(Math.abs(ang - 45), Math.abs(ang - 135)) < 25;
    return { ...p, on: diag && p.strength > 2.3 && wedge[ky * TILE + kx] < 0.5 };
  });
  if (s >= 3) { badge.textContent = `그물무늬 강함 · ${s.toFixed(1)}`; badge.dataset.level = 'high'; }
  else if (s >= 1.5) { badge.textContent = `그물무늬 약함 · ${s.toFixed(1)}`; badge.dataset.level = 'mid'; }
  else { badge.textContent = `거의 없음 · ${s.toFixed(1)}`; badge.dataset.level = 'low'; }
  badge.title = '대각선 고주파 에너지 ÷ 같은 거리의 다른 방향 에너지. 1 근처면 정상, 클수록 그물무늬가 뚜렷해요.';
  await pushMask();
  return best.index;
}

function currentPeaks() {
  return [...state.detected.filter((p) => p.on), ...state.custom].map((p) => ({ fx: p.fx, fy: p.fy, radius: 1.6 / TILE }));
}

// 쐐기(빨간 영역)에 이미 포함된 점은 따로 표시·토글할 필요가 없다
function visiblePeaks() {
  const w = state.wedge;
  return state.detected.filter((p) => {
    if (p.on || !w) return true;
    const kx = Math.round(p.fx * TILE + TILE) % TILE, ky = Math.round(p.fy * TILE + TILE) % TILE;
    return w[ky * TILE + kx] < 0.5;
  });
}

async function pushMask() {
  const params = { ...state.settings, peaks: currentPeaks() };
  state.mask = buildMask(params);
  state.wedge = buildMask({ ...state.settings, peaks: [] });
  await pool.broadcast({ type: 'mask', params });
  drawSpectrum();
}

function drawSpectrum() {
  const c = $('spectrum');
  const ctx = c.getContext('2d');
  const S = c.width / TILE;
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  const sp = state.spectrum;
  let lo = 0, hi = 1;
  if (sp) {
    const vals = Array.from(sp.logP).filter((_, k) => k !== 0).sort((a, b) => a - b);
    lo = vals[Math.floor(vals.length * 0.02)];
    hi = vals[Math.floor(vals.length * 0.998)];
  }
  const half = TILE / 2;
  for (let py = 0; py < c.height; py++) {
    const ky = (Math.floor(py / S) - half + TILE) % TILE;
    for (let px = 0; px < c.width; px++) {
      const kx = (Math.floor(px / S) - half + TILE) % TILE;
      const k = ky * TILE + kx;
      let g = sp ? Math.min(1, Math.max(0, (sp.logP[k] - lo) / (hi - lo))) : 0.08;
      g = Math.pow(g, 0.9) * 220 + 12;
      const m = state.mask ? state.mask[k] * 0.62 : 0;
      const o = (py * c.width + px) * 4;
      // WDS status.negative (#FF4242)
      d[o] = g * (1 - m) + 255 * m;
      d[o + 1] = g * (1 - m) + 66 * m;
      d[o + 2] = g * (1 - m) + 66 * m;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const toPx = (f) => (f * TILE + half) * S + S / 2;
  const ring = (p, on, color) => {
    for (const sgn of [1, -1]) {
      ctx.beginPath();
      ctx.arc(toPx(sgn * p.fx), toPx(sgn * p.fy), 7, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.setLineDash(on ? [] : [3, 3]);
      ctx.stroke();
    }
  };
  ctx.save();
  for (const p of visiblePeaks()) ring(p, p.on, p.on ? '#FF9200' : 'rgba(255,146,0,0.55)'); // status.cautionary
  for (const p of state.custom) ring(p, true, '#3385FF'); // primary (dark)
  ctx.restore();
}

$('spectrum').addEventListener('click', async (e) => {
  if (state.running || !state.info) return;
  const c = e.currentTarget;
  const rect = c.getBoundingClientRect();
  const S = c.width / TILE;
  const px = ((e.clientX - rect.left) / rect.width) * c.width;
  const py = ((e.clientY - rect.top) / rect.height) * c.height;
  const fx = (Math.floor(px / S) - TILE / 2) / TILE;
  const fy = (Math.floor(py / S) - TILE / 2) / TILE;
  if (Math.hypot(fx, fy) < 1 / 16) return; // 저주파(큰 모양)는 건드리지 않음
  const near = (p) => Math.min(Math.hypot(p.fx - fx, p.fy - fy), Math.hypot(p.fx + fx, p.fy + fy)) < 4 / TILE;
  const hitD = visiblePeaks().find(near);
  const hitC = state.custom.findIndex(near);
  if (hitD) hitD.on = !hitD.on;
  else if (hitC >= 0) state.custom.splice(hitC, 1);
  else state.custom.push({ fx, fy });
  await pushMask();
  refilterPreview();
});

// ---------------------------------------------------------------------------
// 미리보기 뷰어
// ---------------------------------------------------------------------------
const stage = $('stage');
const view = $('view');

function sizeStage() {
  const i = state.info;
  stage.style.aspectRatio = `${i.width} / ${i.height}`;
  stage.style.maxHeight = '72vh';
  state.view.cx = i.width / 2;
  state.view.cy = i.height / 2;
  render();
}
new ResizeObserver(() => render()).observe(stage);

function setupScrub() {
  const s = $('scrub');
  s.max = String(Math.max(0, state.info.frames - 1));
  s.value = '0';
  setFill(s);
  $('scrubTime').textContent = fmtTime(0, true);
}
const loadPreviewDebounced = debounce((f) => loadPreview(f), 260);
$('scrub').addEventListener('input', (e) => {
  setFill(e.target);
  const f = Number(e.target.value);
  $('scrubTime').textContent = fmtTime(f / state.info.fps.value, true);
  if (!state.running) loadPreviewDebounced(f);
});

let previewToken = 0;
async function loadPreview(index) {
  if (state.running) return;
  const token = ++previewToken;
  const i = state.info;
  $('stageLoading').hidden = false;
  try {
    const { data, frames } = await engine.decode(index, 1);
    if (token !== previewToken) return;
    if (!frames) throw new Error('이 위치의 프레임을 읽지 못했어요.');
    state.preview.index = index;
    state.preview.raw = data;
    const s = $('scrub');
    s.value = String(index); setFill(s);
    $('scrubTime').textContent = fmtTime(index / i.fps.value, true);
    putCanvas(canvases.orig, toImageData(data));
    await refilterPreview(token);
  } catch (err) {
    showError(err);
  } finally {
    if (token === previewToken) $('stageLoading').hidden = true;
  }
}

async function refilterPreview(token = previewToken) {
  const i = state.info;
  const raw = state.preview.raw;
  if (!raw) return;
  const gain = gainAt(state.preview.index);
  const orig = planeView(raw, 0, i.width * i.height, i.bits);
  let fixed;
  if (gain > 0) {
    const plane = orig.slice().buffer;
    const r = await pool.run({ type: 'filter', plane, width: i.width, height: i.height, bits: i.bits, gain }, [plane]);
    if (token !== previewToken) return;
    fixed = i.bits > 8 ? new Uint16Array(r.plane) : new Uint8Array(r.plane);
    $('labelRight').textContent = `보정 · 평균 ${(r.stats.meanAbs / (1 << (i.bits - 8))).toFixed(2)}단계 변화`;
  } else {
    fixed = orig;
    $('labelRight').textContent = '보정 안 함 (처리 구간 밖)';
  }
  state.preview.fixed = fixed;
  putCanvas(canvases.fixed, toImageData(raw, fixed));
  putCanvas(canvases.diff, diffImage(orig, fixed));
  render();
}

function viewScale() {
  const i = state.info;
  const r = stage.getBoundingClientRect();
  const fit = Math.min(r.width / i.width, r.height / i.height);
  return state.view.zoom === 'fit' ? fit : Math.max(fit, Number(state.view.zoom));
}

function clampCenter() {
  const i = state.info, v = state.view;
  const r = stage.getBoundingClientRect();
  const sc = viewScale();
  const hw = r.width / sc / 2, hh = r.height / sc / 2;
  v.cx = hw * 2 >= i.width ? i.width / 2 : Math.min(i.width - hw, Math.max(hw, v.cx));
  v.cy = hh * 2 >= i.height ? i.height / 2 : Math.min(i.height - hh, Math.max(hh, v.cy));
}

function render() {
  if (!state.info) return;
  const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (view.width !== W || view.height !== H) { view.width = W; view.height = H; }
  const ctx = view.getContext('2d');
  ctx.fillStyle = '#0F0F10';
  ctx.fillRect(0, 0, W, H);
  if (!canvases.orig.width) return;
  clampCenter();
  const v = state.view;
  const sc = viewScale() * dpr;
  const ox = W / 2 - v.cx * sc, oy = H / 2 - v.cy * sc;
  ctx.imageSmoothingEnabled = state.view.zoom === 'fit';
  ctx.imageSmoothingQuality = 'high';
  const draw = (c) => ctx.drawImage(c, ox, oy, state.info.width * sc, state.info.height * sc);
  const split = v.mode === 'split';
  if (v.mode === 'orig') draw(canvases.orig);
  else if (v.mode === 'fixed') draw(canvases.fixed);
  else if (v.mode === 'diff') draw(canvases.diff);
  else {
    draw(canvases.orig);
    ctx.save();
    ctx.beginPath();
    ctx.rect(W * v.split, 0, W, H);
    ctx.clip();
    draw(canvases.fixed);
    ctx.restore();
  }
  $('splitLine').hidden = !split;
  $('splitLine').style.left = `${v.split * 100}%`;
  $('labelLeft').hidden = v.mode === 'fixed';
  $('labelRight').hidden = v.mode === 'orig';
  $('labelLeft').textContent = v.mode === 'diff' ? '차이 ×8 (밝을수록 많이 바뀜)' : '원본';
  stage.classList.toggle('zoomed', v.zoom !== 'fit');
}

document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-zoom]').forEach((x) => x.classList.toggle('on', x === b));
  state.view.zoom = b.dataset.zoom;
  render();
}));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
  state.view.mode = b.dataset.view;
  render();
}));

// 드래그: 비교 경계 이동 / 확대 시 이동. 휠·핀치 없이도 조작 가능
let drag = null;
view.addEventListener('pointerdown', (e) => {
  if (!state.info) return;
  const r = stage.getBoundingClientRect();
  const nearSplit = state.view.mode === 'split' && Math.abs(e.clientX - r.left - state.view.split * r.width) < 22;
  const kind = state.view.zoom === 'fit' || nearSplit ? (state.view.mode === 'split' ? 'split' : null) : 'pan';
  if (!kind) return;
  drag = { kind, x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy };
  view.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
  if (kind === 'split') moveSplit(e);
});
view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'split') return moveSplit(e);
  const sc = viewScale();
  state.view.cx = drag.cx - (e.clientX - drag.x) / sc;
  state.view.cy = drag.cy - (e.clientY - drag.y) / sc;
  render();
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
function moveSplit(e) {
  const r = stage.getBoundingClientRect();
  state.view.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  render();
}
// 확대 상태에서 더블클릭한 곳을 중심으로
view.addEventListener('dblclick', (e) => {
  if (!state.info) return;
  const r = stage.getBoundingClientRect();
  const sc = viewScale();
  state.view.cx += (e.clientX - r.left - r.width / 2) / sc;
  state.view.cy += (e.clientY - r.top - r.height / 2) / sc;
  if (state.view.zoom === 'fit') document.querySelector('[data-zoom="5"]').click();
  else render();
});

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
const applySettings = debounce(async () => {
  await pushMask();
  refilterPreview();
}, 160);

function bindRange(id, outId, fmt, key, conv = Number) {
  const el = $(id);
  const upd = () => { setFill(el); $(outId).textContent = fmt(el.value); };
  upd();
  el.addEventListener('input', () => {
    upd();
    state.settings[key] = conv(el.value);
    if (state.info && !state.running) applySettings();
  });
}
bindRange('strength', 'strengthOut', (v) => `${v}%`, 'strength', (v) => Number(v) / 100);
bindRange('period', 'periodOut', (v) => `${Number(v).toFixed(1)}px 이하`, 'maxPeriod');
bindRange('angle', 'angleOut', (v) => `±${v}°`, 'angleWidth');

document.querySelectorAll('[data-diag]').forEach((b) => b.addEventListener('click', () => {
  if (state.running) return;
  document.querySelectorAll('[data-diag]').forEach((x) => x.classList.toggle('on', x === b));
  state.settings.diagonals = b.dataset.diag;
  if (state.info) applySettings();
}));

document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
  if (state.running) return;
  document.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b));
  const custom = b.dataset.range === 'custom';
  $('rangeField').hidden = !custom;
  if (!custom) { state.ranges = null; $('rangeError').hidden = true; $('ranges').removeAttribute('aria-invalid'); refreshAfterRanges(); }
  else { $('ranges').focus(); readRanges(); }
}));
$('ranges').addEventListener('input', debounce(() => readRanges(), 350));

function readRanges() {
  const input = $('ranges');
  if (!state.info) return;
  if (!input.value.trim()) { state.ranges = null; $('rangeError').hidden = true; input.removeAttribute('aria-invalid'); refreshAfterRanges(); return; }
  try {
    state.ranges = parseRanges(input.value);
    $('rangeError').hidden = true;
    input.removeAttribute('aria-invalid');
  } catch (err) {
    state.ranges = null;
    $('rangeError').hidden = false;
    $('rangeError').textContent = err.message;
    input.setAttribute('aria-invalid', 'true');
  }
  refreshAfterRanges();
}
function refreshAfterRanges() {
  updateEstimate();
  if (state.info && !state.running) refilterPreview();
}

document.querySelectorAll('input[name="output"]').forEach((r) => r.addEventListener('change', updateEstimate));
function selectedOutput() { return document.querySelector('input[name="output"]:checked').value; }

function updateEstimate() {
  const i = state.info;
  if (!i) return;
  const raw = i.frameBytes * i.frames;
  const mode = selectedOutput();
  const ratio = mode === 'lossless' ? 0.42 : mode === 'ffv1' ? 0.5 : 0;
  const est = ratio ? raw * ratio : (i.width * i.height * i.fps.value * 0.45 * i.duration) / 8;
  const filtered = state.ranges
    ? state.ranges.reduce((a, [s, e]) => a + (e - s), 0)
    : i.duration;
  let text = `예상 결과 크기 약 ${fmtBytes(est)} · 보정할 분량 ${filtered.toFixed(1)}초`;
  if (est > 1.6 * 1024 ** 3) text += ' — 브라우저 메모리 한도에 가까워요. 초고화질 MP4를 권장해요.';
  $('estimate').textContent = text;
}

// ---------------------------------------------------------------------------
// 실행: 디코드 → 필터 → 인코드를 겹쳐서(파이프라인) 처리
// ---------------------------------------------------------------------------
let abort = null;

async function filterChunk(raw, start, count, stats) {
  const i = state.info;
  const jobs = [];
  for (let f = 0; f < count; f++) {
    const gain = gainAt(start + f);
    if (gain <= 0) continue;
    const off = f * i.frameBytes;
    const plane = raw.slice(off, off + i.ySize).buffer;
    jobs.push(pool.run({ type: 'filter', plane, width: i.width, height: i.height, bits: i.bits, gain }, [plane]).then((r) => {
      raw.set(new Uint8Array(r.plane), off);
      stats.filtered++;
      stats.meanAbs += r.stats.meanAbs;
    }));
  }
  await Promise.all(jobs);
}

async function run() {
  if (state.running || !state.info) return;
  if (!$('rangeField').hidden && !state.ranges) { readRanges(); if (!state.ranges) return; }
  clearError();
  resetResult();
  const i = state.info;
  const mode = selectedOutput();
  state.running = true;
  abort = { aborted: false };
  const myAbort = abort;
  document.body.classList.add('is-running');
  $('actionBlock').hidden = true;
  $('progressBlock').hidden = false;
  setControlsDisabled(true);
  const N = Math.max(4, Math.min(240, Math.floor(CHUNK_BYTES / i.frameBytes)));
  const stats = { filtered: 0, meanAbs: 0 };
  const segments = [];
  let bytes = 0;
  const t0 = performance.now();
  const total = i.frames;
  const progress = (done, stage) => {
    const el = (performance.now() - t0) / 1000;
    const fps = done / el;
    const pct = Math.min(99, (done / total) * 96);
    $('stageText').textContent = stage;
    $('pctText').textContent = `${Math.floor(pct)}%`;
    $('barFill').style.width = `${pct}%`;
    $('frameText').textContent = `${Math.min(done, total)} / ${total}`;
    $('fpsText').textContent = done ? `${fps.toFixed(1)} fps` : '-';
    $('etaText').textContent = done ? fmtTime((total - done) / fps) : '-';
    $('sizeText').textContent = bytes ? fmtBytes(bytes) : '-';
  };
  const check = () => { if (myAbort.aborted) throw Object.assign(new Error('취소됨'), { name: 'AbortError' }); };

  try {
    // 디코더·인코더 ffmpeg 인스턴스를 여러 개 띄워 병렬 처리 (각각 별도 스레드)
    const cores = navigator.hardwareConcurrency || 4;
    const decN = cores >= 8 ? 2 : 1, encN = cores >= 8 ? 2 : 1;
    progress(0, '처리 엔진 준비 중');
    await engine.ensureLanes(decN, encN);
    check();
    const plan = engine.planChunks(N);
    if (!i.framesExact && plan.length) plan[plan.length - 1].count += Math.ceil(i.fps.value * 2);
    const slots = new Array(plan.length);
    let done = 0;
    const runChunk = async (c, j) => {
      const d = await engine.decode(c.start, c.count, 'dec');
      check();
      if (!d.frames) { slots[j] = { frames: 0, full: false }; return; }
      await filterChunk(d.data, c.start, d.frames, stats);
      check();
      const blob = await engine.encode(d.data, d.frames, mode);
      check();
      slots[j] = { blob, frames: d.frames, full: d.frames === c.count };
      done += d.frames;
      bytes += blob.size;
      progress(done, '그물무늬 지우고 다시 압축하는 중');
    };
    progress(0, '그물무늬 지우고 다시 압축하는 중');
    let next = 0;
    const limit = Math.min(plan.length, decN + encN + 1);
    await Promise.all(Array.from({ length: limit }, async () => {
      while (next < plan.length) {
        check();
        const j = next++;
        await runChunk(plan[j], j);
      }
    }));
    for (const s of slots) if (s && s.frames) segments.push(s);
    // 프레임 수가 추정치였고 마지막 구간이 꽉 찼다면 끝까지 이어서 처리
    let tail = segments.length ? segments.at(-1) : null;
    let start = done;
    while (!i.framesExact && tail && tail.full) {
      const d = await engine.decode(start, N, 'dec');
      check();
      if (!d.frames) break;
      await filterChunk(d.data, start, d.frames, stats);
      const blob = await engine.encode(d.data, d.frames, mode);
      check();
      tail = { blob, frames: d.frames, full: d.frames === N };
      segments.push(tail);
      start += d.frames; done = start; bytes += blob.size;
      progress(done, '그물무늬 지우고 다시 압축하는 중');
    }
    const frames = segments.reduce((a, s) => a + s.frames, 0);
    progress(frames, '오디오와 합치는 중');
    $('pctText').textContent = '97%';
    $('barFill').style.width = '97%';
    const out = await engine.mux(segments, mode, (s) => { $('stageText').textContent = s; });
    check();
    showResult(out, { frames, stats, mode, seconds: (performance.now() - t0) / 1000 });
  } catch (err) {
    if (err.name !== 'AbortError' && !myAbort.aborted) {
      showError(err);
      // 남은 병렬 작업을 모두 끊고 깨끗한 상태로
      myAbort.aborted = true;
      pool.reset();
      await engine.hardReset().catch(() => {});
      await pushMask().catch(() => {});
    }
    $('actionBlock').hidden = false;
  } finally {
    engine.releaseExtraLanes();
    state.running = false;
    document.body.classList.remove('is-running');
    $('progressBlock').hidden = true;
    setControlsDisabled(false);
  }
}

$('startBtn').addEventListener('click', run);
$('cancelBtn').addEventListener('click', async () => {
  if (!abort) return;
  abort.aborted = true;
  $('stageText').textContent = '취소하는 중';
  pool.reset();
  try {
    await engine.hardReset();
    await pushMask();
  } catch (err) { showError(err); }
});

function setControlsDisabled(dis) {
  for (const el of document.querySelectorAll('.panel input, .panel .seg button, #changeFile, #startBtn')) {
    if (el.name === 'output' && state.info && state.info.bits > OUTPUTS[el.value].maxBits) continue;
    el.disabled = dis;
  }
  $('scrub').disabled = dis;
}

function resetResult() {
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.resultURL = null;
  $('resultBlock').hidden = true;
  $('actionBlock').hidden = false;
}

function showResult({ blob, audioNote }, { frames, stats, mode, seconds }) {
  const i = state.info;
  const out = OUTPUTS[mode];
  state.resultURL = URL.createObjectURL(blob);
  const a = $('downloadLink');
  a.href = state.resultURL;
  a.download = `${i.name.replace(/\.[^.]+$/, '')}_그물제거.${out.ext}`;
  const avg = stats.filtered ? stats.meanAbs / stats.filtered / (1 << (i.bits - 8)) : 0;
  const rows = [
    ['형식', out.label],
    ['크기', fmtBytes(blob.size)],
    ['프레임', `${frames}장 중 ${stats.filtered}장 보정`],
    ['평균 변화', `${avg.toFixed(2)} / 255단계`],
    ['소요', fmtTime(seconds)],
    ['오디오', i.audio.length ? (audioNote ? '변환됨' : '원본 그대로') : '없음'],
  ];
  $('resultMeta').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHTML(v)}</dd></div>`).join('');
  const notes = [];
  if (frames !== i.frames && Math.abs(frames - i.frames) > 1) notes.push(`원본 정보상 ${i.frames}장이지만 실제로 ${frames}장을 읽었어요.`);
  if (audioNote) notes.push(audioNote);
  if (mode === 'lossless') notes.push('무손실 H.264(High 4:4:4 Predictive)는 QuickTime·아이폰·일부 브라우저에서 재생되지 않을 수 있어요. VLC, Premiere, DaVinci Resolve에서는 열려요.');
  $('resultNote').hidden = !notes.length;
  $('resultNote').querySelector('p').textContent = notes.join(' ');
  $('actionBlock').hidden = true;
  $('resultBlock').hidden = false;
  $('resultBlock').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('againBtn').addEventListener('click', resetResult);

window.addEventListener('beforeunload', (e) => {
  if (state.running) { e.preventDefault(); e.returnValue = ''; }
});
