/** The percentages a VNC desktop can be zoomed to. */
export const zoomRange = { min: 10, max: 500 };
const zoomSteps = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
/** The zoom one step from `percent`: the next of the usual steps, or the end of the range. */
export const stepZoom = (percent: number, direction: 1 | -1) =>
  direction > 0
    ? (zoomSteps.find((step) => step > percent) ?? zoomRange.max)
    : (zoomSteps.filter((step) => step < percent).at(-1) ?? zoomRange.min);
/** The whole percentage that typed text asks for, brought within the range, or nothing for text that is not one. */
export function parseZoom(text: string) {
  const match = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*%?\s*$/.exec(text);
  return match ? Math.min(zoomRange.max, Math.max(zoomRange.min, Math.round(Number(match[1])))) : undefined;
}
