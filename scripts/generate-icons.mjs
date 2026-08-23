import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const design = resolve(root, 'design');
const pub = resolve(root, 'public');

const src = readFileSync(resolve(design, 'icon.svg'), 'utf8');

writeFileSync(resolve(pub, 'favicon.svg'), src);

const ios = src
  .replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="180" height="180"')
  .replace(' rx="14"', '');

writeFileSync(resolve(pub, 'apple-touch-icon.svg'), ios);

execFileSync('rsvg-convert', ['-w', '64', '-h', '64', '-o', resolve(pub, 'favicon-64.png'), resolve(pub, 'favicon.svg')]);
execFileSync('rsvg-convert', ['-w', '180', '-h', '180', '-o', resolve(pub, 'apple-touch-icon.png'), resolve(pub, 'apple-touch-icon.svg')]);

console.log('Generated public/favicon.svg, favicon-64.png, apple-touch-icon.svg, apple-touch-icon.png from design/icon.svg');
