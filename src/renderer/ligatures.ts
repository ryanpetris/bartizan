import type { Terminal } from '@xterm/xterm';

/**
 * Rendering joins an operator run only when the terminal's current font draws that exact run differently as a whole than
 * as its separate characters, checking each run once per font.
 */

const checkSize = 32;
const checkHeight = checkSize * 1.5;
/** Room for the longest joined run at the check size, even for wide fonts. */
const checkWidth = 16 * checkSize + checkSize;
let canvas: OffscreenCanvas | undefined;
/**
 * Whether a font list draws text differently as a whole than as its characters drawn separately at their own advances.
 * Kerning is off for both, so a difference comes from shaping such as ligatures and contextual alternates.
 */
function shapes(fonts: string, text: string): boolean {
  canvas ??= new OffscreenCanvas(checkWidth, checkHeight);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.font = `${checkSize}px ${fonts}`;
  context.fontKerning = 'none';
  context.textBaseline = 'top';
  const advances = [...text].map(character => context.measureText(character).width);
  const width = Math.min(checkWidth, Math.ceil(advances.reduce((sum, advance) => sum + advance, 0)) + 8);
  const pixels = (draw: () => void) => { context.clearRect(0, 0, width, checkHeight); draw(); return context.getImageData(0, 0, width, checkHeight).data; };
  const whole = pixels(() => context.fillText(text, 4, 4));
  const separate = pixels(() => {
    let x = 4;
    [...text].forEach((character, index) => { context.fillText(character, x, 4); x += advances[index]; });
  });
  let difference = 0;
  for (let index = 3; index < whole.length; index += 4) difference += Math.abs(whole[index] - separate[index]);
  // Separately drawn characters match the whole text apart from antialiasing when nothing is shaped; shaping changes many pixels.
  return difference > 255 * 10;
}

/** Runs of programming punctuation, such as arrows and comparison operators, that a font may draw as one unit. */
const punctuationRun = /[!#$%&*+\-./:;<=>?@\\^_|~[\]{}()]{2,}/g;
const operator = /[!#$%&*+\-./:;<=>?@\\^_|~]/;
/** Longer runs, such as rules of dashes, stay separate so one joined glyph never spans a wide stretch of cells. */
const longestJoin = 16;
/** Checked runs a terminal keeps at least; a terminal keeps more when its screen can show more distinct runs. */
const runsKept = 512;
/** Runs checked in one frame across terminals; the rest wait for the next frame. */
const checksPerFrame = 48;
let checks = 0;

/**
 * A character joiner for a terminal. Only the WebGL renderer joins characters; the DOM renderer draws them separately.
 * Runs are checked against the terminal's current font, so a font change checks them again. Runs beyond a frame's check
 * budget draw separately and the terminal redraws on the next frame until every run it draws is checked.
 */
export function operatorJoiner(terminal: Terminal): (text: string) => [number, number][] {
  let fonts = '', redrawing = false;
  const checked = new Map<string, boolean>();
  return text => {
    const ranges: [number, number][] = [];
    const current = terminal.options.fontFamily || 'monospace';
    if (current !== fonts) { fonts = current; checked.clear(); }
    // Runs arrive one styled span at a time, so two cells can hold a run, and one screen shows no more distinct runs
    // than this. Checked runs are dropped only for a run beyond that many, so a screen that stays put keeps every run it
    // has checked and redrawing settles.
    const kept = Math.max(runsKept, terminal.rows * Math.floor(terminal.cols / 2));
    let deferred = false;
    for (const match of text.matchAll(punctuationRun)) {
      const run = match[0];
      if (run.length > longestJoin || !operator.test(run)) continue;
      let joined = checked.get(run);
      if (joined === undefined) {
        // A font that has not loaded would be checked as its fallback, so its runs draw separately until it has loaded.
        if (!document.fonts.check(`${checkSize}px ${fonts}`)) continue;
        if (checks >= checksPerFrame) { deferred = true; continue; }
        if (checks++ === 0) requestAnimationFrame(() => { checks = 0; });
        try { joined = shapes(fonts, run); } catch { joined = false; }
        if (checked.size >= kept) checked.clear();
        checked.set(run, joined);
      }
      if (joined) ranges.push([match.index, match.index + run.length]);
    }
    if (deferred && !redrawing) {
      redrawing = true;
      requestAnimationFrame(() => { redrawing = false; terminal.refresh(0, terminal.rows - 1); });
    }
    return ranges;
  };
}
