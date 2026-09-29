// ffmpeg.wasm 래퍼: 분석(probe) → 구간별 디코드(원본 픽셀 그대로) → 필터 → 무손실 인코드 → 이어붙이기
// 모든 작업은 이 탭의 메모리 안에서만 일어난다. 파일은 WORKERFS로 "마운트"만 하고 복사·전송하지 않는다.
import { FFmpeg } from '../vendor/ffmpeg/index.js';

const PIX = {
  yuv420p: { cw: 2, ch: 2, bits: 8 },
  yuvj420p: { cw: 2, ch: 2, bits: 8, full: true },
  yuv422p: { cw: 2, ch: 1, bits: 8 },
  yuvj422p: { cw: 2, ch: 1, bits: 8, full: true },
  yuv444p: { cw: 1, ch: 1, bits: 8 },
  yuvj444p: { cw: 1, ch: 1, bits: 8, full: true },
  yuv420p10le: { cw: 2, ch: 2, bits: 10 },
  yuv422p10le: { cw: 2, ch: 1, bits: 10 },
  yuv444p10le: { cw: 1, ch: 1, bits: 10 },
  yuv420p12le: { cw: 2, ch: 2, bits: 12 },
  yuv422p12le: { cw: 2, ch: 1, bits: 12 },
  yuv444p12le: { cw: 1, ch: 1, bits: 12 },
  gray: { gray: true, bits: 8 },
  gray10le: { gray: true, bits: 10 },
};

const KNOWN_COLOR = {
  range: ['tv', 'pc'],
  space: ['bt709', 'bt470bg', 'smpte170m', 'bt2020nc', 'bt2020c', 'smpte240m', 'fcc', 'ycgco'],
  primaries: ['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020', 'smpte431', 'smpte432', 'film'],
  transfer: ['bt709', 'gamma22', 'gamma28', 'smpte170m', 'smpte240m', 'linear', 'iec61966-2-1', 'bt2020-10', 'bt2020-12', 'smpte2084', 'arib-std-b67'],
};

export const OUTPUTS = {
  lossless: { label: '무손실 MP4 (H.264 lossless)', ext: 'mp4', seg: 'nut', maxBits: 8 },
  ffv1: { label: '무손실 MKV (FFV1)', ext: 'mkv', seg: 'nut', maxBits: 16 },
  hq: { label: '초고화질 MP4 (CRF 12)', ext: 'mp4', seg: 'nut', maxBits: 16 },
};

const parseRate = (s) => {
  if (!s) return null;
  const [n, d = '1'] = String(s).split('/');
  const num = Number(n), den = Number(d);
  if (!num || !den) return null;
  return { num, den, value: num / den, str: `${num}/${den}` };
};

