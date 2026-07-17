// Dev tool: regenerate the README screenshots.
//
//   npm run screenshots
//
// Loads the local Kimi web UI offscreen (nothing pops up on screen) and writes
// PNGs to screenshots/. Requires the Kimi server to be running — launch the app
// once, or run `kimi web --no-open --port 58627`, beforehand.
//
// SAFETY: these shots are published. The sidebar lists every workspace on the
// machine, so this script only ever renders the demo workspaces below and hard
// fails if anything else is visible in the captured frame. To create the demo
// data, run scripts/seed-demo.sh first.
const { app, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIMI_PORT = 58627;
const KIMI_URL = `http://127.0.0.1:${KIMI_PORT}/`;
const TOKEN_FILE = path.join(os.homedir(), '.kimi-code', 'server.token');
const OUT_DIR = path.join(__dirname, '..', 'screenshots');
const MAIN_JS = path.join(__dirname, '..', 'main.js');

// Only these workspace names may appear in a published shot.
const DEMO_WORKSPACES = ['landing-page', 'api-server'];
const HERO_WORKSPACE = 'landing-page';
const COMPOSER_DRAFT = 'Add a testimonials section below the pricing grid';
const QUICK_PROMPT_QUESTION = 'What is the time complexity of binary search? Answer in one short sentence.';
const TERMINAL_DEMO =
  'dev@macbook landing-page % kimi --version\r\n' +
  'kimi-code 0.23.6\r\n' +
  'dev@macbook landing-page % git status -sb\r\n' +
  '## main...origin/main\r\n' +
  ' M src/components/Hero.tsx\r\n' +
  '?? src/components/PricingGrid.tsx\r\n' +
  'dev@macbook landing-page % ';

function readServerToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shotWindow(width, height, extra = {}) {
  return new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    ...extra,
  });
}

async function capture(win, file, waitMs = 500) {
  await sleep(waitMs);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
  console.log(`wrote ${path.basename(file)} (${image.getSize().width}x${image.getSize().height})`);
}

function seedStorage(webContents) {
  const token = readServerToken();
  const cred = token
    ? JSON.stringify({ version: 1, credential: token, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })
    : null;
  const js = `try {
    ${cred ? `localStorage.setItem('kimi-web.server-credential', ${JSON.stringify(cred)});` : ''}
    localStorage.setItem('kimi-web.onboarded', '1');
  } catch {}`;
  webContents.executeJavaScript(js).catch(() => {});
}

/** Dismiss the first-run preferences modal if it shows. */
async function dismissOnboarding(win) {
  await win.webContents
    .executeJavaScript(`(async () => {
      for (let i = 0; i < 20; i++) {
        const dlg = [...document.querySelectorAll('.ui-dialog')].find((e) => e.offsetParent);
        if (!dlg) return;
        [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Get started')?.click();
        await new Promise((r) => setTimeout(r, 500));
      }
    })()`)
    .catch(() => {});
}

/** Remove every workspace group that isn't a demo one, so real names never render. */
function hideNonDemoGroups(win) {
  return win.webContents
    .executeJavaScript(`(() => {
      const keep = ${JSON.stringify(DEMO_WORKSPACES)};
      let hidden = 0;
      document.querySelectorAll('.side .group').forEach((g) => {
        const name = ((g.querySelector('.gh-name') || {}).textContent || '').trim();
        if (!keep.includes(name)) { g.remove(); hidden++; }
      });
      return hidden;
    })()`)
    .catch(() => 0);
}

/** Open the newest session inside the hero demo workspace. */
async function openHeroSession(win) {
  const ok = await win.webContents
    .executeJavaScript(`(() => {
      const group = [...document.querySelectorAll('.side .group')].find(
        (g) => ((g.querySelector('.gh-name') || {}).textContent || '').trim() === ${JSON.stringify(HERO_WORKSPACE)}
      );
      if (!group) return 'no-group';
      const title = group.querySelector('.t');
      if (!title) return 'no-session';
      // Click the row itself, not the truncated title span.
      let el = title;
      for (let i = 0; i < 4 && el; i++) {
        if (el.className && /row|item|sess/i.test(el.className)) break;
        el = el.parentElement;
      }
      (el || title).click();
      return 'clicked';
    })()`)
    .catch((e) => 'err ' + e.message);
  return ok;
}

