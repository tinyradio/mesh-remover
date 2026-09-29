// 그물무늬 제거 핵심 알고리즘 (브라우저 워커 / Node 공용, 외부 의존성 없음)
//
// 원리: 그물무늬는 "정해진 각도(대각선 45°)·정해진 간격(2~3px)"의 주기 무늬라서
// 주파수 공간(FFT)에서 보면 네 모서리의 특정 영역에만 에너지가 몰려 있다.
// 영상을 겹치는 타일로 나눠 FFT → 해당 영역만 감쇠 → 역FFT → 겹쳐 합치기(WOLA).
// 진짜 나뭇잎·지푸라기처럼 온갖 방향/간격이 섞인 디테일은 거의 건드리지 않는다.

export const TILE = 128;
const HOP = TILE / 2;
const LOG2 = Math.log2(TILE);

// ---------- FFT (radix-2, in-place, complex) ----------
const bitrev = new Uint16Array(TILE);
for (let i = 0; i < TILE; i++) {
  let r = 0;
  for (let b = 0; b < LOG2; b++) r |= ((i >> b) & 1) << (LOG2 - 1 - b);
  bitrev[i] = r;
}
// 단계별 트위들 테이블을 연속 배열로 미리 계산 (인덱스 곱셈 제거)
const TW_RE = new Float32Array(TILE - 1);
const TW_IM = new Float32Array(TILE - 1);
{
  let o = 0;
  for (let size = 2; size <= TILE; size <<= 1) {
    for (let k = 0; k < size / 2; k++, o++) {
      TW_RE[o] = Math.cos((2 * Math.PI * k) / size);
      TW_IM[o] = Math.sin((2 * Math.PI * k) / size);
    }
  }
}

// 길이 TILE 벡터(stride 간격)에 대한 1D FFT. inverse면 켤레 방향(스케일링은 호출부에서)
function fft1d(re, im, off, stride, inverse) {
  const n = TILE;
  for (let i = 0; i < n; i++) {
    const j = bitrev[i];
    if (j > i) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  let tw = 0;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const hs = half * stride;
    for (let k = 0; k < half; k++) {
      const wr = TW_RE[tw + k];
      const wi = sgn * TW_IM[tw + k];
      for (let a = off + k * stride, end = off + n * stride; a < end; a += size * stride) {
        const b = a + hs;
        const br = re[b], bi = im[b];
        const xr = br * wr - bi * wi;
        const xi = br * wi + bi * wr;
        const ar = re[a], ai = im[a];
        re[b] = ar - xr; im[b] = ai - xi;
        re[a] = ar + xr; im[a] = ai + xi;
      }
    }
    tw += half;
  }
}

function fft2d(re, im, inverse) {
  for (let y = 0; y < TILE; y++) fft1d(re, im, y * TILE, 1, inverse);
  for (let x = 0; x < TILE; x++) fft1d(re, im, x, TILE, inverse);
}

// 마스크가 걸린 열(kx)만 세로 FFT를 한다. 나머지 열은 결과가 0이므로 계산 자체를 생략
function filterTile(re, im, gm, cols) {
  for (let y = 0; y < TILE; y++) fft1d(re, im, y * TILE, 1, false);
  for (let c = 0; c < cols.length; c++) {
    const x = cols[c];
    fft1d(re, im, x, TILE, false);
    for (let i = x; i < TILE * TILE; i += TILE) { re[i] *= gm[i]; im[i] *= gm[i]; }
    fft1d(re, im, x, TILE, true);
  }
  for (let x = 0, c = 0; x < TILE; x++) {
    if (c < cols.length && cols[c] === x) { c++; continue; }
    for (let i = x; i < TILE * TILE; i += TILE) { re[i] = 0; im[i] = 0; }
  }
  for (let y = 0; y < TILE; y++) fft1d(re, im, y * TILE, 1, true);
}

// 주기(periodic) Hann의 제곱근: 분석·합성 양쪽에 곱하면 Hann → 50% 겹침에서 합이 정확히 1
const win1d = new Float32Array(TILE);
for (let i = 0; i < TILE; i++) win1d[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / TILE));

// ---------- 마스크 ----------
// 주파수 인덱스 → cycles/pixel (-0.5 ~ 0.5)
const freqOf = (k) => (k < TILE / 2 ? k : k - TILE) / TILE;

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * 감쇠 마스크 M(fx,fy) ∈ [0,1] 생성 (1 = 완전히 제거). 켤레 대칭이라 실수 신호에 안전.
 * opts:
 *  - maxPeriod: 이 값(px)보다 촘촘한 무늬만 대상 (기본 3.2px)
 *  - angleWidth: 대각선 기준 ± 허용 각도(도)
 *  - diagonals: 'both' | 'rising' | 'falling'
 *  - feather: 경계 부드러움 (0~1)
 *  - peaks: [{fx, fy, radius}] 추가로 지울 점(주파수 cycles/px)
 */
