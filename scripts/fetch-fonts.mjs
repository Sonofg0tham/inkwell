// Downloads the brand fonts as woff2 into public/fonts/ so the extension
// bundles them locally (no CDN requests at runtime — MV3 CSP and privacy).
// Run once: node scripts/fetch-fonts.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FONTS = [
  {
    file: 'fraunces-var.woff2',
    // Variable font including the SOFT and WONK axes the brand uses.
    css: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,100..900,0..100,0..1&display=swap',
    fallbackCss:
      'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,100..900&display=swap',
  },
  {
    file: 'atkinson-400.woff2',
    css: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400&display=swap',
  },
  {
    file: 'atkinson-700.woff2',
    css: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@700&display=swap',
  },
  {
    file: 'plexmono-400.woff2',
    css: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap',
  },
];

async function latinWoff2Url(cssUrl) {
  const res = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CSS fetch failed ${res.status} for ${cssUrl}`);
  const css = await res.text();
  // Prefer the plain "latin" subset block; fall back to the first URL found.
  const latinBlock = css.split('/* latin */').pop() ?? css;
  const match = latinBlock.match(/url\((https:[^)]+\.woff2)\)/) ?? css.match(/url\((https:[^)]+\.woff2)\)/);
  if (!match) throw new Error(`No woff2 URL in CSS from ${cssUrl}`);
  return match[1];
}

const outDir = path.resolve('public', 'fonts');
await mkdir(outDir, { recursive: true });

for (const font of FONTS) {
  let url;
  try {
    url = await latinWoff2Url(font.css);
  } catch (err) {
    if (!font.fallbackCss) throw err;
    console.warn(`Falling back for ${font.file}: ${err.message}`);
    url = await latinWoff2Url(font.fallbackCss);
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Font fetch failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(outDir, font.file), buf);
  console.log(`${font.file}  ${(buf.length / 1024).toFixed(0)} KB`);
}
console.log('Fonts saved to public/fonts/');
