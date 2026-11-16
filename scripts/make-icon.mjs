/* 用品牌 SVG 生成桌面版图标（512 安装图标 / 256 / 32 托盘）
 * 用法：npm run models
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const out = (rel, buffer) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  return buffer.toFile(file);
};

const mark = read('public/brand/mark.svg')
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2740"/>
      <stop offset="1" stop-color="#0d1119"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7ea7ff" stop-opacity=".55"/>
      <stop offset="1" stop-color="#7ea7ff" stop-opacity=".08"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="none" stroke="url(#edge)" stroke-width="3"/>
  <g transform="translate(112,120) scale(6.0)">${mark}</g>
</svg>`;

const png = () => sharp(Buffer.from(svg)).png();

await out('desktop/build/icon.png', png());
await out('desktop/build/icon-256.png', png().resize(256, 256));
await out('desktop/build/tray.png', png().resize(32, 32));
console.log('图标已生成：desktop/build/icon.png');
