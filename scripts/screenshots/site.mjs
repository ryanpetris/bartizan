// A synthetic web app, Atlas, and its documentation, for the screenshot's browser sessions.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const style = `
@font-face { font-family: Inter; src: url(/inter.woff2) format("woff2"); font-weight: 100 900; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 Inter, sans-serif; color: #1f2430; background: #f6f7fb; }
header { display: flex; align-items: center; gap: 28px; height: 56px; padding: 0 28px; background: #fff; border-bottom: 1px solid #e6e8f0; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
.logo img { width: 24px; height: 24px; }
nav a { margin-right: 20px; color: #5b6275; text-decoration: none; font-weight: 500; }
nav a.on { color: #1f2430; }
.me { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; background: #c7d2fe; }
main { max-width: 1080px; margin: 0 auto; padding: 28px; }
h1 { margin: 0 0 18px; font-size: 22px; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
.card { padding: 16px 18px; background: #fff; border: 1px solid #e6e8f0; border-radius: 12px; }
.label { color: #6b7285; font-size: 12px; font-weight: 500; }
.value { margin-top: 4px; font-size: 24px; font-weight: 650; }
.delta { font-size: 12px; font-weight: 600; color: #15803d; }
.delta.bad { color: #b45309; }
.wide { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 9px 0; border-top: 1px solid #eef0f5; text-align: left; font-weight: 400; }
th { color: #6b7285; font-size: 12px; font-weight: 500; border-top: 0; }
.pill { padding: 2px 8px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 12px; font-weight: 600; }
.doc { max-width: 760px; }
.doc h2 { margin: 26px 0 8px; font-size: 16px; }
code { padding: 1px 5px; border-radius: 5px; background: #eceef5; font-size: 13px; }
`;
const chart = (() => {
  const points = [34, 38, 36, 44, 41, 47, 52, 49, 55, 61, 58, 64, 70, 66, 72, 78, 74, 81, 86, 83];
  const line = points.map((y, i) => `${(i * 600) / (points.length - 1)},${150 - y * 1.5}`).join(' ');
  return `<svg viewBox="0 0 600 160" width="100%" height="200" preserveAspectRatio="none"><defs><linearGradient id="f" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7c3aed" stop-opacity=".25"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></linearGradient></defs><polygon points="0,160 ${line} 600,160" fill="url(#f)"/><polyline points="${line}" fill="none" stroke="#7c3aed" stroke-width="2.5"/></svg>`;
})();
const page = (title, icon, active, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/${icon}.png"><style>${style}</style>
<header><span class="logo"><img src="/${icon}.png" alt="">${icon === 'app' ? 'Atlas' : 'Atlas Docs'}</span><nav>${(icon === 'app' ? ['Dashboard', 'Search', 'Reports', 'Settings'] : ['API reference', 'Changelog', 'Runbook']).map(name => `<a class="${name === active ? 'on' : ''}">${name}</a>`).join('')}</nav><span class="me"></span></header><main>${body}</main>`;
const pages = {
  '/': page('Dashboard · Atlas', 'app', 'Dashboard', `<h1>Dashboard</h1>
<div class="cards">
<div class="card"><div class="label">Requests today</div><div class="value">48,213</div><div class="delta">+12.4%</div></div>
<div class="card"><div class="label">p95 latency</div><div class="value">182 ms</div><div class="delta">−9 ms</div></div>
<div class="card"><div class="label">Error rate</div><div class="value">0.21%</div><div class="delta bad">+0.03%</div></div>
<div class="card"><div class="label">Jobs queued</div><div class="value">17</div><div class="delta">−5</div></div>
</div>
<div class="wide"><div class="card"><div class="label">Requests per minute</div>${chart}</div>
<div class="card"><div class="label">Recent deploys</div><table><tr><th>Version</th><th>When</th><th></th></tr>
<tr><td>2.4.0-rc.2</td><td>12 min ago</td><td><span class="pill">Healthy</span></td></tr>
<tr><td>2.4.0-rc.1</td><td>Yesterday</td><td><span class="pill">Healthy</span></td></tr>
<tr><td>2.3.0</td><td>Mon</td><td><span class="pill">Healthy</span></td></tr>
<tr><td>2.2.4</td><td>Last week</td><td><span class="pill">Healthy</span></td></tr></table></div></div>`),
  '/settings': page('Settings · Atlas', 'app', 'Settings', '<h1>Settings</h1>'),
  '/docs/api': page('API reference · Atlas Docs', 'docs', 'API reference', '<div class="doc"><h1>API reference</h1></div>'),
  '/docs/changelog': page('Changelog · Atlas Docs', 'docs', 'Changelog', '<div class="doc"><h1>Changelog</h1></div>'),
  '/docs/runbook': page('Runbook · Atlas Docs', 'docs', 'Runbook', '<div class="doc"><h1>Runbook</h1></div>'),
};
const files = {
  '/inter.woff2': [new URL('../../assets/fonts/inter.woff2', import.meta.url), 'font/woff2'],
  '/app.png': [new URL('site/app.png', import.meta.url), 'image/png'],
  '/docs.png': [new URL('site/docs.png', import.meta.url), 'image/png'],
};

/** Serves the pages on loopback at `port` and returns the server. */
export async function startSite(port) {
  const server = createServer(async (request, response) => {
    const path = request.url.split('?')[0];
    if (pages[path]) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(pages[path]);
    } else if (files[path]) {
      response.setHeader('Content-Type', files[path][1]);
      response.end(await readFile(files[path][0]));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}
