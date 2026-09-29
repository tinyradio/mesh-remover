// 프레임 필터링 워커. 메인 스레드가 Y(밝기) 평면만 보내면 그물무늬를 지워 돌려준다.
import { buildMask, filterPlane, accumulateSpectrum, TILE } from './mesh-filter.js';

let mask = null;

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'mask') {
      mask = buildMask(msg.params);
      self.postMessage({ id: msg.id, ok: true, mask: msg.wantMask ? mask.slice() : undefined });
      return;
    }
    if (msg.type === 'filter') {
      const { width, height, bits, gain } = msg;
      const src = bits > 8 ? new Uint16Array(msg.plane) : new Uint8Array(msg.plane);
      const dst = bits > 8 ? new Uint16Array(src.length) : new Uint8Array(src.length);
      const stats = filterPlane(src, dst, width, height, mask, gain, (1 << bits) - 1);
      self.postMessage({ id: msg.id, ok: true, plane: dst.buffer, stats }, [dst.buffer]);
      return;
    }
    if (msg.type === 'spectrum') {
      const { width, height, bits } = msg;
      const src = bits > 8 ? new Uint16Array(msg.plane) : new Uint8Array(msg.plane);
      const power = new Float64Array(TILE * TILE);
      const count = accumulateSpectrum(src, width, height, power);
      self.postMessage({ id: msg.id, ok: true, power: power.buffer, count }, [power.buffer]);
      return;
    }
    throw new Error('unknown message: ' + msg.type);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
