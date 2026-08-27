// One-off: render the Plan Usage dialog content with demo data and capture it.
// Mirrors showUsageDialog() in main.js — keep the line layout in sync.
// All values below are invented; nothing is read from the local machine.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'screenshots', 'usage.png');

// Same shape as usageWindowLine() output: "<dur>-<unit> window: used/limit (pct) — resets …".
const QUOTA_LINES = [
  '5-hour window: 33/100 used (33%) — resets 19:49 (in 2h 14m)',
  '1-week window: 12/100 used (12%) — resets Thu 10:49 (in 17h 58m)',
];
const SESSION_LINES = [
  'Active sessions: 2',
  'Total reported tokens: 1,284,502',
  'Total reported cost: $3.1486',
];

function usageHtml() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const quota = QUOTA_LINES.map((l) => `<div class="line">${esc(l)}</div>`).join('');
  const sessions = SESSION_LINES.map((l) => `<div class="line">${esc(l)}</div>`).join('');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 22px; }
    h1 { font-size: 15px; margin: 0 0 12px; }
    .line { font-size: 13px; margin: 3px 0; }
    .gap { height: 12px; }
    .muted { color: #555; }
    #btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    button { font-size: 13px; padding: 5px 14px; border-radius: 6px; border: 1px solid #bbb; background: #f6f6f6; }
    #ok { background: #0a7cff; border-color: #0a7cff; color: #fff; }
  </style>
</head>
<body>
  <h1>Plan usage</h1>
  ${quota}
  <div class="gap"></div>
  ${sessions}
  <div class="gap"></div>
  <div class="line muted">Full breakdown on the Kimi dashboard:</div>
  <div class="line muted">https://platform.kimi.com</div>
  <div id="btns">
    <button>Open Dashboard</button>
    <button id="ok">OK</button>
  </div>
</body>
</html>`;
}

app.whenReady().then(async () => {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-shot-')));
  const win = new BrowserWindow({
    width: 560,
    height: 320,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-shot-')), 'usage.html');
  fs.writeFileSync(tmp, usageHtml());
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 600));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log(`wrote ${OUT} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});