export function buildMask(opts) {
  const {
    maxPeriod = 3.2,
    angleWidth = 22,
    diagonals = 'both',
    feather = 0.5,
    peaks = [],
    wedge = true,
  } = opts;
  const M = new Float32Array(TILE * TILE);
  const rMin = 1 / maxPeriod;
  const rFeather = Math.max(0.01, 0.06 * feather + 0.01);
  const aFeather = Math.max(1, angleWidth * feather);
  for (let ky = 0; ky < TILE; ky++) {
    const fy = freqOf(ky);
    for (let kx = 0; kx < TILE; kx++) {
      const fx = freqOf(kx);
      let m = 0;
      if (wedge) {
        const r = Math.hypot(fx, fy);
        if (r > rMin - rFeather) {
          // 화면 좌표(y 아래) 기준 각도. 45°/225° 축 = ↘ 방향 주파수, 135°/315° = ↗
          let ang = (Math.atan2(fy, fx) * 180) / Math.PI;
          ang = ((ang % 180) + 180) % 180; // 켤레 대칭 → 0~180
          let d = Infinity;
          if (diagonals !== 'rising') d = Math.min(d, Math.abs(ang - 45));
          if (diagonals !== 'falling') d = Math.min(d, Math.abs(ang - 135));
          const aw = smooth(angleWidth + aFeather, angleWidth, d);
          const rw = smooth(rMin - rFeather, rMin + rFeather * 0.5, r);
          m = aw * rw;
        }
      }
      for (const p of peaks) {
        const rad = p.radius || 1.5 / TILE;
        const s = 2 * rad * rad;
        const d1 = (fx - p.fx) ** 2 + (fy - p.fy) ** 2;
        const d2 = (fx + p.fx) ** 2 + (fy + p.fy) ** 2;
        const g = Math.max(Math.exp(-d1 / s), Math.exp(-d2 / s));
        m = 1 - (1 - m) * (1 - g);
      }
      M[ky * TILE + kx] = m < 1e-3 ? 0 : m; // 아주 작은 값은 0으로 → 계산 생략 가능한 열이 늘어남
    }
  }
  M[0] = 0; // 밝기 평균(DC)은 절대 건드리지 않음
  return M;
}

// ---------- 평면 필터 ----------
/**
 * 8/16bit 단일 평면(Y)에 필터 적용. src/dst: Uint8Array|Uint16Array, 같은 크기.
 * gain: 마스크에 곱할 강도(0~1). maxVal: 255 또는 1023 등.
 */
export function filterPlane(src, dst, width, height, mask, gain = 1, maxVal = 255) {
  const pad = HOP;
  const pw = Math.ceil((width + 2 * pad - TILE) / HOP) * HOP + TILE;
  const ph = Math.ceil((height + 2 * pad - TILE) / HOP) * HOP + TILE;
  // 반사 패딩 버퍼
  const buf = new Float32Array(pw * ph);
  const refl = (v, n) => {
    const period = 2 * n - 2 || 1;
    v = ((v % period) + period) % period;
    return v < n ? v : period - v;
  };
  const colMap = new Int32Array(pw);
  for (let x = 0; x < pw; x++) colMap[x] = refl(x - pad, width);
  for (let y = 0; y < ph; y++) {
    const sy = refl(y - pad, height) * width;
    const row = y * pw;
    for (let x = 0; x < pw; x++) buf[row + x] = src[sy + colMap[x]];
  }
  // 제거될 성분(패턴)만 누적
  const acc = new Float32Array(pw * ph);
  const re = new Float32Array(TILE * TILE);
  const im = new Float32Array(TILE * TILE);
  const gm = new Float32Array(TILE * TILE);
  const norm = 1 / (TILE * TILE);
  for (let i = 0; i < gm.length; i++) gm[i] = mask[i] * gain * norm;
  const colList = [];
  for (let x = 0; x < TILE; x++) {
    for (let y = 0; y < TILE; y++) if (gm[y * TILE + x] !== 0) { colList.push(x); break; }
  }
  const cols = Int32Array.from(colList);

  // 타일 위치 목록 → 두 개씩 묶어 복소수 하나로 (마스크가 실수·대칭이라 정확히 분리됨)
  const tiles = [];
  for (let ty = 0; ty + TILE <= ph; ty += HOP)
    for (let tx = 0; tx + TILE <= pw; tx += HOP) tiles.push(ty * pw + tx);

  for (let t = 0; t < tiles.length; t += 2) {
    const oa = tiles[t];
    const ob = t + 1 < tiles.length ? tiles[t + 1] : -1;
    for (let y = 0; y < TILE; y++) {
      const wy = win1d[y];
      const ra = oa + y * pw, rb = ob + y * pw, r = y * TILE;
      for (let x = 0; x < TILE; x++) {
        const w = wy * win1d[x];
        re[r + x] = buf[ra + x] * w;
        im[r + x] = ob >= 0 ? buf[rb + x] * w : 0;
      }
    }
    filterTile(re, im, gm, cols);
    for (let y = 0; y < TILE; y++) {
      const wy = win1d[y];
      const ra = oa + y * pw, rb = ob + y * pw, r = y * TILE;
      for (let x = 0; x < TILE; x++) {
        const w = wy * win1d[x];
        acc[ra + x] += re[r + x] * w;
        if (ob >= 0) acc[rb + x] += im[r + x] * w;
      }
    }
  }
  let changed = 0, sumAbs = 0;
  for (let y = 0; y < height; y++) {
    const row = (y + pad) * pw + pad;
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const s = src[o + x];
      let v = Math.round(s - acc[row + x]);
      v = v < 0 ? 0 : v > maxVal ? maxVal : v;
      dst[o + x] = v;
      if (v !== s) { changed++; sumAbs += Math.abs(v - s); }
    }
  }
  return { changed, meanAbs: sumAbs / (width * height) };
}

