import { app } from 'electron';

let backend: Record<string, string> = {};
/** Graphics diagnostics contain lifecycle information, never terminal or page content. */
export function graphicsLog(event: string, details: Record<string, string | number> = {}) {
  console.error('[graphics]', JSON.stringify({ time: new Date().toISOString(), event, platform: process.platform,
    requestedDisplay: app.commandLine.getSwitchValue('ozone-platform') || 'auto', ...backend, ...details }));
}

export function observeGraphics() {
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') graphicsLog('gpu-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });
  void app.getGPUInfo('complete').then(info => {
    const attributes = (info as { auxAttributes?: Record<string, unknown> }).auxAttributes ?? {};
    for (const key of ['displayType', 'glRenderer', 'glImplementationParts']) {
      if (typeof attributes[key] === 'string') backend[key] = attributes[key].slice(0, 256);
    }
    graphicsLog('backend');
  }, () => graphicsLog('backend-unavailable'));
}
