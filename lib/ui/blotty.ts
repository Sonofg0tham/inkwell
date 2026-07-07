// Blotty, the Inkwell mascot. Static SVG strings only — never interpolate
// user or model data into these.

export type BlottyMood = 'happy' | 'asleep' | 'dizzy';

const INK = '#20253c';
const PAPER = '#fdfbf5';
const CORAL = '#e86a3d';

const BLOB_PATH =
  'M24 5c2.5 6.5 6.5 9.5 10 13.5 2.6 3 4.5 6.6 4.5 11A14.5 14.5 0 0 1 24 44 14.5 14.5 0 0 1 9.5 29.5c0-4.4 1.9-8 4.5-11C17.5 14.5 21.5 11.5 24 5z';

const FACES: Record<BlottyMood, string> = {
  happy: `
    <circle cx="18.5" cy="28" r="3.1" fill="${PAPER}"/>
    <circle cx="29.5" cy="28" r="3.1" fill="${PAPER}"/>
    <circle cx="19.3" cy="28.6" r="1.5" fill="${INK}"/>
    <circle cx="30.3" cy="28.6" r="1.5" fill="${INK}"/>
    <path d="M19 34.5q5 4.5 10 0" fill="none" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>`,
  asleep: `
    <path d="M15.5 28.5q3 3 6 0" fill="none" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>
    <path d="M26.5 28.5q3 3 6 0" fill="none" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>
    <path d="M21.5 35.5q2.5 1.8 5 0" fill="none" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>
    <text x="38" y="14" font-family="Georgia, serif" font-size="9" font-style="italic" fill="${CORAL}">z</text>
    <text x="43" y="8" font-family="Georgia, serif" font-size="7" font-style="italic" fill="${CORAL}">z</text>`,
  dizzy: `
    <path d="M16 25.5l5 5M21 25.5l-5 5" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>
    <path d="M27 25.5l5 5M32 25.5l-5 5" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>
    <path d="M18 36q2 -2 4 0t4 0t4 0" fill="none" stroke="${PAPER}" stroke-width="2" stroke-linecap="round"/>`,
};

export function blottySvg(mood: BlottyMood, size = 48): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Blotty the ink blob (${mood})">
  <path d="${BLOB_PATH}" fill="${INK}"/>
  <ellipse cx="17" cy="20" rx="4" ry="6" fill="#ffffff" opacity="0.12" transform="rotate(-18 17 20)"/>
  ${FACES[mood]}
</svg>`;
}
