/**
 * Rasterizes public/icon.svg into the PNG sizes the manifest needs, using
 * Playwright's Chromium (no system rasterizer required).
 *
 *   pnpm icons
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(ROOT, 'public/icon.svg'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(ROOT, `public/icon/${size}.png`), omitBackground: true });
}
await browser.close();
console.log('icons → public/icon/{16,32,48,128}.png');