async function fetchToBlobURL(url, type, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`엔진 파일을 불러오지 못했어요 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return URL.createObjectURL(new Blob(chunks, { type }));
}

/** ffmpeg 인스턴스 하나(= 워커 스레드 하나). 명령은 레인마다 순서대로 실행된다 */
class Lane {
  constructor(ff) {
    this.ff = ff;
    this.logs = [];
    this.queue = Promise.resolve();
    this.pending = 0;
    this.mounted = new Set();
    ff.on('log', ({ message }) => {
      this.logs.push(message);
      if (this.logs.length > 200) this.logs.shift();
    });
  }
  run(fn) {
    this.pending++;
    const p = this.queue.then(() => fn(this));
    this.queue = p.catch(() => {});
    return p.finally(() => { this.pending--; });
  }
  async exec(args) {
    this.logs.length = 0;
    const code = await this.ff.exec(args);
    if (code !== 0) {
      const tail = this.logs.filter((l) => !/^\s*(frame=|size=|Aborted\(\))/.test(l)).slice(-6).join('\n');
      const err = new Error(tail || `ffmpeg 오류 (코드 ${code})`);
      err.ffmpeg = true;
      throw err;
    }
  }
  async mountBlobs(dir, blobs) {
    if (this.mounted.has(dir)) {
      await this.ff.unmount(dir);
      await this.ff.deleteDir(dir);
      this.mounted.delete(dir);
    }
    await this.ff.createDir(dir);
    await this.ff.mount('WORKERFS', { blobs }, dir);
    this.mounted.add(dir);
  }
  terminate() { try { this.ff.terminate(); } catch {} }
}

export class Engine {
  constructor() {
    this.urls = null;
    this.lanes = [];      // lanes[0]: 미리보기·분석·합치기 담당
    this.decLanes = [];
    this.encLanes = [];
  }

  async load(onProgress) {
    // 단일 스레드 코어를 여러 인스턴스(레인)로 띄워 병렬 처리한다.
    // (core-mt는 exec 사이에 간헐적으로 교착되는 문제가 있어 쓰지 않음)
    if (!this.urls) {
      const base = new URL('../vendor/core/', import.meta.url).href;
      this.urls = {
        coreURL: base + 'ffmpeg-core.js',
        wasmURL: await fetchToBlobURL(base + 'ffmpeg-core.wasm', 'application/wasm', onProgress),
      };
    }
    this.lanes = [await this.#spawnLane()];
  }

  get main() { return this.lanes[0]; }

  async #spawnLane() {
    const ff = new FFmpeg();
    await ff.load(this.urls);
    await ff.createDir('/work');
    const lane = new Lane(ff);
    if (this.file) await this.#mountInput(lane);
    return lane;
  }

  async #mountInput(lane) {
    await lane.mountBlobs('/in', [{ name: this.inPath.slice(4), data: this.file }]);
  }

  /** 병렬 처리용 레인 확보: 디코더 dec개, 인코더 enc개 (lanes[0]은 디코더로 겸용) */
  async ensureLanes(dec, enc) {
    const need = dec + enc;
    while (this.lanes.length < need) this.lanes.push(await this.#spawnLane());
    this.decLanes = this.lanes.slice(0, dec);
    this.encLanes = this.lanes.slice(dec, need);
  }

  /** 진행 중인 작업을 즉시 중단(모든 ffmpeg 워커 종료)하고 기본 레인만 다시 준비한다 */
  async hardReset() {
    for (const l of this.lanes) l.terminate();
    this.lanes = [];
    this.decLanes = [];
    this.encLanes = [];
    this.lanes = [await this.#spawnLane()];
  }

  /** 여분 레인 정리(메모리 반환) */
  releaseExtraLanes() {
    for (const l of this.lanes.slice(1)) l.terminate();
    this.lanes = this.lanes.slice(0, 1);
    this.decLanes = [];
    this.encLanes = [];
  }

  #pick(list) {
    const pool = list.length ? list : [this.main];
    return pool.reduce((a, b) => (b.pending < a.pending ? b : a));
  }

  /** 파일을 마운트하고 스트림 정보를 읽는다 */
  async open(file) {
    this.releaseExtraLanes();
    this.file = file;
    const ext = (file.name.match(/\.[a-z0-9]{1,5}$/i) || ['.mp4'])[0].toLowerCase();
    this.inPath = `/in/input${ext}`;
    await this.main.run((l) => this.#mountInput(l));
    // ffmpeg.wasm의 ffprobe는 실행 후 모듈을 Abort 상태로 만들어 이후 exec가 멈춘다.
    // 그래서 일회용 인스턴스에서 probe만 하고 바로 폐기한다.
    const probeFF = new FFmpeg();
    let probe;
    try {
      await probeFF.load(this.urls);
      await probeFF.createDir('/in');
      await probeFF.mount('WORKERFS', { blobs: [{ name: this.inPath.slice(4), data: file }] }, '/in');
      await probeFF.ffprobe([
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
        '-show_entries', 'packet=stream_index,pts_time,flags', this.inPath, '-o', '/probe.json',
      ]);
      probe = JSON.parse(await probeFF.readFile('/probe.json', 'utf8'));
    } catch {
      throw new Error('영상 정보를 읽지 못했어요. 지원하지 않는 형식일 수 있어요.');
    } finally {
      probeFF.terminate();
    }
    const v = (probe.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!v) throw new Error('영상 트랙을 찾지 못했어요.');
    const fmt = probe.format || {};
    const r = parseRate(v.r_frame_rate);
    const avg = parseRate(v.avg_frame_rate);
    let fps = r && r.value <= 240 ? r : avg;
    if (!fps || fps.value > 240) fps = avg && avg.value <= 240 ? avg : { num: 30, den: 1, value: 30, str: '30/1' };
    const vfr = r && avg && Math.abs(r.value - avg.value) / r.value > 0.01;

    let rotation = 0;
    const sd = (v.side_data_list || []).find((d) => d.rotation != null);
    if (sd) rotation = Number(sd.rotation) || 0;
    else if (v.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
    const swap = Math.abs(rotation) % 180 === 90;
    const width = swap ? v.height : v.width;
    const height = swap ? v.width : v.height;

    let pixFmt = v.pix_fmt;
    let converted = false;
    if (!PIX[pixFmt]) {
      const deep = Number(v.bits_per_raw_sample) > 8 || /1[02]/.test(pixFmt || '');
      pixFmt = deep ? 'yuv444p10le' : 'yuv444p';
      converted = true;
    }
    const layout = PIX[pixFmt];
    const bpp = layout.bits > 8 ? 2 : 1;
    const ySize = width * height * bpp;
    const cSize = layout.gray ? 0 : Math.ceil(width / layout.cw) * Math.ceil(height / layout.ch) * bpp;

    const duration = Number(v.duration) || Number(fmt.duration) || 0;
    const vStart = Math.max(0, (Number(v.start_time) || 0) - (Number(fmt.start_time) || 0));
    const audio = (probe.streams || []).filter((s) => s.codec_type === 'audio');
    const pick = (val, list) => (list.includes(val) ? val : null);
    const frames = Number(v.nb_frames) || Math.max(1, Math.round(duration * fps.value));
    const v0 = Number(v.start_time) || 0;
    const keyframes = [...new Set(
      (probe.packets || [])
        .filter((p) => p.stream_index === v.index && String(p.flags).includes('K') && p.pts_time != null)
        .map((p) => Math.round((Number(p.pts_time) - v0) * fps.value))
        .filter((k) => k >= 0 && k < frames),
    )].sort((a, b) => a - b);

    this.info = {
      name: file.name,
      size: file.size,
      codec: v.codec_name,
      profile: v.profile,
      container: fmt.format_name,
      width, height, rotation,
      fps, vfr,
      duration,
      frames,
      framesExact: !!Number(v.nb_frames),
      keyframes,
      pixFmt, srcPixFmt: v.pix_fmt, converted,
      bits: layout.bits, bpp, layout, ySize, cSize,
      frameBytes: ySize + 2 * cSize,
      vStart,
      audio: audio.map((a) => a.codec_name),
      color: {
        range: layout.full ? 'pc' : pick(v.color_range, KNOWN_COLOR.range),
        space: pick(v.color_space, KNOWN_COLOR.space),
        primaries: pick(v.color_primaries, KNOWN_COLOR.primaries),
        transfer: pick(v.color_transfer, KNOWN_COLOR.transfer),
      },
    };
    return this.info;
  }

  /**
   * 디코드 비용이 싼 시작점: 키프레임 바로 다음 프레임.
   * (k+1)번 프레임을 요청하면 seek가 키프레임 k에 떨어지고 1장만 버리면 된다.
   * 반면 키프레임 k 자체를 요청하면 반 프레임 앞 기준으로 seek되어 이전 GOP 전체를 디코드하게 된다.
   */
  cheapStarts() {
    const s = [0];
    for (const k of this.info.keyframes) if (k > 0 && k + 1 < this.info.frames) s.push(k + 1);
    return [...new Set(s)].sort((a, b) => a - b);
  }

  /** 전체 프레임을 maxFrames 이하 구간들로 나눈다. 경계는 가능한 한 cheapStarts에 맞춤 */
  planChunks(maxFrames) {
    const total = this.info.frames;
    const b = [...this.cheapStarts(), total];
    const chunks = [];
    let cur = null;
    for (let j = 0; j < b.length - 1; j++) {
      const s = b[j], len = b[j + 1] - s;
      if (len <= 0) continue;
      if (len > maxFrames) {
        if (cur) { chunks.push(cur); cur = null; }
        for (let o = 0; o < len; o += maxFrames) chunks.push({ start: s + o, count: Math.min(maxFrames, len - o) });
      } else if (cur && cur.count + len <= maxFrames) {
        cur.count += len;
      } else {
        if (cur) chunks.push(cur);
        cur = { start: s, count: len };
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  #seekArgs(frame) {
    const ss = this.info.vStart + (frame - 0.5) / this.info.fps.value;
    return ss > 0 ? ['-ss', ss.toFixed(6)] : [];
  }

  /**
   * frame번째부터 count장을 원본 픽셀 포맷 그대로 raw로 디코드. 반환: {data, frames}
   * lane: 'main'(기본) | 'dec'(병렬 디코더 중 한가한 곳)
   */
  decode(frame, count, lane = 'main') {
    const target = lane === 'dec' ? this.#pick(this.decLanes) : this.main;
    return target.run(async (l) => {
      const out = '/work/dec.raw';
      await l.exec([
        ...this.#seekArgs(frame), '-i', this.inPath,
        '-map', '0:v:0', '-an', '-sn', '-dn',
        '-frames:v', String(count), '-fps_mode', 'passthrough',
        '-f', 'rawvideo', '-pix_fmt', this.info.pixFmt, '-y', out,
      ]);
      const data = await l.ff.readFile(out);
      await l.ff.deleteFile(out);
      return { data, frames: Math.floor(data.length / this.info.frameBytes) };
    });
  }

  /**
   * seek 없이 프레임 번호로 정확히 뽑는 느린 대체 경로.
   * 시작 시간·편집 목록이 특이해 seek 결과가 비는 파일에서 쓴다.
   */
  decodeExact(frame, count, lane = 'main') {
    const target = lane === 'dec' ? this.#pick(this.decLanes) : this.main;
    return target.run(async (l) => {
      const out = '/work/exact.raw';
      await l.exec([
        '-i', this.inPath, '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `select='between(n\\,${frame}\\,${frame + count - 1})'`,
        '-frames:v', String(count), '-fps_mode', 'passthrough',
        '-f', 'rawvideo', '-pix_fmt', this.info.pixFmt, '-y', out,
      ]);
      const data = await l.ff.readFile(out);
      await l.ff.deleteFile(out);
      return { data, frames: Math.floor(data.length / this.info.frameBytes) };
    });
  }

  /** 여러 프레임을 한 번의 순차 디코드로 뽑는다(키프레임이 드문 영상의 분석용). 반환: {data, frames} */
  decodeSelect(indices) {
    return this.main.run(async (l) => {
      const out = '/work/sel.raw';
      const expr = indices.map((k) => `eq(n\\,${k})`).join('+');
      await l.exec([
        '-i', this.inPath, '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `select='${expr}'`, '-frames:v', String(indices.length), '-fps_mode', 'passthrough',
        '-f', 'rawvideo', '-pix_fmt', this.info.pixFmt, '-y', out,
      ]);
      const data = await l.ff.readFile(out);
      await l.ff.deleteFile(out);
      return { data, frames: Math.floor(data.length / this.info.frameBytes) };
    });
  }

  #colorArgs() {
    const c = this.info.color, a = [];
    if (c.range) a.push('-color_range', c.range);
    if (c.space) a.push('-colorspace', c.space);
    if (c.primaries) a.push('-color_primaries', c.primaries);
    if (c.transfer) a.push('-color_trc', c.transfer);
    return a;
  }

  #codecArgs(mode) {
    const pf = this.info.pixFmt;
    // 무손실(qp 0)은 프리셋과 무관하게 픽셀이 100% 같다. 프리셋은 속도·용량만 바꾸므로 가장 빠른 ultrafast 사용
    if (mode === 'lossless') return ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-bf', '0', '-pix_fmt', pf];
    if (mode === 'ffv1') return ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '4', '-slicecrc', '1', '-pix_fmt', pf];
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-bf', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
  }

  /** raw 프레임 묶음 → 세그먼트 인코드(한가한 인코더 레인에서). 반환: 세그먼트 Blob */
  encode(raw, frames, mode) {
    return this.#pick(this.encLanes).run(async (l) => {
      const { width, height, pixFmt, fps } = this.info;
      const inRaw = '/work/enc.raw', seg = '/work/seg.nut';
      await l.ff.writeFile(inRaw, raw);
      try {
        await l.exec([
          '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${width}x${height}`, '-framerate', fps.str,
          '-i', inRaw, '-frames:v', String(frames),
          ...this.#colorArgs(), ...this.#codecArgs(mode), '-y', seg,
        ]);
      } finally {
        await l.ff.deleteFile(inRaw).catch(() => {});
      }
      const data = await l.ff.readFile(seg);
      await l.ff.deleteFile(seg);
      return new Blob([data]);
    });
  }

  /** 세그먼트들을 이어붙이고 원본 오디오·메타데이터를 그대로(copy) 합친다 */
  mux(segments, mode, onStage) {
    return this.main.run(async (l) => {
      const out = OUTPUTS[mode];
      const { fps, vStart } = this.info;
      await l.mountBlobs('/segs', segments.map((s, i) => ({ name: `s${i}.nut`, data: s.blob })));
      const list = segments
        .map((s, i) => `file '/segs/s${i}.nut'\nduration ${((s.frames * fps.den) / fps.num).toFixed(9)}`)
        .join('\n');
      await l.ff.writeFile('/work/list.txt', new TextEncoder().encode(list));
      const outPath = `/work/out.${out.ext}`;
      const base = [
        '-f', 'concat', '-safe', '0', ...(vStart > 0 ? ['-itsoffset', vStart.toFixed(6)] : []), '-i', '/work/list.txt',
        '-i', this.inPath, '-map', '0:v:0', '-map', '1:a?', '-map_metadata', '1',
      ];
      const tail = [...(mode === 'hq' ? ['-movflags', '+faststart'] : []), '-y', outPath];
      let audioNote = null;
      try {
        await l.exec([...base, '-c', 'copy', ...tail]);
      } catch (err) {
        if (!this.info.audio.length) throw err;
        // 컨테이너가 원본 오디오 코덱을 못 담는 경우에만 오디오를 변환
        onStage?.('오디오를 호환 형식으로 변환 중');
        await l.exec([...base, '-c:v', 'copy', '-c:a', out.ext === 'mkv' ? 'flac' : 'aac', '-b:a', '320k', ...tail]);
        audioNote = `원본 오디오(${this.info.audio[0]})를 ${out.ext === 'mkv' ? 'FLAC' : 'AAC 320k'}로 변환했어요.`;
      }
      const data = await l.ff.readFile(outPath);
      await l.ff.deleteFile(outPath);
      await l.ff.deleteFile('/work/list.txt');
      await l.ff.unmount('/segs'); await l.ff.deleteDir('/segs'); l.mounted.delete('/segs');
      return { blob: new Blob([data], { type: out.ext === 'mp4' ? 'video/mp4' : 'video/x-matroska' }), audioNote };
    });
  }
}
