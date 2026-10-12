// Generates the Windows and Linux icons from resources/icon.png (1024 px):
//   build/icon.ico                       16, 24, 32, 48, 64, 128, 256 px (PNG-compressed entries)
//   build/icons/<size>x<size>.png        16, 24, 32, 48, 64, 128, 256, 512 px
// Run on macOS (uses `sips`): node scripts/icons.mjs. The outputs are committed, so builds never need this script.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const source = join(dir, 'resources', 'icon.png');
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const tmp = mkdtempSync(join(tmpdir(), 'janus-icons-'));
const resized = (size) => {
  const out = join(tmp, `${size}.png`);
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', out], { stdio: 'ignore' });
  return readFileSync(out);
};

try {
  const pngs = new Map(PNG_SIZES.map((s) => [s, resized(s)]));
  mkdirSync(join(dir, 'build', 'icons'), { recursive: true });
  for (const [s, png] of pngs) writeFileSync(join(dir, 'build', 'icons', `${s}x${s}.png`), png);
  writeFileSync(join(dir, 'build', 'icon.ico'), ico(ICO_SIZES.map((s) => [s, pngs.get(s)])));
  console.log(`wrote build/icon.ico (${ICO_SIZES.join(', ')}) and build/icons/*.png (${PNG_SIZES.join(', ')})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** An ICO container whose entries are PNG images (valid since Windows Vista). A 256 px entry stores 0 as its size. */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirEntries = [];
  let offset = 6 + 16 * entries.length;
  for (const [size, png] of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dirEntries.push(e);
  }
  return Buffer.concat([header, ...dirEntries, ...entries.map(([, png]) => png)]);
}
