/** Maximum UTF-16 code units retained or sent for one VNC tab's clipboard. */
export const vncClipboardLimit = 128 * 1024;

export const fitsVncClipboard = (text: string) => text.length <= vncClipboardLimit;

export const changesVncClipboard = (current: string, next: string) => next !== current && fitsVncClipboard(next);