// ---------- 분석: 평균 파워 스펙트럼 ----------
/** 평면 하나의 평균 log 파워 스펙트럼(TILE×TILE, DC 원점) 누적 */
export function accumulateSpectrum(src, width, height, out, maxTiles = 160) {
  const re = new Float64Array(TILE * TILE);
  const im = new Float64Array(TILE * TILE);
  const nx = Math.floor((width - TILE) / HOP) + 1;
  const ny = Math.floor((height - TILE) / HOP) + 1;
  if (nx < 1 || ny < 1) return 0;
  const total = nx * ny;
  const step = Math.max(1, Math.floor(total / maxTiles));
  let count = 0;
  for (let t = 0; t < total; t += step) {
    const tx = (t % nx) * HOP, ty = Math.floor(t / nx) * HOP;
    let mean = 0;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) mean += src[(ty + y) * width + tx + x];
    mean /= TILE * TILE;
    for (let y = 0; y < TILE; y++) {
      const wy = win1d[y] * win1d[y];
      for (let x = 0; x < TILE; x++) {
        re[y * TILE + x] = (src[(ty + y) * width + tx + x] - mean) * wy * win1d[x] * win1d[x];
        im[y * TILE + x] = 0;
      }
    }
    fft2d(re, im, false);
    for (let i = 0; i < re.length; i++) out[i] += re[i] * re[i] + im[i] * im[i];
    count++;
  }
  return count;
}

/**
 * 누적 스펙트럼에서 그물무늬 강도와 뾰족한 피크를 찾는다.
 * 대각선 고주파 영역 에너지 / 같은 반경의 비대각선 에너지 비율 = meshScore (1 근처면 정상)
 */
export function analyzeSpectrum(power, opts = {}) {
  const { maxPeriod = 3.2 } = opts;
  const rMin = 1 / maxPeriod;
  const logP = new Float32Array(TILE * TILE);
  for (let i = 0; i < logP.length; i++) logP[i] = Math.log(power[i] + 1e-9);
  // 반경별 중앙값 → 배경 추정
  const bins = Math.ceil(TILE * 0.71) + 1;
  const buckets = Array.from({ length: bins }, () => []);
  for (let ky = 0; ky < TILE; ky++)
    for (let kx = 0; kx < TILE; kx++) {
      const r = Math.round(Math.hypot(freqOf(kx), freqOf(ky)) * TILE);
      buckets[r].push(logP[ky * TILE + kx]);
    }
  const med = buckets.map((b) => {
    if (!b.length) return 0;
    b.sort((a, c) => a - c);
    return b[b.length >> 1];
  });
  const resid = new Float32Array(TILE * TILE);
  let diagE = 0, diagN = 0, offE = 0, offN = 0;
  for (let ky = 0; ky < TILE; ky++)
    for (let kx = 0; kx < TILE; kx++) {
      const fx = freqOf(kx), fy = freqOf(ky);
      const rf = Math.hypot(fx, fy);
      const i = ky * TILE + kx;
      resid[i] = logP[i] - med[Math.round(rf * TILE)];
      if (rf >= rMin && rf <= 0.5) {
        let ang = (Math.atan2(fy, fx) * 180) / Math.PI;
        ang = ((ang % 180) + 180) % 180;
        const d = Math.min(Math.abs(ang - 45), Math.abs(ang - 135));
        if (d < 15) { diagE += power[i]; diagN++; }
        else if (d > 30) { offE += power[i]; offN++; }
      }
    }
  const meshScore = diagN && offN ? diagE / diagN / (offE / offN) : 1;
  // 피크: 고주파(주기 < 8px) 영역에서 주변보다 확 튀는 국소 최대값
  const peaks = [];
  for (let ky = 0; ky < TILE; ky++)
    for (let kx = 0; kx <= TILE / 2; kx++) {
      const fx = freqOf(kx), fy = freqOf(ky);
      if (Math.hypot(fx, fy) < 1 / 8) continue;
      if (kx === 0 && fy < 0) continue; // 켤레 중복 제거
      const v = resid[ky * TILE + kx];
      if (v < 1.6) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const j = ((ky + dy + TILE) % TILE) * TILE + ((kx + dx + TILE) % TILE);
          if (resid[j] > v) { isMax = false; break; }
        }
      if (isMax) peaks.push({ fx, fy, strength: v });
    }
  peaks.sort((a, b) => b.strength - a.strength);
  return { logP, resid, meshScore, peaks: peaks.slice(0, 8) };
}