/**
 * Refuse to publish a frame that shows anything but the demo workspaces.
 * Reads the rendered text of the sidebar + breadcrumb and rejects on anything
 * that looks like a real path or a non-demo workspace.
 */
async function assertNoRealData(win) {
  const report = await win.webContents.executeJavaScript(`(() => {
    const groups = [...document.querySelectorAll('.side .group')].map(
      (g) => ((g.querySelector('.gh-name') || {}).textContent || '').trim()
    );
    const crumb = (document.querySelector('.crumb, .breadcrumb, header') || {}).textContent || '';
    return JSON.stringify({ groups, crumb: crumb.trim().slice(0, 200), body: document.body.innerText.slice(0, 4000) });
  })()`);
  const { groups, crumb, body } = JSON.parse(report);
  const strayGroups = groups.filter((g) => g && !DEMO_WORKSPACES.includes(g));
  if (strayGroups.length) throw new Error(`LEAK: non-demo workspaces visible: ${strayGroups.join(', ')}`);
  const homeDir = os.homedir();
  const forbidden = [homeDir, os.userInfo().username, '/Users/'];
  for (const needle of forbidden) {
    if (body.includes(needle) || crumb.includes(needle)) {
      throw new Error(`LEAK: frame contains "${needle}"`);
    }
  }
  console.log(`  safety ok — workspaces visible: ${groups.join(', ') || '(none)'}`);
}

