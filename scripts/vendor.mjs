// node_modules의 ffmpeg.wasm 파일을 public/vendor로 복사 (모든 파일을 같은 도메인에서 서빙 → 외부 요청 0)
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'public/vendor');
rmSync(out, { recursive: true, force: true });
const copy = (from, to) => {
  mkdirSync(resolve(out, to), { recursive: true });
  cpSync(resolve(root, 'node_modules', from), resolve(out, to), { recursive: true });
};
copy('@ffmpeg/ffmpeg/dist/esm', 'ffmpeg');
copy('@ffmpeg/util/dist/esm', 'util');
copy('@ffmpeg/core/dist/esm', 'core');
console.log('vendor ready →', out);
