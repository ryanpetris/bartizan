import { isMonospace } from './font-metadata';

self.onmessage = async ({ data }: MessageEvent<{ blob: Blob; postscriptName: string }>) => {
  let monospace = false;
  try { monospace = isMonospace(await data.blob.arrayBuffer(), data.postscriptName); }
  catch { /* An unreadable font does not prevent the remaining fonts from loading. */ }
  self.postMessage(monospace);
};