async function captureHero() {
  const win = shotWindow(1280, 660);
  win.webContents.on('dom-ready', () => seedStorage(win.webContents));
  const token = readServerToken();
  await win.loadURL(token ? `${KIMI_URL}#token=${encodeURIComponent(token)}` : KIMI_URL);
  await sleep(8000);
  await dismissOnboarding(win);
  await sleep(800);

  console.log(`  hid ${await hideNonDemoGroups(win)} non-demo workspace groups`);
  console.log(`  open hero session: ${await openHeroSession(win)}`);
  await sleep(2500);
  // The sidebar re-renders after switching sessions — strip real groups again.
  await hideNonDemoGroups(win);

  // Draft text in the composer so the shot shows an active workflow.
  await win.webContents
    .executeJavaScript(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, ${JSON.stringify(COMPOSER_DRAFT)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    })()`)
    .catch(() => {});
  await sleep(600);
  await assertNoRealData(win);
  await capture(win, path.join(OUT_DIR, 'app-hero.png'), 400);
  win.destroy();
}

async function captureTerminal() {
  const win = shotWindow(780, 500, {
    webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'terminal.html'));
  await sleep(1200);
  await win.webContents
    .executeJavaScript(`require('electron').ipcRenderer.emit('term-data', null, ${JSON.stringify(TERMINAL_DEMO)})`)
    .catch(() => {});
  await capture(win, path.join(OUT_DIR, 'terminal.png'), 600);
  win.destroy();
}

/** Pull a pure HTML-builder function out of main.js so shots render real app markup. */
function extractFunction(name) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`could not extract ${name} from main.js`);
  return m[0];
}

async function captureApprovals() {
  const escHtml = eval(`(${extractFunction('escHtml')})`);
  const approvalSummary = eval(`(${extractFunction('approvalSummary')})`);
  const approvalsHtml = eval(`(${extractFunction('approvalsHtml')})`);
  const rows = [
    {
      session: { id: 'session_demo1', title: 'Add rate limiting middleware' },
      approval: { id: 'ap1', tool_name: 'Bash', command: 'npm install express-rate-limit' },
    },
    {
      session: { id: 'session_demo2', title: 'Build hero section + pricing grid' },
      approval: { id: 'ap2', tool_name: 'Write', description: 'Create src/components/PricingGrid.tsx' },
    },
  ];
  const win = shotWindow(680, 300, {
    webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false },
  });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-shot-')), 'approvals.html');
  fs.writeFileSync(tmp, approvalsHtml(rows));
  await win.loadFile(tmp);
  await capture(win, path.join(OUT_DIR, 'approvals.png'), 600);
  win.destroy();
}

// Keep this HTML in sync with newWorkflowDialog() in main.js (demo values).
async function captureWorkflow() {
  const projects = [
    { path: '/tmp/demo/landing-page', label: '~/demo/landing-page' },
    { path: '/tmp/demo/api-server', label: '~/demo/api-server' },
  ];
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; display: flex; flex-direction: column; gap: 10px; }
    label { font-size: 12px; color: #555; margin-bottom: -6px; }
    input[type=text], textarea, select { font-size: 14px; padding: 8px; border-radius: 6px; border: 1px solid #ccc; font-family: inherit; }
    textarea { resize: vertical; min-height: 110px; }
    #sched { display: flex; gap: 8px; align-items: center; }
    #buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
    button { padding: 8px 16px; }
    .hint { font-size: 11px; color: #888; }
  </style>
</head>
<body>
  <label>Name</label>
  <input id="name" type="text" value="Nightly review">
  <label>Project</label>
  <select id="cwd"></select>
  <label>Prompt (what the agent should do)</label>
  <textarea id="prompt">Review today's changes, fix anything obviously broken, and summarize what you did.</textarea>
  <label>Agent mode</label>
  <select id="mode">
    <option value="goal" selected>Goal (runs autonomously until done)</option>
    <option value="normal">Normal</option>
    <option value="swarm">Swarm</option>
    <option value="plan">Plan</option>
  </select>
  <label>Permission mode</label>
  <select id="permission">
    <option value="default">Server default</option>
    <option value="auto" selected>Auto</option>
    <option value="manual">Manual</option>
    <option value="yolo">YOLO</option>
  </select>
  <label>Schedule</label>
  <div id="sched">
    <select id="schedule">
      <option value="manual">Manual (run from menu)</option>
      <option value="daily" selected>Daily at</option>
    </select>
    <input id="time" type="time" value="09:00">
  </div>
  <div class="hint">Each run starts a fresh session in the project. Daily runs fire only while the app is open.</div>
  <div id="buttons">
    <button id="cancel">Cancel</button>
    <button id="create">Create Workflow</button>
  </div>
  <script>
    const projects = ${JSON.stringify(projects)};
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.label;
      document.getElementById('cwd').appendChild(opt);
    }
  </script>
</body>
</html>`;
  const win = shotWindow(520, 560);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-shot-')), 'workflow.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await capture(win, path.join(OUT_DIR, 'workflow-new.png'), 600);
  win.destroy();
}

async function captureQuickPrompt() {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 14px; display: flex; flex-direction: column; gap: 8px; }
  input { font-size: 14px; padding: 9px; border-radius: 6px; border: 1px solid #ccc; }
  .hint { font-size: 11px; color: #888; }
  #buttons { display: flex; justify-content: flex-end; }
  button { padding: 6px 18px; }
</style></head>
<body>
  <input type="text" value=${JSON.stringify(QUICK_PROMPT_QUESTION)}>
  <div class="hint">Runs: kimi -p "..." -m kimi-code/k3</div>
  <div id="buttons"><button>Run</button></div>
</body></html>`;
  const win = shotWindow(600, 132);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-shot-')), 'qp.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await capture(win, path.join(OUT_DIR, 'quick-prompt.png'), 400);
  win.destroy();
}

app.on('window-all-closed', () => {}); // don't quit between captures

app.whenReady().then(async () => {
  // Isolate from the real app's profile (the app may be running right now).
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-shots-')));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  try {
    await captureHero();
    await captureTerminal();
    await captureApprovals();
    await captureWorkflow();
    await captureQuickPrompt();
  } catch (err) {
    console.error('capture failed:', err.message);
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
  app.quit();
});
