const {
  app, BrowserWindow, Menu, Tray, shell, dialog, nativeTheme, nativeImage,
  globalShortcut, clipboard, ipcMain,
} = require('electron');
const { spawn, execFileSync, execFile } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('@ltd/j-toml');
const WebSocket = require('ws');

const KIMI_PORT = 58627;
// The port the running server actually bound. Since kimi-code 0.28 a busy
// port is retried with +1, so this can drift from KIMI_PORT; every request
// goes through kimiPort / kimiBaseUrl().
let kimiPort = KIMI_PORT;
const kimiBaseUrl = () => `http://127.0.0.1:${kimiPort}/`;
const SERVER_TOKEN_FILE = path.join(os.homedir(), '.kimi-code', 'server.token');
const CONFIG_FILE = path.join(os.homedir(), '.kimi-code', 'config.toml');
const SKILLS_DIR = path.join(os.homedir(), '.kimi-code', 'skills');
// kimi-code 0.28+: each `kimi web` instance registers itself here (JSON with
// pid/port). Used to find the process to stop and the port it drifted to.
const SERVER_INSTANCES_DIR = path.join(os.homedir(), '.kimi-code', 'server', 'instances');
const SERVER_PID_FILE = () => path.join(app.getPath('userData'), 'server-pid.json');
const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const QUICK_TOGGLE_ACCELERATOR = 'Alt+Space';

let mainWindow = null;
let tray = null;
let serverHealthy = true;
let serverBusyUntil = 0;
let serverStatusMessage = 'Server OK';

// Watchdog: how often we ping /healthz, how many consecutive misses before we
// treat the daemon as actually down (vs. one slow/blipped check), and how
// long to wait between automatic recovery attempts so a genuinely stuck
// daemon doesn't get hammered with restart attempts.
const HEALTH_CHECK_INTERVAL_MS = 20000;
const HEALTH_FAILURE_THRESHOLD = 2;
const RECOVERY_COOLDOWN_MS = 90000;
let consecutiveHealthFailures = 0;
let lastRecoveryAttempt = 0;
let recoveryFailureNotified = false;

// ---------------------------------------------------------------------------
// Preferences (recent projects, hotkey toggle)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    return { hotkeyEnabled: true, recentProjects: [], workflows: [], ...JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')) };
  } catch {
    return { hotkeyEnabled: true, recentProjects: [], workflows: [] };
  }
}

function savePrefs(prefs) {
  try {
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2));
  } catch {
    // best-effort only
  }
}

let prefs = { hotkeyEnabled: true, recentProjects: [] };

function addRecentProject(dir) {
  prefs.recentProjects = [dir, ...prefs.recentProjects.filter((p) => p !== dir)].slice(0, 10);
  savePrefs(prefs);
  buildMenu();
  buildDockMenu();
}

// ---------------------------------------------------------------------------
// Model configuration (config.toml)
// ---------------------------------------------------------------------------

function parseConfigToml() {
  try {
    return TOML.parse(fs.readFileSync(CONFIG_FILE, 'utf8'), 1.0, '\n');
  } catch {
    return null;
  }
}

function loadModels() {
  const parsed = parseConfigToml();
  if (!parsed || typeof parsed.models !== 'object') {
    return [
      { alias: 'kimi-code/kimi-for-coding', displayName: 'Kimi for Coding' },
      { alias: 'kimi-code/kimi-for-coding-highspeed', displayName: 'Kimi for Coding (High Speed)' },
      { alias: 'kimi-code/k3', displayName: 'Kimi K3' },
    ];
  }
  return Object.keys(parsed.models).map((alias) => {
    const m = parsed.models[alias];
    return {
      alias,
      displayName: (m && m.display_name) || alias,
    };
  });
}

function getDefaultModel() {
  const parsed = parseConfigToml();
  return (parsed && parsed.default_model) || 'kimi-code/kimi-for-coding';
}

function setDefaultModel(alias) {
  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return false;
  }
  const escaped = alias.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let replaced = text.replace(
    /^default_model\s*=\s*["'][^"']*["']/m,
    `default_model = "${escaped}"`
  );
  if (replaced === text && !/^default_model\s*=/m.test(text)) {
    replaced = `default_model = "${escaped}"\n\n${text}`;
  }
  try {
    fs.writeFileSync(CONFIG_FILE, replaced);
    return true;
  } catch {
    return false;
  }
}

async function switchModel(alias) {
  if (alias === getDefaultModel()) return;
  if (!setDefaultModel(alias)) {
    dialog.showErrorBox('Could not switch model', `Failed to write ${CONFIG_FILE.replace(os.homedir(), '~')}.`);
    return;
  }
  await restartKimiServer();
  dialog.showMessageBox({
    type: 'info',
    message: 'Model switched',
    detail: `Default model is now ${alias}. The server has been restarted.`,
    buttons: ['OK'],
  });
}

// ---------------------------------------------------------------------------
// API providers (config.toml)
// ---------------------------------------------------------------------------

// Presets for the "Add API Provider" flow. `id` becomes the [providers."<id>"]
// key (deduped on collision); `type` is the kimi-code provider protocol.
// maxContext is conservative (under-reporting only truncates context earlier);
// capabilities always include tool_use — without it the agent can't use tools.
const PROVIDER_PRESETS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', type: 'anthropic', model: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', baseUrl: '', maxContext: 200000, capabilities: ['thinking', 'image_in', 'tool_use'] },
  { id: 'openai', label: 'OpenAI', type: 'openai', model: 'gpt-5', displayName: 'GPT-5', baseUrl: '', maxContext: 200000, capabilities: ['thinking', 'image_in', 'tool_use'] },
  { id: 'google', label: 'Google (Gemini)', type: 'google-genai', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', baseUrl: '', maxContext: 1000000, capabilities: ['thinking', 'image_in', 'tool_use'] },
  { id: 'kimi', label: 'Kimi (API key)', type: 'kimi', model: 'kimi-for-coding', displayName: 'Kimi for Coding', baseUrl: 'https://api.kimi.com/coding/v1', maxContext: 262144, capabilities: ['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use'] },
  { id: 'custom', label: 'OpenAI-compatible (custom)…', type: 'openai', model: '', displayName: '', baseUrl: '', maxContext: 128000, capabilities: ['tool_use'] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** TOML-escape a value as a basic string (with surrounding quotes). */
function tomlStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Pure helper (kept separate for testability): given existing config text,
 * return the new text plus the deduped provider id and model alias.
 */
function buildProviderConfig(text, preset, values) {
  const apiKey = (values.apiKey || '').trim();
  const model = (values.model || '').trim();
  const baseUrl = (values.baseUrl || '').trim();
  const displayName = (values.displayName || '').trim() || model;
  if (!apiKey || !model || (preset.id === 'custom' && !baseUrl)) return null;

  let providerId = preset.id;
  let n = 2;
  while (new RegExp(`^\\[providers\\."?${escapeRegExp(providerId)}"?\\]`, 'm').test(text)) {
    providerId = `${preset.id}-${n++}`;
  }
  let alias = `${providerId}/${model}`;
  n = 2;
  while (new RegExp(`^\\[models\\."?${escapeRegExp(alias)}"?\\]`, 'm').test(text)) {
    alias = `${providerId}/${model}-${n++}`;
  }

  let block = `\n[providers.${tomlStr(providerId)}]\ntype = ${tomlStr(preset.type)}\napi_key = ${tomlStr(apiKey)}\n`;
  if (baseUrl) block += `base_url = ${tomlStr(baseUrl)}\n`;
  block += `\n[models.${tomlStr(alias)}]\nprovider = ${tomlStr(providerId)}\nmodel = ${tomlStr(model)}\nmax_context_size = ${preset.maxContext}\ncapabilities = [ ${preset.capabilities.map(tomlStr).join(', ')} ]\ndisplay_name = ${tomlStr(displayName)}\n`;

  return { text: `${text.trimEnd()}\n${block}`, providerId, alias };
}

async function addApiProviderDialog() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    message: 'Add API Provider',
    detail:
      'Use your own API key instead of (or alongside) your Kimi plan.\n' +
      'The key is stored in plaintext in ~/.kimi-code/config.toml — same as the kimi CLI.',
    buttons: [...PROVIDER_PRESETS.map((p) => p.label), 'Cancel'],
    cancelId: PROVIDER_PRESETS.length,
  });
  if (response >= PROVIDER_PRESETS.length) return;
  showAddProviderWindow(PROVIDER_PRESETS[response]);
}

function showAddProviderWindow(preset) {
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: `Add ${preset.label}`,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  // Safe to inline: presets are our own constants, no user data.
  const presetJson = JSON.stringify(preset).replace(/</g, '\\u003c');
  win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; display: flex; flex-direction: column; gap: 10px; }
    label { font-size: 12px; color: #555; margin-bottom: -6px; }
    input { font-size: 14px; padding: 8px; border-radius: 6px; border: 1px solid #ccc; }
    #buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
    button { padding: 8px 16px; }
    #hint { font-size: 11px; color: #888; }
    #error { color: #c00; font-size: 12px; min-height: 14px; }
  </style>
</head>
<body>
  <label>API key</label>
  <input id="apiKey" type="password" placeholder="Paste your API key" autofocus>
  <label>Model ID</label>
  <input id="model" type="text">
  <label>Display name</label>
  <input id="displayName" type="text">
  <label>Base URL ${preset.id === 'custom' ? '(required)' : '(optional)'}</label>
  <input id="baseUrl" type="text" placeholder="https://…">
  <div id="error"></div>
  <div id="hint">Written to ~/.kimi-code/config.toml; the server restarts afterwards. The key never leaves your machine except to the provider.</div>
  <div id="buttons">
    <button id="cancel">Cancel</button>
    <button id="add">Add Provider</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const preset = ${presetJson};
    const $ = (id) => document.getElementById(id);
    $('model').value = preset.model;
    $('displayName').value = preset.displayName;
    $('baseUrl').value = preset.baseUrl;
    $('cancel').onclick = () => window.close();
    $('add').onclick = () => {
      const values = { apiKey: $('apiKey').value, model: $('model').value, displayName: $('displayName').value, baseUrl: $('baseUrl').value };
      if (!values.apiKey.trim() || !values.model.trim()) { $('error').textContent = 'API key and model ID are required.'; return; }
      if (preset.id === 'custom' && !values.baseUrl.trim()) { $('error').textContent = 'A base URL is required for a custom provider.'; return; }
      $('add').disabled = true;
      ipcRenderer.send('add-provider-submit', { preset, values });
    };
  </script>
</body>
</html>`).toString('base64')}`);
}

async function handleAddProvider({ preset, values }) {
  let text = '';
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    // No config file yet — the blocks below become its whole content.
  }
  const built = buildProviderConfig(text, preset, values);
  if (!built) {
    dialog.showErrorBox('Could not add provider', 'API key, model ID, and (for custom providers) a base URL are required.');
    return;
  }
  try {
    fs.writeFileSync(CONFIG_FILE, built.text);
  } catch (err) {
    dialog.showErrorBox('Could not add provider', `Failed to write ${CONFIG_FILE.replace(os.homedir(), '~')}.\n\n${err.message}`);
    return;
  }
  const displayName = (values.displayName || '').trim() || values.model.trim();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: 'Provider added',
    detail: `${displayName} is now available as ${built.alias}.\n\nSwitch the default model to it now?`,
    buttons: ['Switch to it', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) setDefaultModel(built.alias);
  await restartKimiServer();
  buildMenu(); // pick up the new model in the Model menu
}

// ---------------------------------------------------------------------------
// Kimi server management
// ---------------------------------------------------------------------------

function findKimiBinary() {
  // npm-global first: the native ~/.kimi-code binary lags behind and its daemon
  // may be too old for web login.
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'kimi'),
    path.join(os.homedir(), '.kimi-code', 'bin', 'kimi'),
    path.join(os.homedir(), '.local', 'bin', 'kimi'),
    '/opt/homebrew/bin/kimi',
    '/usr/local/bin/kimi',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const found = execFileSync('/bin/zsh', ['-lc', 'command -v kimi'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  return null;
}

function findInShellPath(cmd) {
  try {
    return execFileSync('/bin/zsh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

let kimiVersionCache = null;

function getKimiVersion(kimiBin) {
  if (kimiVersionCache) return kimiVersionCache;
  const bin = kimiBin || findKimiBinary();
  if (!bin) return '';
  try {
    kimiVersionCache = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    kimiVersionCache = '';
  }
  return kimiVersionCache;
}

/** Pre-0.28 CLI: `kimi server kill` manages a background daemon. 0.28+
 *  replaced it with foreground `kimi web`, and `kimi server …` just exits 1. */
function isLegacyCli(kimiBin) {
  const parts = getKimiVersion(kimiBin).split('.').map((n) => parseInt(n, 10) || 0);
  return parts.length >= 2 && parts[0] === 0 && parts[1] < 28;
}

// Pid of the server this app process spawned (also persisted so a later app
// run can still stop the server it started earlier).
let spawnedServerPid = null;

function isServerUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: kimiPort, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startKimiServer(kimiBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(kimiBin, ['web', '--no-open', '--port', String(kimiPort)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${path.dirname(kimiBin)}:${process.env.PATH || '/usr/bin:/bin'}` },
    });
    child.on('error', reject);
    child.unref();
    if (child.pid) {
      spawnedServerPid = child.pid;
      try {
        fs.writeFileSync(SERVER_PID_FILE(), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
      } catch {
        // best-effort only
      }
    }
    resolve();
  });
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 0.28+ retries a busy port with +1 instead of failing, so a server we just
 * spawned may not be on kimiPort. Look up our child in the instance registry
 * and adopt the port it actually bound. Returns true when a port was adopted.
 */
function adoptSpawnedInstancePort() {
  if (!spawnedServerPid) return false;
  try {
    for (const f of fs.readdirSync(SERVER_INSTANCES_DIR)) {
      let info;
      try {
        info = JSON.parse(fs.readFileSync(path.join(SERVER_INSTANCES_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      if (info && info.pid === spawnedServerPid && info.port && info.port !== kimiPort) {
        kimiPort = info.port;
        return true;
      }
    }
  } catch {
    // registry missing or unreadable
  }
  return false;
}

/** silent: true suppresses modal dialogs — for the background watchdog, where a
 *  popup would be unprompted and unexpected rather than a response to a click. */
async function ensureKimiServer({ silent = false } = {}) {
  if (await isServerUp()) return true;
  const kimiBin = findKimiBinary();
  if (!kimiBin) {
    if (!silent) {
      dialog.showErrorBox(
        'Kimi Code not found',
        'Could not find the "kimi" command. Install Kimi Code first:\n\nnpm install -g @moonshot-ai/kimi-code'
      );
    }
    return false;
  }
  await startKimiServer(kimiBin);
  let up = await waitForServer();
  if (!up && adoptSpawnedInstancePort()) {
    // The server came up on a drifted port (preferred port was busy).
    up = await waitForServer(5000);
  }
  if (!up && !silent) {
    dialog.showErrorBox(
      'Kimi server did not start',
      `The Kimi server did not respond on port ${kimiPort}.\nTry running "kimi doctor" in a terminal, then relaunch.`
    );
  }
  return up;
}

/**
 * Best-effort pid for the server on kimiPort: the child we spawned, the pid
 * file from an earlier app run, the instance registry, then whoever listens
 * on the port. Used to stop foreground (0.28+) servers.
 */
function findServerPid() {
  if (spawnedServerPid) return spawnedServerPid;
  try {
    const saved = JSON.parse(fs.readFileSync(SERVER_PID_FILE(), 'utf8'));
    if (saved && saved.pid) return saved.pid;
  } catch {
    // no pid file
  }
  try {
    for (const f of fs.readdirSync(SERVER_INSTANCES_DIR)) {
      let info;
      try {
        info = JSON.parse(fs.readFileSync(path.join(SERVER_INSTANCES_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      if (info && info.port === kimiPort && info.pid) return info.pid;
    }
  } catch {
    // registry missing or unreadable
  }
  try {
    const out = execFileSync('lsof', ['-ti', `:${kimiPort}`], { encoding: 'utf8', timeout: 5000 }).trim();
    const pid = parseInt(out.split('\n')[0], 10);
    if (pid) return pid;
  } catch {
    // nothing listening
  }
  return null;
}

/**
 * Stop the running Kimi server. Pre-0.28 CLIs ran a background daemon managed
 * by `kimi server kill`; 0.28+ servers are foreground processes stopped via
 * their shutdown endpoint or a signal.
 */
async function stopKimiServerProcess(kimiBin) {
  if (isLegacyCli(kimiBin)) {
    try { execFileSync(kimiBin, ['server', 'kill'], { timeout: 15000 }); } catch { /* may not be running */ }
    return;
  }
  try { await apiRequest('POST', '/api/v1/shutdown'); } catch { /* may already be down */ }
  const deadline = Date.now() + 5000;
  while (await isServerUp()) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!(await isServerUp())) return;
  const pid = findServerPid();
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const termDeadline = Date.now() + 5000;
  while (await isServerUp()) {
    if (Date.now() > termDeadline) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function restartKimiServer() {
  const kimiBin = findKimiBinary();
  if (!kimiBin) return;
  await stopKimiServerProcess(kimiBin);
  await ensureKimiServer();
  if (mainWindow) mainWindow.loadURL(kimiUrlWithToken());
  buildMenu();
  buildTray();
}

// ---------------------------------------------------------------------------
// Server auth token
// ---------------------------------------------------------------------------

function readServerToken() {
  try {
    const token = fs.readFileSync(SERVER_TOKEN_FILE, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function kimiUrlWithToken() {
  const token = readServerToken();
  const base = kimiBaseUrl();
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}

// ---------------------------------------------------------------------------
// Web UI integration
//
// The SPA persists its client-side state in localStorage; the desktop app
// drives it from native menus by writing the same keys and reloading.
// ---------------------------------------------------------------------------

const LS = {
  credential: 'kimi-web.server-credential',
  onboarded: 'kimi-web.onboarded',
  planMode: 'kimi-web.plan-mode',
  swarmMode: 'kimi-web.swarm-mode',
  goalMode: 'kimi-web.goal-mode',
  permission: 'kimi-web.permission',
  notifyComplete: 'kimi-web.notify-on-complete',
  notifyApproval: 'kimi-web.notify-on-approval',
  notifyQuestion: 'kimi-web.notify-on-question',
  soundComplete: 'kimi-web.sound-on-complete',
};

// Cache of the SPA's persisted prefs (key -> raw string), refreshed on load.
let spaState = {};

function jsString(v) {
  return JSON.stringify(String(v));
}

function isOn(v) {
  return v === '1' || v === 'true';
}

/**
 * Persist the server token in the page's localStorage (same shape the web UI
 * writes after accepting a #token fragment). The SPA drops the fragment after
 * first use, so without this any plain reload lands on the token wall.
 *
 * Also seeds desktop-friendly defaults on first run and installs the
 * drag-and-drop file attach handler.
 */
function injectDesktopState(webContents) {
  const statements = [];
  const token = readServerToken();
  if (token) {
    const cred = JSON.stringify({
      version: 1,
      credential: token,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    statements.push(`localStorage.setItem(${jsString(LS.credential)}, ${JSON.stringify(cred)});`);
  }
  // Default notifications on (only when the user never touched the setting).
  for (const key of [LS.notifyComplete, LS.notifyApproval, LS.notifyQuestion]) {
    statements.push(
      `if (localStorage.getItem(${jsString(key)}) === null) localStorage.setItem(${jsString(key)}, 'true');`
    );
  }
  webContents.executeJavaScript(`try { ${statements.join(' ')} } catch {}`).catch(() => {});
  refreshSpaState(webContents);
}

/** Read the SPA's persisted prefs into spaState and refresh the native menu. */
function refreshSpaState(webContents) {
  const keys = Object.values(LS);
  const js = `JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, localStorage.getItem(k)])))`;
  webContents
    .executeJavaScript(js)
    .then((state) => {
      try {
        spaState = JSON.parse(state) || {};
      } catch {
        spaState = {};
      }
      buildMenu();
    })
    .catch(() => {});
}

/** Write one SPA pref and reload so the web UI picks it up (it reads them at boot). */
function setSpaPref(key, value) {
  spaState = { ...spaState, [key]: value };
  buildMenu();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  wc.executeJavaScript(`try { localStorage.setItem(${jsString(key)}, ${jsString(value)}); } catch {}`)
    .catch(() => {})
    .finally(() => {
      if (wc.getURL().startsWith(kimiBaseUrl())) wc.loadURL(kimiUrlWithToken());
    });
}

/**
 * Switch the web UI to a workspace/session. The server has no "activate
 * session" endpoint (POST /sessions/:id/resume was removed) and the SPA
 * keeps its current selection client-side, so the desktop drives the UI the
 * same way the user would: click the workspace row in the sidebar (which
 * opens that workspace's most recent session), then the session row.
 */
function switchToSession(workspaceName, sessionTitle) {
  showMainWindow();
  const wc = mainWindow.webContents;
  const run = () => {
    // Click the row to make the SPA update its "current session", then reload.
    // Re-entering a running session without a reload causes the in-flight
    // message to render twice (snapshot + live stream).
    driveSidebarToSession(workspaceName, sessionTitle);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && wc.getURL().startsWith(kimiBaseUrl())) {
        wc.loadURL(kimiUrlWithToken());
      }
    }, 3500);
  };
  if (wc.getURL().startsWith(kimiBaseUrl())) {
    run();
  } else {
    wc.once('did-finish-load', run);
    wc.loadURL(kimiUrlWithToken());
  }
}

/**
 * Switch the web UI to a session by clicking its sidebar row. Sessions render
 * as `.side .group > .group-sessions > .se` under their workspace group, and
 * clicking a row activates both the workspace and the session (clicking the
 * `.gh` group header only expands/collapses — it does not switch).
 *
 * With a `sessionTitle`, clicks the first row whose text starts with it;
 * without one, clicks the group's first row (sessions sort newest-first —
 * right after "Open Project Folder" that's the session we just created).
 *
 * Also skips clicking if the target row is already active (`.se.on`), so
 * switching to the already-active project does nothing.
 * Polls: the sidebar populates asynchronously after load.
 */
function driveSidebarToSession(workspaceName, sessionTitle) {
  if (!mainWindow || mainWindow.isDestroyed() || !workspaceName) return;
  const js = `(() => {
    const ws = ${jsString(workspaceName.slice(0, 60).toLowerCase())};
    const want = ${jsString((sessionTitle || '').slice(0, 60).toLowerCase())};
    let tries = 0;
    const attempt = () => {
      const groups = [...document.querySelectorAll('.side .group')];
      const g = groups.find((gr) => ((gr.querySelector('.gh') || {}).textContent || '').trim().toLowerCase().includes(ws));
      if (g) {
        const rows = [...g.querySelectorAll('.se')].filter((r) => r.offsetParent);
        const row = want
          ? rows.find((r) => r.textContent.trim().toLowerCase().startsWith(want))
          : rows[0];
        if (row) {
          if (row.classList.contains('on')) return; // already active
          (row.querySelector('.row') || row).click();
        }
      }
      if (++tries < 24) setTimeout(attempt, 500);
    };
    attempt();
  })()`;
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

// ---------------------------------------------------------------------------
// Server / API health + usage helpers
// ---------------------------------------------------------------------------

function healthCheck() {
  return new Promise((resolve) => {
    const token = readServerToken();
    const req = http.get(
      {
        host: '127.0.0.1',
        port: kimiPort,
        path: '/api/v1/healthz',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: 6000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function updateServerHealth() {
  const ok = await healthCheck();
  if (ok) {
    const wasDown = consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD;
    consecutiveHealthFailures = 0;
    recoveryFailureNotified = false;
    serverHealthy = true;
    serverStatusMessage = 'Server OK';
    // Refresh the state the menus mirror (account, MCP servers).
    await refreshAuthState();
    await refreshMcpServers();
    if (wasDown) {
      notifyOK('Kimi Code', 'Reconnected — the Kimi server is responding again.');
    }
  } else {
    consecutiveHealthFailures += 1;
    serverHealthy = false;
    serverStatusMessage = 'Server not responding';
    if (consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD) {
      await attemptServerRecovery();
    }
  }
  buildTray();
  buildMenu();
}

/**
 * The daemon can die while the app is already open and showing a connected
 * window — the app only auto-starts it once, at launch. This runs off the
 * health-check watchdog: once /healthz has missed HEALTH_FAILURE_THRESHOLD
 * checks in a row, try to bring the daemon back and reload the window so the
 * user never has to notice or intervene manually.
 */
async function attemptServerRecovery() {
  const now = Date.now();
  if (now - lastRecoveryAttempt < RECOVERY_COOLDOWN_MS) return;
  lastRecoveryAttempt = now;

  const up = await ensureKimiServer({ silent: true });
  if (up) {
    consecutiveHealthFailures = 0;
    recoveryFailureNotified = false;
    serverHealthy = true;
    serverStatusMessage = 'Server OK (recovered)';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(kimiUrlWithToken());
    }
    notifyOK('Kimi Code', 'The Kimi server had stopped responding — restarted it and reconnected automatically.');
  } else if (!recoveryFailureNotified) {
    recoveryFailureNotified = true;
    notifyOK(
      'Kimi Code — server unreachable',
      'The Kimi server stopped responding and could not be restarted automatically. ' +
        'Try Kimi Code → Restart Kimi Server, or run "kimi doctor" in a terminal.'
    );
  }
}

function notifyOverload(reason) {
  const now = Date.now();
  if (serverBusyUntil > now) return; // already notified recently
  serverBusyUntil = now + 5 * 60 * 1000;
  serverHealthy = false;
  serverStatusMessage = reason;
  buildTray();
  buildMenu();
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    new Notification({
      title: 'Kimi Code — API busy',
      body:
        `${reason}\n` +
        'Requests will retry automatically. Try Model → Kimi for Coding (High Speed), ' +
        'or avoid weekday 07:00–10:00 Portugal time.',
    }).show();
  }
}

async function showUsageDialog() {
  try {
    await ensureKimiServer();
    const data = await apiRequest('GET', '/api/v1/sessions');
    const sessions = sessionItems(data);
    const tokens = sessions.reduce(
      (sum, s) => sum + ((s.usage && s.usage.input_tokens) || 0) + ((s.usage && s.usage.output_tokens) || 0),
      0
    );
    const cost = sessions.reduce((sum, s) => sum + ((s.usage && s.usage.total_cost_usd) || 0), 0);
    const active = sessions.filter((s) => s.status === 'running').length;
    dialog.showMessageBox({
      type: 'info',
      message: 'Plan usage',
      detail:
        `Active sessions: ${active}\n` +
        `Total reported tokens: ${tokens.toLocaleString()}\n` +
        `Total reported cost: $${cost.toFixed(4)}\n\n` +
        'The 5-hour Allegretto budget is shown on the Kimi dashboard:\n' +
        'https://platform.kimi.com\n\n' +
        '(Session usage fields are zero until the server finishes reporting them.)',
      buttons: ['Open Dashboard', 'OK'],
    }).then(({ response }) => {
      if (response === 0) shell.openExternal('https://platform.kimi.com');
    });
  } catch (err) {
    dialog.showErrorBox('Could not load usage', err.message);
  }
}

/** Map a workspace id to its display name via the REST API. */
async function workspaceNameById(workspaceId) {
  try {
    const data = await apiRequest('GET', '/api/v1/workspaces');
    const list = Array.isArray(data) ? data : (data && (data.items || data.workspaces)) || [];
    const ws = list.find((w) => w.id === workspaceId);
    return (ws && (ws.name || ws.root)) || null;
  } catch {
    return null;
  }
}

/** The sessions endpoint wraps its list in { items: [...] }. */
function sessionItems(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.sessions)) return data.sessions;
  return [];
}

// ---------------------------------------------------------------------------
// Kimi REST API
// ---------------------------------------------------------------------------

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const token = readServerToken();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: kimiPort,
        path: apiPath,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.code === 0) resolve(parsed.data);
            else reject(new Error(parsed.msg || `API error ${parsed.code}`));
          } catch {
            reject(new Error(`Unexpected API response (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Extra CLI features: stop server, diagnostics, quick prompt, sessions
// ---------------------------------------------------------------------------

async function stopKimiServer() {
  const kimiBin = findKimiBinary();
  if (!kimiBin) {
    dialog.showErrorBox('Kimi Code not found', 'Could not find the "kimi" command.');
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Stop Server', 'Cancel'],
    defaultId: 1,
    message: 'Stop the Kimi server?',
    detail: 'The server is shared with the kimi CLI. You can restart it from the Kimi Code menu.',
  });
  if (response !== 0) return;
  try {
    await stopKimiServerProcess(kimiBin);
    if (await isServerUp()) {
      dialog.showErrorBox('Could not stop server', 'The Kimi server is still responding. Try restarting the app or run "kimi doctor" in a terminal.');
      return;
    }
    dialog.showMessageBox({ type: 'info', message: 'Kimi server stopped', buttons: ['OK'] });
  } catch (err) {
    dialog.showErrorBox('Could not stop server', String(err.message || err).slice(0, 800));
  }
}

async function runDiagnostics() {
  const kimiBin = findKimiBinary();
  if (!kimiBin) {
    dialog.showErrorBox('Kimi Code not found', 'Could not find the "kimi" command.');
    return;
  }
  let output = '';
  try {
    output = execFileSync(kimiBin, ['doctor'], { encoding: 'utf8', timeout: 30000 });
  } catch (err) {
    output = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || err}`.trim();
  }
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; white-space: pre-wrap; word-break: break-word; }
    h2 { margin-top: 0; }
  </style>
</head>
<body>
  <h2>kimi doctor output</h2>
  <div>${output.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
</body>
</html>`;
  const win = new BrowserWindow({
    width: 700,
    height: 500,
    title: 'Kimi Doctor',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
}

async function showQuickPromptResult(text) {
  const kimiBin = findKimiBinary();
  if (!kimiBin) {
    dialog.showErrorBox('Kimi Code not found', 'Could not find the "kimi" command.');
    return;
  }
  const model = getDefaultModel();
  const win = new BrowserWindow({
    width: 700,
    height: 500,
    title: 'Quick Prompt Result',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; white-space: pre-wrap; word-break: break-word; }
    .prompt { color: #666; margin-bottom: 12px; font-style: italic; }
  </style>
</head>
<body>
  <div class="prompt">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
  <div id="out">Running kimi -p ... -m ${model.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))} …</div>
</body>
</html>`).toString('base64')}`);
  execFile(kimiBin, ['-p', text, '-m', model, '--output-format', 'text'], { encoding: 'utf8', timeout: 300000, shell: false }, (err, stdout, stderr) => {
    const result = err
      ? `${stderr || ''}\n${err.message || err}`.trim()
      : stdout.trim();
    win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; white-space: pre-wrap; word-break: break-word; }
    .prompt { color: #666; margin-bottom: 12px; font-style: italic; }
  </style>
</head>
<body>
  <div class="prompt">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
  <div>${result.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
</body>
</html>`).toString('base64')}`);
  });
}

function quickPrompt() {
  const model = getDefaultModel();
  const win = new BrowserWindow({
    width: 600,
    height: 160,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Quick Prompt',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; display: flex; flex-direction: column; gap: 12px; }
    input { flex: 1; font-size: 14px; padding: 8px; border-radius: 6px; border: 1px solid #ccc; }
    button { align-self: flex-end; padding: 8px 16px; }
    #hint { font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <input id="prompt" type="text" placeholder="Ask Kimi something…" autofocus>
  <div id="hint">Runs: kimi -p "..." -m ${model.replace(/"/g, '&quot;')}</div>
  <button id="run">Run</button>
  <script>
    const { ipcRenderer } = require('electron');
    const input = document.getElementById('prompt');
    const run = () => { const v = input.value.trim(); if (v) { ipcRenderer.send('quick-prompt-run', v); window.close(); } };
    document.getElementById('run').onclick = run;
    input.onkeydown = (e) => { if (e.key === 'Enter') run(); };
    input.focus();
  </script>
</body>
</html>`).toString('base64')}`);
}

async function recentSessions() {
  try {
    await ensureKimiServer();
    const data = await apiRequest('GET', '/api/v1/sessions');
    const sessions = sessionItems(data);
    if (sessions.length === 0) return [{ label: 'No Recent Sessions', enabled: false }];
    return sessions.slice(0, 10).map((s) => ({
      label: s.title || s.id || 'Untitled session',
      click: () => resumeSession(s),
    }));
  } catch (err) {
    return [{ label: `Could not load sessions (${err.message})`, enabled: false }];
  }
}

/**
 * Switch the main window to a session. The server has no "activate session"
 * endpoint (POST /sessions/:id/resume was removed), so this drives the web
 * UI's own client-side selection: point it at the session's workspace, then
 * click the session's sidebar row.
 */
async function resumeSession(session) {
  try {
    await ensureKimiServer();
    if (session && session.workspace_id) {
      const wsName = await workspaceNameById(session.workspace_id);
      switchToSession(wsName, session.title);
    } else {
      showMainWindow();
      if (mainWindow) mainWindow.loadURL(kimiUrlWithToken());
    }
  } catch (err) {
    dialog.showErrorBox('Could not resume session', `${session && session.id}\n\n${err.message}`);
  }
}

async function resumeSessionDialog() {
  try {
    await ensureKimiServer();
    const data = await apiRequest('GET', '/api/v1/sessions');
    const sessions = sessionItems(data);
    if (sessions.length === 0) {
      dialog.showMessageBox({ type: 'info', message: 'No recent sessions', buttons: ['OK'] });
      return;
    }
    const labels = sessions.slice(0, 15).map((s) => s.title || s.id || 'Untitled session');
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: labels,
      message: 'Resume a recent session',
      detail: 'Selecting a session will switch the main window to it.',
    });
    if (response >= 0 && response < sessions.length) {
      await resumeSession(sessions[response]);
    }
  } catch (err) {
    dialog.showErrorBox('Could not load sessions', err.message);
  }
}

/** Export a session as a ZIP via `kimi export`, then reveal it in Finder. */
async function exportSessionDialog() {
  const kimiBin = findKimiBinary();
  if (!kimiBin) {
    dialog.showErrorBox('Kimi Code not found', 'Could not find the "kimi" command.');
    return;
  }
  try {
    await ensureKimiServer();
    const data = await apiRequest('GET', '/api/v1/sessions');
    const sessions = sessionItems(data);
    if (sessions.length === 0) {
      dialog.showMessageBox({ type: 'info', message: 'No sessions to export', buttons: ['OK'] });
      return;
    }
    const labels = sessions.slice(0, 15).map((s) => s.title || s.id || 'Untitled session');
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: labels,
      message: 'Export a session',
      detail: 'The session is saved as a ZIP archive (transcript, metadata, logs).',
    });
    if (response < 0 || response >= sessions.length) return;
    const session = sessions[response];
    const base =
      (session.title || 'session')
        .slice(0, 50)
        .replace(/[^a-z0-9-_ ]/gi, '')
        .trim()
        .replace(/\s+/g, '-') || 'session';
    const save = await dialog.showSaveDialog({
      title: 'Export Session',
      buttonLabel: 'Export',
      defaultPath: `${base}.zip`,
    });
    if (save.canceled || !save.filePath) return;
    execFile(kimiBin, ['export', session.id, '-o', save.filePath, '-y'], { timeout: 60000 }, (err, _stdout, stderr) => {
      if (err) {
        dialog.showErrorBox('Export failed', String(stderr || err.message).slice(0, 800));
        return;
      }
      shell.showItemInFolder(save.filePath);
    });
  } catch (err) {
    dialog.showErrorBox('Could not load sessions', err.message);
  }
}

function openSessionVisualizer() {
  const kimiBin = findKimiBinary();
  if (!kimiBin) {
    dialog.showErrorBox('Kimi Code not found', 'Could not find the "kimi" command.');
    return;
  }
  execFile(kimiBin, ['vis'], { timeout: 15000 }, (err) => {
    if (err) dialog.showErrorBox('Could not open visualizer', String(err.message || err).slice(0, 800));
  });
}

// ---------------------------------------------------------------------------
// Dashboard actions (session actions, nudge, tasks, workspaces, account, MCP)
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function notifyOK(title, body) {
  const { Notification } = require('electron');
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

/** Pick a session via a button dialog. query e.g. '?status=running' / '?archived_only=true'. */
async function pickSession({ message, detail, query = '' }) {
  await ensureKimiServer();
  const data = await apiRequest('GET', `/api/v1/sessions${query}`);
  const sessions = sessionItems(data);
  if (sessions.length === 0) {
    dialog.showMessageBox({ type: 'info', message: 'No sessions found', detail, buttons: ['OK'] });
    return null;
  }
  const labels = sessions.slice(0, 15).map((s) => s.title || s.id || 'Untitled session');
  const { response } = await dialog.showMessageBox({ type: 'question', buttons: labels, message, detail });
  if (response < 0 || response >= sessions.length) return null;
  return sessions[response];
}

async function sessionAction(session, action) {
  return apiRequest('POST', `/api/v1/sessions/${encodeURIComponent(session.id)}:${action}`);
}

async function abortSessionDialog() {
  try {
    const session = await pickSession({
      message: 'Abort a running session',
      detail: 'Stops the agent currently working in that session.',
      query: '?status=running',
    });
    if (!session) return;
    await sessionAction(session, 'abort');
    notifyOK('Session aborted', session.title || session.id);
  } catch (err) {
    dialog.showErrorBox('Could not abort session', err.message);
  }
}

/** Shared flow for fork/compact/undo/archive/restore: pick a session, POST the action. */
async function sessionActionDialog({ action, message, detail, query, doneTitle, switchToResult }) {
  try {
    const session = await pickSession({ message, detail, query });
    if (!session) return;
    const result = await sessionAction(session, action);
    if (switchToResult && result && result.id && result.workspace_id) {
      await resumeSession(result);
    } else {
      notifyOK(doneTitle, session.title || session.id);
    }
  } catch (err) {
    dialog.showErrorBox(`Could not ${action} session`, err.message);
  }
}

// --- Nudge (steer a session from outside the chat) ---

let nudgeTarget = null;

function showNudgeWindow(session) {
  nudgeTarget = session;
  const title = session.title || session.id || 'session';
  const win = new BrowserWindow({
    width: 600,
    height: 170,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Nudge Session',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.on('closed', () => { nudgeTarget = null; });
  win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; display: flex; flex-direction: column; gap: 12px; }
    input { flex: 1; font-size: 14px; padding: 8px; border-radius: 6px; border: 1px solid #ccc; }
    button { align-self: flex-end; padding: 8px 16px; }
    #hint { font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <input id="prompt" type="text" placeholder="Tell the agent something…" autofocus>
  <div id="hint">To: ${escHtml(title)} — queued behind anything running.</div>
  <button id="send">Send</button>
  <script>
    const { ipcRenderer } = require('electron');
    const input = document.getElementById('prompt');
    const send = () => { const v = input.value.trim(); if (v) { ipcRenderer.send('nudge-submit', v); window.close(); } };
    document.getElementById('send').onclick = send;
    input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
    input.focus();
  </script>
</body>
</html>`).toString('base64')}`);
}

async function nudgeSessionDialog() {
  try {
    const session = await pickSession({
      message: 'Nudge a session',
      detail: 'Sends a short message into that session — queued behind any running prompt, so it steers the agent mid-work.',
    });
    if (session) showNudgeWindow(session);
  } catch (err) {
    dialog.showErrorBox('Could not load sessions', err.message);
  }
}

/** Tray quick path: nudge the most recent session without a picker. */
async function nudgeMostRecent() {
  try {
    await ensureKimiServer();
    const sessions = sessionItems(await apiRequest('GET', '/api/v1/sessions'));
    if (sessions.length === 0) {
      dialog.showMessageBox({ type: 'info', message: 'No sessions to nudge', buttons: ['OK'] });
      return;
    }
    showNudgeWindow(sessions[0]);
  } catch (err) {
    dialog.showErrorBox('Could not load sessions', err.message);
  }
}

// --- Background tasks window ---

let tasksRender = null;

function tasksHtml(rows, error) {
  const esc = escHtml;
  const body = error
    ? `<div class="empty">${esc(error)}</div>`
    : rows.length === 0
      ? '<div class="empty">No background tasks in recent sessions.</div>'
      : rows
          .map(({ session, task }) => {
            const id = task.id || task.task_id || '';
            const desc = task.description || task.command || task.title || task.kind || id;
            const status = task.status || 'unknown';
            const active = /running|pending|progress|queued/i.test(status);
            return `<div class="row">
  <div class="meta">
    <div class="desc">${esc(desc)}</div>
    <div class="sub">${esc(status)} · ${esc((session.title || session.id || '').slice(0, 60))}</div>
  </div>
  ${active && id ? `<button data-s="${esc(session.id)}" data-t="${esc(id)}">Cancel</button>` : ''}
</div>`;
          })
          .join('\n');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #e5e5e5; }
    .desc { font-size: 13px; }
    .sub { font-size: 11px; color: #888; margin-top: 2px; }
    .empty { color: #888; margin-top: 24px; text-align: center; }
    button { padding: 4px 12px; }
    #refresh { float: right; margin-bottom: 8px; }
  </style>
</head>
<body>
  <button id="refresh">Refresh</button>
  <div style="clear:both"></div>
  ${body}
  <script>
    const { ipcRenderer } = require('electron');
    document.getElementById('refresh').onclick = () => ipcRenderer.send('tasks-refresh');
    document.querySelectorAll('button[data-s]').forEach((b) => {
      b.onclick = () => { b.disabled = true; ipcRenderer.send('task-cancel', { sessionId: b.dataset.s, taskId: b.dataset.t }); };
    });
  </script>
</body>
</html>`;
}

async function showBackgroundTasksWindow() {
  const win = new BrowserWindow({
    width: 680,
    height: 520,
    title: 'Background Tasks',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  const render = async () => {
    let rows = [];
    let error = null;
    try {
      await ensureKimiServer();
      const sessions = sessionItems(await apiRequest('GET', '/api/v1/sessions')).slice(0, 8);
      for (const s of sessions) {
        try {
          const data = await apiRequest('GET', `/api/v1/sessions/${encodeURIComponent(s.id)}/tasks`);
          const tasks = Array.isArray(data) ? data : (data && (data.items || data.tasks)) || [];
          for (const t of tasks) rows.push({ session: s, task: t });
        } catch {
          // session may have vanished between calls — skip it
        }
      }
    } catch (err) {
      error = err.message;
    }
    if (win.isDestroyed()) return;
    win.loadURL(`data:text/html;base64,${Buffer.from(tasksHtml(rows, error)).toString('base64')}`);
  };
  tasksRender = render;
  win.on('closed', () => { tasksRender = null; });
  await render();
}

// --- Workspaces ---

async function pickWorkspace(message, detail) {
  await ensureKimiServer();
  const data = await apiRequest('GET', '/api/v1/workspaces');
  const list = Array.isArray(data) ? data : (data && (data.items || data.workspaces)) || [];
  if (list.length === 0) {
    dialog.showMessageBox({ type: 'info', message: 'No workspaces found', buttons: ['OK'] });
    return null;
  }
  const labels = list.slice(0, 15).map((w) => `${w.name || '?'} — ${(w.root || '').replace(os.homedir(), '~')}`);
  const { response } = await dialog.showMessageBox({ type: 'question', buttons: labels, message, detail });
  if (response < 0 || response >= list.length) return null;
  return list[response];
}

/** Small single-field input window; resolves the trimmed text or null. */
let textInputSeq = 0;
function promptForText({ title, label, placeholder = '', initial = '', buttonLabel = 'OK' }) {
  return new Promise((resolve) => {
    const channel = `text-input-${++textInputSeq}`;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const win = new BrowserWindow({
      width: 460,
      height: 180,
      resizable: false,
      maximizable: false,
      minimizable: false,
      title,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    ipcMain.once(channel, (_e, value) => {
      done(typeof value === 'string' && value.trim() ? value.trim() : null);
      if (!win.isDestroyed()) win.close();
    });
    win.on('closed', () => done(null));
    const js = { channel, placeholder, initial, buttonLabel };
    win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; display: flex; flex-direction: column; gap: 10px; }
    label { font-size: 12px; color: #555; }
    input { font-size: 14px; padding: 8px; border-radius: 6px; border: 1px solid #ccc; }
    button { align-self: flex-end; padding: 8px 16px; }
  </style>
</head>
<body>
  <label>${escHtml(label)}</label>
  <input id="v" type="text" autofocus>
  <button id="ok"></button>
  <script>
    const { ipcRenderer } = require('electron');
    const opts = ${JSON.stringify(js).replace(/</g, '\\u003c')};
    const input = document.getElementById('v');
    input.placeholder = opts.placeholder;
    input.value = opts.initial;
    const btn = document.getElementById('ok');
    btn.textContent = opts.buttonLabel;
    const submit = () => ipcRenderer.send(opts.channel, input.value);
    btn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    input.focus();
    input.select();
  </script>
</body>
</html>`).toString('base64')}`);
  });
}

async function renameWorkspaceDialog() {
  try {
    const ws = await pickWorkspace('Rename a workspace', 'The new name shows in the sidebar.');
    if (!ws) return;
    const name = await promptForText({ title: 'Rename Workspace', label: 'New name', initial: ws.name || '', buttonLabel: 'Rename' });
    if (!name) return;
    await apiRequest('PATCH', `/api/v1/workspaces/${encodeURIComponent(ws.id)}`, { name });
    notifyOK('Workspace renamed', name);
  } catch (err) {
    dialog.showErrorBox('Could not rename workspace', err.message);
  }
}

async function removeWorkspaceDialog() {
  try {
    const ws = await pickWorkspace('Remove a workspace', 'Picks the workspace to unregister.');
    if (!ws) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: `Remove “${ws.name || ws.root}”?`,
      detail: 'This only unregisters the workspace from Kimi — the folder and its files stay on disk.',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    await apiRequest('DELETE', `/api/v1/workspaces/${encodeURIComponent(ws.id)}`);
    notifyOK('Workspace removed', ws.name || ws.root);
  } catch (err) {
    dialog.showErrorBox('Could not remove workspace', err.message);
  }
}

// --- Open current project in external apps ---

function openInSubmenu() {
  const dir = prefs.recentProjects[0];
  if (!dir) return [{ label: 'No recent project', enabled: false }];
  const candidates = [
    { label: 'Finder' }, // shell.openPath
    { label: 'Terminal', app: 'Terminal' }, // always present on macOS
    { label: 'iTerm', app: 'iTerm', check: '/Applications/iTerm.app' },
    { label: 'VS Code', app: 'Visual Studio Code', check: '/Applications/Visual Studio Code.app' },
    { label: 'Cursor', app: 'Cursor', check: '/Applications/Cursor.app' },
  ];
  return candidates
    .filter((c) => !c.check || fs.existsSync(c.check))
    .map((c) => ({
      label: c.label,
      click: () => {
        if (c.app) execFile('open', ['-a', c.app, dir], () => {});
        else shell.openPath(dir);
      },
    }));
}

// --- Account (managed provider OAuth status) ---

let authState = null; // { name, status } | null

async function refreshAuthState() {
  try {
    const data = await apiRequest('GET', '/api/v1/auth');
    authState = (data && data.managed_provider) || null;
  } catch {
    authState = null;
  }
}

/** Device-code OAuth re-login, driven from a small native window. */
async function reLoginDialog() {
  try {
    await ensureKimiServer();
    const start = await apiRequest('POST', '/api/v1/oauth/login');
    const url = start && (start.verification_uri || start.verification_url || start.url);
    const code = (start && (start.user_code || start.code)) || '';
    if (!url) throw new Error('Server did not return a verification URL.');
    let done = false;
    const win = new BrowserWindow({
      width: 440,
      height: 250,
      resizable: false,
      maximizable: false,
      minimizable: false,
      title: 'Log in to Kimi',
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.close();
      if (ok) {
        notifyOK('Logged in to Kimi', 'The managed provider is authenticated again.');
      } else if (msg) {
        dialog.showErrorBox('Login did not complete', msg);
      }
    };
    // Closing the window before completion cancels the flow server-side.
    win.on('closed', () => {
      if (!done) {
        done = true;
        apiRequest('DELETE', '/api/v1/oauth/login').catch(() => {});
      }
    });
    win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; text-align: center; }
    #code { font-size: 26px; letter-spacing: 3px; font-weight: 600; margin: 14px 0; }
    #url { font-size: 12px; color: #666; word-break: break-all; }
    button { padding: 8px 16px; margin: 12px 4px 0; }
  </style>
</head>
<body>
  <div>Open this page and enter the code:</div>
  <div id="url">${escHtml(url)}</div>
  <div id="code">${escHtml(code)}</div>
  <button id="open">Copy Code &amp; Open Page</button>
  <button id="cancel">Cancel</button>
  <script>
    const { shell, clipboard } = require('electron');
    document.getElementById('open').onclick = () => {
      clipboard.writeText(${JSON.stringify(code)});
      shell.openExternal(${JSON.stringify(url)});
    };
    document.getElementById('cancel').onclick = () => window.close();
  </script>
</body>
</html>`).toString('base64')}`);
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (done) break;
      try {
        const st = await apiRequest('GET', '/api/v1/oauth/login');
        const status = (st && st.status) || 'pending';
        if (status === 'authenticated') {
          await refreshAuthState();
          buildMenu();
          finish(true);
          break;
        }
        if (status !== 'pending') {
          finish(false, `Login ${status}.`);
          break;
        }
      } catch {
        // transient — keep polling until the deadline
      }
    }
    if (!done) finish(false, 'Login timed out after 5 minutes.');
  } catch (err) {
    dialog.showErrorBox('Could not start login', err.message);
  }
}

// --- MCP servers ---

let mcpServers = []; // [{ id, name, status }]

async function refreshMcpServers() {
  try {
    const data = await apiRequest('GET', '/api/v1/mcp/servers');
    const list = Array.isArray(data) ? data : (data && (data.servers || data.items)) || [];
    mcpServers = list.map((s) => ({
      id: s.id || s.name,
      name: s.name || s.id || 'server',
      status: s.status || s.state || 'unknown',
    }));
  } catch {
    mcpServers = [];
  }
}

function mcpServersSubmenu() {
  const items = mcpServers.length
    ? mcpServers.map((s) => ({
        label: `${s.name} — ${s.status}`,
        click: async () => {
          try {
            await apiRequest('POST', `/api/v1/mcp/servers/${encodeURIComponent(s.id)}:restart`);
            notifyOK('MCP server restarting', s.name);
          } catch (err) {
            dialog.showErrorBox('Could not restart MCP server', err.message);
          }
        },
      }))
    : [{ label: 'No MCP servers configured', enabled: false }];
  return [
    ...items,
    { type: 'separator' },
    ...(mcpServers.length ? [{ label: 'Click a server to restart it', enabled: false }] : []),
    { label: 'Open /mcp-config in Composer', click: () => insertComposerText('/mcp-config ') },
  ];
}

// --- Pending approvals (poll + native notification + decision window) ---

let pendingApprovals = []; // [{ session, approval }]
let notifiedApprovalKeys = new Set();
let notifiedQuestionKeys = new Set();
let lastPendingApprovalCount = 0;
let approvalsWin = null;
let approvalsRender = null;

function approvalSummary({ session, approval }) {
  const tool = approval.tool_name || approval.tool || approval.action || approval.kind || 'Action';
  let what = approval.description || approval.command || approval.pattern || approval.reason || '';
  if (!what) what = JSON.stringify(approval).slice(0, 90);
  return `${tool} — ${what} · ${(session.title || session.id || '').slice(0, 50)}`;
}

/** Poll for sessions awaiting approval/question; notify once per item. */
async function pollPendingItems() {
  if (!serverHealthy) return;
  try {
    const sessions = sessionItems(await apiRequest('GET', '/api/v1/sessions?status=awaiting_approval'));
    const found = [];
    for (const s of sessions.slice(0, 6)) {
      try {
        const data = await apiRequest('GET', `/api/v1/sessions/${encodeURIComponent(s.id)}/approvals?status=pending`);
        const list = Array.isArray(data) ? data : (data && (data.items || data.approvals)) || [];
        for (const a of list) found.push({ session: s, approval: a });
      } catch {
        // session vanished between calls — skip
      }
    }
    pendingApprovals = found;
    const { Notification } = require('electron');
    const currentKeys = new Set(found.map((p) => `${p.session.id}:${p.approval.id}`));
    if (Notification.isSupported()) {
      for (const p of found) {
        const key = `${p.session.id}:${p.approval.id}`;
        if (notifiedApprovalKeys.has(key)) continue;
        notifiedApprovalKeys.add(key);
        const n = new Notification({ title: 'Kimi needs approval', body: approvalSummary(p).slice(0, 180) });
        n.on('click', () => showApprovalsWindow());
        n.show();
      }
    }
    notifiedApprovalKeys = new Set([...notifiedApprovalKeys].filter((k) => currentKeys.has(k)));
    if (found.length !== lastPendingApprovalCount) {
      lastPendingApprovalCount = found.length;
      buildMenu(); // refresh the Pending Approvals count in the Session menu
    }

    // Sessions waiting on an AskUserQuestion answer: notify, click jumps into the chat.
    const questionSessions = sessionItems(await apiRequest('GET', '/api/v1/sessions?status=awaiting_question'));
    const questionKeys = new Set(questionSessions.map((s) => s.id));
    if (Notification.isSupported()) {
      for (const s of questionSessions) {
        if (notifiedQuestionKeys.has(s.id)) continue;
        notifiedQuestionKeys.add(s.id);
        const n = new Notification({
          title: 'Kimi has a question',
          body: (s.title || s.id || 'A session needs an answer').slice(0, 180),
        });
        n.on('click', () => resumeSession(s));
        n.show();
      }
    }
    notifiedQuestionKeys = new Set([...notifiedQuestionKeys].filter((k) => questionKeys.has(k)));
  } catch {
    // server hiccup — next tick retries
  }
}

function approvalsHtml(rows) {
  const esc = escHtml;
  const body = rows.length === 0
    ? '<div class="empty">No pending approvals.</div>'
    : rows
        .map(({ session, approval }) => {
          const aid = approval.id || approval.approval_id || '';
          return `<div class="row">
  <div class="meta">
    <div class="desc">${esc(approvalSummary({ session, approval }))}</div>
    <div class="sub">${esc((session.title || session.id || '').slice(0, 80))}</div>
  </div>
  <div class="btns">
    <button class="ok" data-s="${esc(session.id)}" data-a="${esc(aid)}" data-d="approved">Approve</button>
    <button class="no" data-s="${esc(session.id)}" data-a="${esc(aid)}" data-d="rejected">Reject</button>
    <button class="chat" data-sid="${esc(session.id)}">Chat</button>
  </div>
</div>`;
        })
        .join('\n');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #e5e5e5; }
    .desc { font-size: 13px; }
    .sub { font-size: 11px; color: #888; margin-top: 2px; }
    .empty { color: #888; margin-top: 24px; text-align: center; }
    .btns { display: flex; gap: 6px; flex-shrink: 0; }
    button { padding: 4px 12px; }
    .ok { font-weight: 600; }
    #refresh { float: right; margin-bottom: 8px; }
  </style>
</head>
<body>
  <button id="refresh">Refresh</button>
  <div style="clear:both"></div>
  ${body}
  <script>
    const { ipcRenderer } = require('electron');
    document.getElementById('refresh').onclick = () => ipcRenderer.send('approvals-refresh');
    document.querySelectorAll('button[data-d]').forEach((b) => {
      b.onclick = () => {
        b.parentElement.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        ipcRenderer.send('approval-decide', { sessionId: b.dataset.s, approvalId: b.dataset.a, decision: b.dataset.d });
      };
    });
    document.querySelectorAll('button.chat').forEach((b) => {
      b.onclick = () => ipcRenderer.send('approval-open-chat', b.dataset.sid);
    });
  </script>
</body>
</html>`;
}

async function showApprovalsWindow() {
  if (approvalsWin && !approvalsWin.isDestroyed()) {
    // Window already open — just focus and refresh it.
    approvalsWin.focus();
    if (approvalsRender) approvalsRender();
    return;
  }
  const win = new BrowserWindow({
    width: 680,
    height: 480,
    title: 'Pending Approvals',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  approvalsWin = win;
  const render = async () => {
    await pollPendingItems();
    if (win.isDestroyed()) return;
    win.loadURL(`data:text/html;base64,${Buffer.from(approvalsHtml(pendingApprovals)).toString('base64')}`);
  };
  approvalsRender = render;
  win.on('closed', () => { approvalsRender = null; approvalsWin = null; });
  await render();
}

// --- Browser pane (companion window docked to the right of the main window) ---
//
// NOTE: Electron 33's BrowserWindow does not expose its own webContents view
// via contentView.children, so a true in-window split isn't possible without
// rebuilding the window as BaseWindow + two WebContentsViews. Instead the
// "pane" is a child window that tracks the main window's position and size.

let browserWin = null;

function positionBrowserPane() {
  if (!browserWin || browserWin.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  const paneW = Math.max(420, Math.round(w * 0.45));
  browserWin.setBounds({ x: x + w, y, width: paneW, height: h });
}

function openBrowserPane(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (browserWin && !browserWin.isDestroyed()) {
    browserWin.loadURL(url).catch(() => {});
    browserWin.focus();
    positionBrowserPane();
    return;
  }
  browserWin = new BrowserWindow({
    width: 500,
    height: 800,
    parent: mainWindow,
    title: 'Kimi Browser',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  browserWin.setMenuBarVisibility(false);
  browserWin.webContents.on('did-navigate', (_e, navigatedUrl) => {
    prefs.browserPaneUrl = navigatedUrl;
    savePrefs(prefs);
    buildMenu(); // Back/Forward enabled state
  });
  browserWin.on('closed', () => {
    browserWin = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeListener('move', positionBrowserPane);
      mainWindow.removeListener('resize', positionBrowserPane);
    }
    buildMenu();
  });
  mainWindow.on('move', positionBrowserPane);
  mainWindow.on('resize', positionBrowserPane);
  browserWin.loadURL(url).catch(() => {});
  positionBrowserPane();
  buildMenu();
}

function closeBrowserPane() {
  if (browserWin && !browserWin.isDestroyed()) browserWin.close();
}

function toggleBrowserPane() {
  if (browserWin && !browserWin.isDestroyed()) closeBrowserPane();
  else openBrowserPane(prefs.browserPaneUrl || 'https://moonshotai.github.io/kimi-code/');
}

async function openUrlInPaneDialog() {
  const url = await promptForText({
    title: 'Open URL in Browser Pane',
    label: 'URL',
    placeholder: 'http://localhost:3000',
    initial: prefs.browserPaneUrl || '',
    buttonLabel: 'Open',
  });
  if (!url) return;
  openBrowserPane(/^https?:\/\//i.test(url) ? url : `http://${url}`);
}

function browserPaneSubmenu() {
  const quickLinks = [
    { label: 'Kimi Code Docs', url: 'https://moonshotai.github.io/kimi-code/' },
    { label: 'Kimi Platform Dashboard', url: 'https://platform.kimi.com' },
    { label: 'localhost:3000', url: 'http://localhost:3000' },
    { label: 'localhost:5173', url: 'http://localhost:5173' },
    { label: 'localhost:8080', url: 'http://localhost:8080' },
  ];
  const open = browserWin && !browserWin.isDestroyed();
  const nav = open ? browserWin.webContents.navigationHistory : null;
  return [
    { label: 'Open URL…', click: openUrlInPaneDialog },
    { type: 'separator' },
    ...quickLinks.map((l) => ({ label: l.label, click: () => openBrowserPane(l.url) })),
    { type: 'separator' },
    { label: 'Back', enabled: !!(nav && nav.canGoBack()), click: () => nav && nav.goBack() },
    { label: 'Forward', enabled: !!(nav && nav.canGoForward()), click: () => nav && nav.goForward() },
    { label: 'Close Pane', enabled: !!open, click: closeBrowserPane },
  ];
}

// --- Embedded terminal (PTY created via REST, streamed over WebSocket) ---

let terminalWin = null;
let terminalWs = null;
let terminalSession = null;
let terminalId = null;
let wsMsgSeq = 0;

function wsSend(type, payload) {
  if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
    terminalWs.send(JSON.stringify({ type, id: `d${++wsMsgSeq}`, payload }));
  }
}

function closeTerminalPty() {
  if (terminalWs && terminalSession && terminalId && terminalWs.readyState === WebSocket.OPEN) {
    wsSend('terminal_close', { session_id: terminalSession.id, terminal_id: terminalId });
    const ws = terminalWs;
    setTimeout(() => { try { ws.close(); } catch {} }, 200);
  } else if (terminalWs) {
    try { terminalWs.close(); } catch {}
  }
  terminalWs = null;
  terminalId = null;
  terminalSession = null;
}

async function openTerminalWindow() {
  if (terminalWin && !terminalWin.isDestroyed()) {
    terminalWin.focus();
    return;
  }
  try {
    await ensureKimiServer();
    const sessions = sessionItems(await apiRequest('GET', '/api/v1/sessions'));
    if (sessions.length === 0) {
      dialog.showMessageBox({ type: 'info', message: 'No sessions yet — open a project first.', buttons: ['OK'] });
      return;
    }
    terminalSession = sessions[0];
  } catch (err) {
    dialog.showErrorBox('Could not open terminal', err.message);
    return;
  }
  terminalWin = new BrowserWindow({
    width: 780,
    height: 500,
    title: `Terminal — ${(terminalSession.title || terminalSession.id || '').slice(0, 40)}`,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  terminalWin.on('closed', () => { terminalWin = null; closeTerminalPty(); });
  terminalWin.loadFile(path.join(__dirname, 'terminal.html'));
}

/** Create the PTY and attach the WebSocket once the renderer reports its size. */
async function startTerminal(cols, rows) {
  if (!terminalSession || terminalId) return;
  try {
    const data = await apiRequest('POST', `/api/v1/sessions/${encodeURIComponent(terminalSession.id)}/terminals`, {
      cols,
      rows,
      shell: '/bin/zsh',
    });
    terminalId = data.id || data.terminal_id;
    const token = readServerToken();
    terminalWs = new WebSocket(`ws://127.0.0.1:${kimiPort}/api/v1/ws`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    terminalWs.on('open', () => {
      wsSend('client_hello', { client_id: 'kimi-desktop-terminal', subscriptions: [] });
      wsSend('terminal_attach', { session_id: terminalSession.id, terminal_id: terminalId });
    });
    terminalWs.on('message', (raw) => {
      if (!terminalWin || terminalWin.isDestroyed()) return;
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'terminal_output' && m.terminal_id === terminalId) {
          terminalWin.webContents.send('term-data', m.payload.data);
        } else if (m.type === 'terminal_exit' && m.terminal_id === terminalId) {
          terminalWin.webContents.send('term-exit', m.payload && m.payload.exit_code);
        }
      } catch {
        // non-JSON frame — ignore
      }
    });
    const signalError = (msg) => {
      if (terminalWin && !terminalWin.isDestroyed()) terminalWin.webContents.send('term-error', msg);
    };
    terminalWs.on('error', () => signalError('Terminal connection lost.'));
    terminalWs.on('close', () => signalError('Terminal connection closed.'));
  } catch (err) {
    if (terminalWin && !terminalWin.isDestroyed()) terminalWin.webContents.send('term-error', err.message);
  }
}

// --- Settings window (GET/POST /api/v1/config) ---

let settingsCurrent = null;

async function showSettingsWindow() {
  let config;
  try {
    await ensureKimiServer();
    config = await apiRequest('GET', '/api/v1/config');
  } catch (err) {
    dialog.showErrorBox('Could not load settings', err.message);
    return;
  }
  const raw = (config && config.raw) || {};
  settingsCurrent = {
    telemetry: raw.telemetry !== false, // server default: on
    default_permission_mode: raw.default_permission_mode || 'manual',
    default_plan_mode: raw.default_plan_mode === true,
    thinking_enabled: !raw.thinking || raw.thinking.enabled !== false,
  };
  const currentJson = JSON.stringify(settingsCurrent).replace(/</g, '\\u003c');
  const win = new BrowserWindow({
    width: 480,
    height: 460,
    resizable: false,
    title: 'Kimi Code Settings',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; display: flex; flex-direction: column; gap: 14px; }
    .field { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .name { font-size: 13px; }
    .hint { font-size: 11px; color: #888; }
    select { font-size: 13px; padding: 4px; }
    #buttons { display: flex; justify-content: space-between; margin-top: 8px; }
    #status { font-size: 12px; color: #080; min-height: 14px; }
    button { padding: 6px 14px; }
  </style>
</head>
<body>
  <div class="field">
    <div><div class="name">Default permission mode</div><div class="hint">For new sessions</div></div>
    <select id="default_permission_mode">
      <option value="manual">Manual</option>
      <option value="auto">Auto</option>
      <option value="yolo">YOLO</option>
    </select>
  </div>
  <div class="field">
    <div><div class="name">Plan mode by default</div><div class="hint">New sessions start in plan mode</div></div>
    <input id="default_plan_mode" type="checkbox">
  </div>
  <div class="field">
    <div><div class="name">Thinking</div><div class="hint">Extended reasoning on capable models</div></div>
    <input id="thinking_enabled" type="checkbox">
  </div>
  <div class="field">
    <div><div class="name">Telemetry</div><div class="hint">Anonymous usage stats to Kimi</div></div>
    <input id="telemetry" type="checkbox">
  </div>
  <div id="status"></div>
  <div class="hint">Models, providers and API keys live in the Model menu. Applies to new sessions; no restart needed.</div>
  <div id="buttons">
    <button id="open">Open config.toml</button>
    <button id="save">Save</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const current = ${currentJson};
    const $ = (id) => document.getElementById(id);
    $('default_permission_mode').value = current.default_permission_mode;
    $('default_plan_mode').checked = current.default_plan_mode;
    $('thinking_enabled').checked = current.thinking_enabled;
    $('telemetry').checked = current.telemetry;
    $('open').onclick = () => ipcRenderer.send('settings-open-config');
    $('save').onclick = () => {
      $('save').disabled = true;
      ipcRenderer.send('settings-save', {
        default_permission_mode: $('default_permission_mode').value,
        default_plan_mode: $('default_plan_mode').checked,
        thinking_enabled: $('thinking_enabled').checked,
        telemetry: $('telemetry').checked,
      });
    };
    ipcRenderer.on('settings-saved', () => { $('status').textContent = 'Saved.'; $('save').disabled = false; });
    ipcRenderer.on('settings-error', (_e, msg) => { $('status').textContent = 'Error: ' + msg; $('save').disabled = false; });
  </script>
</body>
</html>`).toString('base64')}`);
}

// --- Workflows (saved agent runs: skills + goal/swarm/plan modes + local schedule) ---
//
// There is no server-side workflow engine or cron REST route, so a workflow is
// an app-side definition: a project, a prompt, an agent mode, and an optional
// daily time. Running one creates a fresh session in the project and fires the
// prompt with the mode flags (goal_objective / swarm_mode / plan_mode). Daily
// workflows are driven by local timers — they only fire while the app runs.

function workflowList() {
  return prefs.workflows || [];
}

async function runWorkflow(wf) {
  try {
    await ensureKimiServer();
    const session = await apiRequest('POST', '/api/v1/sessions', {
      title: `Workflow: ${wf.name}`,
      metadata: { cwd: wf.cwd },
    });
    const body = { content: [{ type: 'text', text: wf.prompt }] };
    if (wf.mode === 'goal') body.goal_objective = wf.prompt;
    if (wf.mode === 'swarm') body.swarm_mode = true;
    if (wf.mode === 'plan') body.plan_mode = true;
    if (wf.permission && wf.permission !== 'default') body.permission_mode = wf.permission;
    await apiRequest('POST', `/api/v1/sessions/${encodeURIComponent(session.id)}/prompts`, body);
    wf.lastRunAt = new Date().toISOString();
    savePrefs(prefs);
    buildMenu();
    notifyOK('Workflow started', `${wf.name} — running in ${wf.cwd.replace(os.homedir(), '~')}`);
  } catch (err) {
    dialog.showErrorBox('Workflow failed', `${wf.name}\n\n${err.message}`);
  }
}

async function deleteWorkflow(wf) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message: `Delete workflow “${wf.name}”?`,
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  prefs.workflows = workflowList().filter((w) => w.id !== wf.id);
  savePrefs(prefs);
  scheduleWorkflows();
  buildMenu();
}

// --- Local daily scheduler ---

let workflowTimers = [];

function scheduleWorkflows() {
  for (const t of workflowTimers) clearTimeout(t);
  workflowTimers = [];
  for (const wf of workflowList()) {
    if (!wf.schedule || wf.schedule.type !== 'daily' || !/^\d{2}:\d{2}$/.test(wf.schedule.time || '')) continue;
    const [h, m] = wf.schedule.time.split(':').map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    workflowTimers.push(
      setTimeout(() => {
        runWorkflow(wf);
        scheduleWorkflows(); // re-arm for the next day
      }, next.getTime() - Date.now())
    );
  }
}

// --- New workflow form ---

function newWorkflowDialog() {
  const projects = prefs.recentProjects || [];
  if (projects.length === 0) {
    dialog.showMessageBox({
      type: 'info',
      message: 'No projects yet',
      detail: 'Open a project folder first (File → Open Project Folder…), then create a workflow for it.',
      buttons: ['OK'],
    });
    return;
  }
  const projectsJson = JSON.stringify(projects.map((p) => ({ path: p, label: p.replace(os.homedir(), '~') }))).replace(/</g, '\\u003c');
  const win = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    title: 'New Workflow',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(`<!DOCTYPE html>
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
    #error { color: #c00; font-size: 12px; min-height: 14px; }
    .hint { font-size: 11px; color: #888; }
  </style>
</head>
<body>
  <label>Name</label>
  <input id="name" type="text" placeholder="Nightly review" autofocus>
  <label>Project</label>
  <select id="cwd"></select>
  <label>Prompt (what the agent should do)</label>
  <textarea id="prompt" placeholder="Review today's changes, fix anything obviously broken, and summarize what you did."></textarea>
  <label>Agent mode</label>
  <select id="mode">
    <option value="goal">Goal (runs autonomously until done)</option>
    <option value="normal">Normal</option>
    <option value="swarm">Swarm</option>
    <option value="plan">Plan</option>
  </select>
  <label>Permission mode</label>
  <select id="permission">
    <option value="default">Server default</option>
    <option value="manual">Manual</option>
    <option value="auto">Auto</option>
    <option value="yolo">YOLO</option>
  </select>
  <label>Schedule</label>
  <div id="sched">
    <select id="schedule">
      <option value="manual">Manual (run from menu)</option>
      <option value="daily">Daily at</option>
    </select>
    <input id="time" type="time" value="09:00" style="display:none">
  </div>
  <div class="hint">Each run starts a fresh session in the project. Daily runs fire only while the app is open.</div>
  <div id="error"></div>
  <div id="buttons">
    <button id="cancel">Cancel</button>
    <button id="create">Create Workflow</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const projects = ${projectsJson};
    const $ = (id) => document.getElementById(id);
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.label;
      $('cwd').appendChild(opt);
    }
    $('schedule').onchange = () => { $('time').style.display = $('schedule').value === 'daily' ? '' : 'none'; };
    $('cancel').onclick = () => window.close();
    $('create').onclick = () => {
      const wf = {
        name: $('name').value.trim(),
        cwd: $('cwd').value,
        prompt: $('prompt').value.trim(),
        mode: $('mode').value,
        permission: $('permission').value,
        schedule: $('schedule').value === 'daily' ? { type: 'daily', time: $('time').value } : { type: 'manual' },
      };
      if (!wf.name || !wf.prompt) { $('error').textContent = 'Name and prompt are required.'; return; }
      if (wf.schedule.type === 'daily' && !/^\\d{2}:\\d{2}$/.test(wf.schedule.time)) { $('error').textContent = 'Pick a time for the daily run.'; return; }
      $('create').disabled = true;
      ipcRenderer.send('workflow-create', wf);
    };
  </script>
</body>
</html>`).toString('base64')}`);
}

function workflowsSubmenu() {
  const wfs = workflowList();
  return [
    { label: 'New Workflow…', click: newWorkflowDialog },
    { type: 'separator' },
    ...(wfs.length
      ? wfs.map((wf) => ({
          label: wf.name,
          submenu: [
            { label: 'Run Now', click: () => runWorkflow(wf) },
            {
              label: `${wf.mode}${wf.schedule && wf.schedule.type === 'daily' ? ` · daily ${wf.schedule.time}` : ' · manual'}`,
              enabled: false,
            },
            ...(wf.lastRunAt ? [{ label: `Last run: ${new Date(wf.lastRunAt).toLocaleString()}`, enabled: false }] : []),
            { type: 'separator' },
            { label: 'Delete…', click: () => deleteWorkflow(wf) },
          ],
        }))
      : [{ label: 'No workflows yet', enabled: false }]),
  ];
}

// ---------------------------------------------------------------------------
// Composer helpers (attach files, slash commands, MCP)
// ---------------------------------------------------------------------------

/** Insert text into the composer's textarea from the main process. */
function insertComposerText(text) {
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const js = `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return;
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const current = ta.value || '';
    const sep = current && !current.endsWith(' ') && !current.endsWith('\\n') ? ' ' : '';
    set.call(ta, current + sep + ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  })()`;
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

/** Read an image from disk and inject it as a File into the SPA's attach input. */
function injectImageFiles(filePaths) {
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const payloads = filePaths.map((p) => {
    try {
      const data = fs.readFileSync(p);
      const ext = path.extname(p).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime' }[ext] || 'application/octet-stream';
      return { name: path.basename(p), mime, b64: data.toString('base64') };
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (!payloads.length) return;
  const js = `(() => {
    const payloads = ${JSON.stringify(payloads)};
    const files = payloads.map((p) => {
      const bytes = Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0));
      return new File([bytes], p.name, { type: p.mime });
    });
    const input = document.querySelector('input[type="file"][accept*="image"]');
    if (!input) return 'no input';
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'attached';
  })()`;
  wc.executeJavaScript(js).catch(() => {});
}

async function attachFilesDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach files to chat',
    buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const media = [];
  const mentions = [];
  for (const p of result.filePaths) {
    const ext = path.extname(p).toLowerCase();
    if (/\.(png|jpe?g|gif|webp|mp4|mov)$/i.test(ext)) media.push(p);
    else mentions.push(p);
  }
  if (media.length) injectImageFiles(media);
  if (mentions.length) {
    for (const p of mentions) insertComposerText(`@${p} `);
  }
}

async function attachFolderDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach folder to chat',
    buttonLabel: 'Attach',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return;
  for (const p of result.filePaths) insertComposerText(`@${p} `);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function openProjectAt(dir) {
  try {
    await ensureKimiServer();
    const data = await apiRequest('POST', '/api/v1/sessions', { metadata: { cwd: dir } });
    addRecentProject(dir);
    // Point the web UI at the workspace of the session we just created —
    // creating the session alone doesn't make the UI switch to it.
    if (data && data.workspace_id) {
      const wsName = await workspaceNameById(data.workspace_id);
      // No title: the new session sorts first in its workspace group.
      switchToSession(wsName, null);
    } else {
      showMainWindow();
      if (mainWindow) mainWindow.loadURL(kimiUrlWithToken());
    }
  } catch (err) {
    dialog.showErrorBox('Could not open project', `${dir}\n\n${err.message}`);
  }
}

async function openProjectDialog() {
  const result = await dialog.showOpenDialog({
    title: 'Open Project Folder',
    buttonLabel: 'Open in Kimi',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await openProjectAt(result.filePaths[0]);
}

async function newProjectDialog() {
  // Same trick as newSkillFromTemplate: the save dialog doubles as a native
  // "name your folder" prompt. The chosen path is created, then opened.
  const result = await dialog.showSaveDialog({
    title: 'New Project Folder',
    message: 'Type a name for the new project folder',
    buttonLabel: 'Create Project',
    defaultPath: path.join(os.homedir(), 'my-project'),
    nameFieldLabel: 'Project name',
  });
  if (result.canceled || !result.filePath) return;
  const dir = result.filePath;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    dialog.showErrorBox('Could not create project folder', `${dir}\n\n${err.message}`);
    return;
  }
  await openProjectAt(dir);
}

const AGENTS_MD_TEMPLATE = `# Project Instructions

Kimi reads this AGENTS.md file at the start of every session in this project.
Describe anything Kimi should know or rules it should follow when working here.

## About this project

<!-- What is this project? Tech stack, structure, purpose. -->

## Conventions

<!-- Coding style, naming, commit message rules, test commands, etc. -->

## Do / Don't

- Do:
- Don't:
`;

async function addProjectInstructions() {
  const result = await dialog.showOpenDialog({
    title: 'Choose the project folder for AGENTS.md',
    buttonLabel: 'Create AGENTS.md',
    defaultPath: prefs.recentProjects[0],
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const file = path.join(result.filePaths[0], 'AGENTS.md');
  if (!fs.existsSync(file)) fs.writeFileSync(file, AGENTS_MD_TEMPLATE);
  shell.openPath(file);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const SKILL_TEMPLATE = (name) => `---
name: ${name}
description: <one sentence: when should Kimi use this skill? Be specific — this line decides when it triggers.>
---

# ${name}

<!-- Instructions Kimi follows when this skill triggers. Write them like a
     runbook: concrete steps, rules, and examples. Delete this comment. -->

## Steps

1.
2.

## Rules

-
`;

const STARTER_SKILLS = {
  'code-review': `---
name: code-review
description: Use when asked to review code, a diff, or a pull request. Structured review that finds real bugs before style nits.
---

# Code Review

Review code in two passes, in this order. Report findings by severity, worst first.

## Pass 1 — Correctness (this is what matters)

- Trace the happy path end to end: does the code do what it claims?
- Check edge cases: empty input, null/undefined, zero, negative numbers, unicode, very large input.
- Check error handling: what happens when I/O, network, or parsing fails mid-way?
- Check concurrency/state: can this run twice at once? Is shared state mutated?
- Check security basics: injection via user input, secrets in code or logs, unsafe deserialization.

## Pass 2 — Quality (only after correctness)

- Dead code, unused variables, unreachable branches.
- Duplicated logic that already exists elsewhere in the repo.
- Misleading names or comments that lie about behavior.

## Rules

- Every finding needs: file:line, what breaks, and a concrete failure scenario.
- No style nits unless they hide a bug.
- If the code is fine, say so plainly — do not invent findings.
`,
  'commit-messages': `---
name: commit-messages
description: Use when writing git commit messages or asked to commit changes. Produces conventional, reviewable commit messages.
---

# Commit Messages

## Format

\`\`\`
<type>(<scope>): <summary, imperative, ≤72 chars>

<body: WHY the change was made, not what — the diff shows what.>
\`\`\`

Types: feat, fix, refactor, docs, test, chore, perf, build.

## Steps

1. Run \`git diff --staged\` (or \`git diff\`) and read the actual changes — never write a message from memory of the conversation alone.
2. If the diff mixes unrelated changes, say so and suggest splitting into separate commits.
3. Write the summary line from the user's perspective of the codebase, not the session ("fix token refresh race", not "applied requested changes").

## Rules

- Imperative mood: "add", not "added" or "adds".
- No trailing period on the summary line.
- Body wraps at 72 characters.
- Never include tool names, AI mentions, or session details in the message.
`,
};

function ensureStarterSkills() {
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const [name, content] of Object.entries(STARTER_SKILLS)) {
      const dir = path.join(SKILLS_DIR, name);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
  } catch {
    // non-fatal
  }
}

function openSkillsFolder() {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  shell.openPath(SKILLS_DIR);
}

/** Names of installed user skills (folders under SKILLS_DIR containing SKILL.md). */
function listInstalledSkills() {
  try {
    return fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function newSkillFromTemplate() {
  // The save dialog doubles as a native "name your skill" prompt: the chosen
  // basename becomes the skill folder containing SKILL.md.
  const result = await dialog.showSaveDialog({
    title: 'New Skill',
    message: 'Type a short kebab-case name for the new skill',
    buttonLabel: 'Create Skill',
    defaultPath: path.join(SKILLS_DIR, 'my-skill'),
    nameFieldLabel: 'Skill name',
    showsTagField: false,
  });
  if (result.canceled || !result.filePath) return;
  const name = path.basename(result.filePath).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const dir = path.join(SKILLS_DIR, name);
  const file = path.join(dir, 'SKILL.md');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, SKILL_TEMPLATE(name));
  buildMenu(); // pick up the new skill in the Skills menu immediately
  shell.openPath(file);
}

// ---------------------------------------------------------------------------
// Upgrade Kimi Code
// ---------------------------------------------------------------------------

async function upgradeKimi() {
  const npm = findInShellPath('npm');
  if (!npm) {
    dialog.showErrorBox('npm not found', 'Could not find npm in your shell PATH.');
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Upgrade', 'Cancel'],
    defaultId: 0,
    message: 'Upgrade Kimi Code?',
    detail: 'Runs "npm install -g @moonshot-ai/kimi-code@latest", then restarts the Kimi server.',
  });
  if (response !== 0) return;
  execFile(npm, ['install', '-g', '@moonshot-ai/kimi-code@latest'], { timeout: 300000, shell: false }, async (err, stdout, stderr) => {
    if (err) {
      dialog.showErrorBox('Upgrade failed', String(stderr || err.message).slice(0, 800));
      return;
    }
    kimiVersionCache = null; // the binary on disk just changed
    updateState.cliLatest = null;
    updateState.cliInstalled = null;
    await restartKimiServer();
    const kimiBin = findKimiBinary();
    let version = '';
    try { version = execFileSync(kimiBin, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim(); } catch {}
    dialog.showMessageBox({
      type: 'info',
      message: 'Kimi Code upgraded',
      detail: version ? `Now running version ${version}. Server restarted.` : 'Server restarted.',
    });
  });
}

// ---------------------------------------------------------------------------
// Update checking
//
// The app is unsigned, so a silent electron-updater install is not possible
// on macOS (it refuses unsigned bundles). Instead: poll GitHub releases for
// the app and the npm registry for the CLI, then offer the download page or
// the existing upgrade flow.
// ---------------------------------------------------------------------------

const APP_RELEASES_API = 'https://api.github.com/repos/schmoenraad/kimi-desktop/releases/latest';
const CLI_REGISTRY_API = 'https://registry.npmjs.org/@moonshot-ai%2Fkimi-code/latest';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const updateState = { appLatest: null, appUrl: null, cliLatest: null, cliInstalled: null };

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'kimi-code-desktop' }, timeout: 6000 }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        resolve(null); // repo has no published releases yet
        return;
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Unexpected response (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

/** Numeric semver-ish compare: is `latest` newer than `current`? */
function isNewerVersion(latest, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** One-line summary for the app menu, or null when nothing is newer. */
function updateAvailableSummary() {
  const parts = [];
  if (updateState.appLatest && isNewerVersion(updateState.appLatest, app.getVersion())) {
    parts.push(`app ${updateState.appLatest.replace(/^v/, '')}`);
  }
  if (updateState.cliLatest && updateState.cliInstalled && isNewerVersion(updateState.cliLatest, updateState.cliInstalled)) {
    parts.push(`CLI ${updateState.cliLatest}`);
  }
  return parts.length ? `Update available: ${parts.join(' + ')}` : null;
}

async function checkForUpdates({ silent = false } = {}) {
  let appUpdate = null;
  let cliUpdate = null;
  let appReleasesExist = true;
  try {
    const rel = await httpsGetJson(APP_RELEASES_API);
    if (!rel || !rel.tag_name) {
      appReleasesExist = false;
    } else {
      updateState.appLatest = rel.tag_name;
      updateState.appUrl = rel.html_url;
      if (isNewerVersion(rel.tag_name, app.getVersion())) appUpdate = { version: rel.tag_name, url: rel.html_url };
    }
  } catch {
    appReleasesExist = false;
  }
  try {
    const data = await httpsGetJson(CLI_REGISTRY_API);
    const installed = getKimiVersion();
    if (data && data.version) {
      updateState.cliLatest = data.version;
      updateState.cliInstalled = installed || null;
      if (installed && isNewerVersion(data.version, installed)) {
        cliUpdate = { version: data.version, installed };
      }
    }
  } catch {
    // offline or registry hiccup — leave previous state
  }
  prefs.lastUpdateCheck = Date.now();
  savePrefs(prefs);
  buildMenu();

  if (!appUpdate && !cliUpdate) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        message: "You're up to date",
        detail:
          `App: ${app.getVersion()}${updateState.appLatest ? ` (latest ${updateState.appLatest.replace(/^v/, '')})` : appReleasesExist ? '' : ' (no published releases yet)'}\n` +
          `Kimi CLI: ${getKimiVersion() || 'not found'}${updateState.cliLatest ? ` (latest ${updateState.cliLatest})` : ''}`,
        buttons: ['OK'],
      });
    }
    return;
  }

  const lines = [];
  if (appUpdate) lines.push(`Kimi Code Desktop ${appUpdate.version.replace(/^v/, '')} (you have ${app.getVersion()})`);
  if (cliUpdate) lines.push(`Kimi Code CLI ${cliUpdate.version} (you have ${cliUpdate.installed})`);
  if (silent) {
    notifyOK('Kimi Code — update available', lines.join('\n'));
    return;
  }
  const buttons = [];
  if (appUpdate) buttons.push('Download App Update');
  if (cliUpdate) buttons.push('Upgrade CLI');
  buttons.push('Later');
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Updates available',
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (appUpdate && response === 0) {
    shell.openExternal(appUpdate.url);
  } else if (cliUpdate && response === (appUpdate ? 1 : 0)) {
    upgradeKimi();
  }
}

/** Silent background check, at most once every UPDATE_CHECK_INTERVAL_MS. */
function maybeAutoCheckUpdates() {
  if (Date.now() - (prefs.lastUpdateCheck || 0) < UPDATE_CHECK_INTERVAL_MS) return;
  checkForUpdates({ silent: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
  } catch {
    return { width: 1200, height: 800 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(mainWindow.getBounds()));
  } catch {
    // best-effort only
  }
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  app.show();
}

function toggleMainWindow() {
  if (mainWindow && mainWindow.isFocused()) {
    mainWindow.hide();
    app.hide();
  } else {
    showMainWindow();
  }
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 640,
    minHeight: 480,
    title: 'Kimi Code',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox must be off for preload to use webUtils (absolute drop paths).
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      spellcheck: true,
    },
  });

  // Keep the app title instead of the page's <title>, but append the active model.
  const model = loadModels().find((m) => m.alias === getDefaultModel());
  mainWindow.setTitle(model ? `Kimi Code — ${model.displayName}` : 'Kimi Code');
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  // Re-seed desktop state on every load: auth token (reloads never hit the
  // token wall), notification defaults, drag-and-drop attach, menu state.
  mainWindow.webContents.on('dom-ready', () => injectDesktopState(mainWindow.webContents));
  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Native right-click menu with spellcheck suggestions.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => mainWindow.webContents.replaceMisspelling(suggestion) });
    }
    if (items.length) items.push({ type: 'separator' });
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    items.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' }
    );
    Menu.buildFromTemplate(items).popup();
  });

  // Open external links in the default browser; keep the local UI in-app.
  const isLocal = (url) => url.startsWith(`http://127.0.0.1:${kimiPort}`) || url.startsWith(`http://localhost:${kimiPort}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Dropped files resolve to file:// URLs; they're handled in-page by the
    // drop handler (attach to chat), never by navigating away.
    if (url.startsWith('file://')) {
      e.preventDefault();
      return;
    }
    if (!isLocal(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Detect API overload / 429 signals from the renderer so the user knows why
  // the agent paused, instead of staring at a spinner.
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const text = String(message).toLowerCase();
    const isError = level === 3;
    const isWarning = level === 2;
    if ((isError || isWarning) && /429|too many requests|rate limit|overload|capacity/.test(text)) {
      notifyOverload('Kimi reports rate limiting / overload.');
    }
  });

  mainWindow.loadURL(kimiUrlWithToken());
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------

function applyHotkey() {
  globalShortcut.unregister(QUICK_TOGGLE_ACCELERATOR);
  if (prefs.hotkeyEnabled) {
    globalShortcut.register(QUICK_TOGGLE_ACCELERATOR, toggleMainWindow);
  }
}

// ---------------------------------------------------------------------------
// Menus & tray
// ---------------------------------------------------------------------------

function recentProjectsSubmenu() {
  if (prefs.recentProjects.length === 0) {
    return [{ label: 'No Recent Projects', enabled: false }];
  }
  return [
    ...prefs.recentProjects.map((dir) => ({
      label: dir.replace(os.homedir(), '~'),
      click: () => openProjectAt(dir),
    })),
    { type: 'separator' },
    {
      label: 'Clear Recent Projects',
      click: () => { prefs.recentProjects = []; savePrefs(prefs); buildMenu(); buildDockMenu(); },
    },
  ];
}

function buildMenu() {
  const defaultModel = getDefaultModel();
  const models = loadModels();
  const template = [
    {
      label: 'Kimi Code',
      submenu: [
        { role: 'about', label: 'About Kimi Code' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: showSettingsWindow },
        {
          label: 'Quick Access Shortcut (⌥Space)',
          type: 'checkbox',
          checked: prefs.hotkeyEnabled,
          click: (item) => { prefs.hotkeyEnabled = item.checked; savePrefs(prefs); applyHotkey(); },
        },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { label: `Server Status: ${serverStatusMessage}`, enabled: false },
        { label: 'Restart Kimi Server', click: restartKimiServer },
        { label: 'Stop Kimi Server', click: stopKimiServer },
        { label: 'Upgrade Kimi Code…', click: upgradeKimi },
        { label: 'Check for Updates…', click: () => checkForUpdates({ silent: false }) },
        ...(updateAvailableSummary() ? [{ label: updateAvailableSummary(), enabled: false }] : []),
        { type: 'separator' },
        { label: 'Plan Usage…', click: showUsageDialog },
        { type: 'separator' },
        {
          label: authState ? `Account: ${authState.name} (${authState.status})` : 'Account: status unknown',
          enabled: false,
        },
        {
          label: 'Re-login (OAuth)…',
          enabled: !authState || authState.status !== 'authenticated',
          click: reLoginDialog,
        },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Kimi Code' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Kimi Code' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Project Folder…', accelerator: 'Cmd+O', click: openProjectDialog },
        { label: 'New Project Folder…', accelerator: 'Cmd+Shift+N', click: newProjectDialog },
        { label: 'Recent Projects', submenu: recentProjectsSubmenu() },
        { label: 'Open Current Project In', submenu: openInSubmenu() },
        { type: 'separator' },
        { label: 'Attach Files…', accelerator: 'Cmd+U', click: attachFilesDialog },
        { label: 'Attach Folder…', accelerator: 'Cmd+Shift+U', click: attachFolderDialog },
        { type: 'separator' },
        { label: 'Quick Prompt…', accelerator: 'Cmd+Shift+P', click: quickPrompt },
        { type: 'separator' },
        { label: 'Add Project Instructions (AGENTS.md)…', click: addProjectInstructions },
        { label: 'Rename Workspace…', click: renameWorkspaceDialog },
        { label: 'Remove Workspace…', click: removeWorkspaceDialog },
        { type: 'separator' },
        {
          label: 'New Window',
          accelerator: 'Cmd+N',
          click: showMainWindow,
        },
        { role: 'close' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        { label: 'Resume Recent Session…', click: resumeSessionDialog },
        { label: 'Nudge Session…', accelerator: 'Cmd+Shift+M', click: nudgeSessionDialog },
        { label: 'Abort Running Session…', accelerator: 'Cmd+.', click: abortSessionDialog },
        {
          label: pendingApprovals.length ? `Pending Approvals… (${pendingApprovals.length})` : 'Pending Approvals…',
          click: showApprovalsWindow,
        },
        { type: 'separator' },
        {
          label: 'Fork Session…',
          click: () => sessionActionDialog({
            action: 'fork',
            message: 'Fork a session',
            detail: 'Creates a copy of the session and switches to the copy.',
            doneTitle: 'Session forked',
            switchToResult: true,
          }),
        },
        {
          label: 'Compact Session…',
          click: () => sessionActionDialog({
            action: 'compact',
            message: 'Compact a session',
            detail: 'Summarizes the earlier conversation to free up context.',
            doneTitle: 'Session compacted',
          }),
        },
        {
          label: 'Undo Last Turn…',
          click: () => sessionActionDialog({
            action: 'undo',
            message: 'Undo the last turn',
            detail: 'Rolls the session back to before the most recent exchange.',
            doneTitle: 'Turn undone',
          }),
        },
        { type: 'separator' },
        {
          label: 'Archive Session…',
          click: () => sessionActionDialog({
            action: 'archive',
            message: 'Archive a session',
            detail: 'Archived sessions disappear from the sidebar but can be restored.',
            doneTitle: 'Session archived',
          }),
        },
        {
          label: 'Restore Archived Session…',
          click: () => sessionActionDialog({
            action: 'restore',
            message: 'Restore an archived session',
            query: '?archived_only=true',
            doneTitle: 'Session restored',
          }),
        },
        { type: 'separator' },
        { label: 'Background Tasks…', click: showBackgroundTasksWindow },
        { label: 'Terminal…', accelerator: 'Cmd+Shift+T', click: openTerminalWindow },
        { label: 'Export Session…', click: exportSessionDialog },
        { label: 'Open Session Visualizer', click: openSessionVisualizer },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Skills',
      submenu: [
        { label: 'Open Skills Folder', click: openSkillsFolder },
        { label: 'New Skill from Template…', click: newSkillFromTemplate },
        { type: 'separator' },
        // Snapshot of ~/.kimi-code/skills at menu-build time; buildMenu() re-runs
        // after creating a skill, opening a project, etc.
        ...listInstalledSkills().map((name) => ({
          label: name,
          click: () => shell.openPath(path.join(SKILLS_DIR, name, 'SKILL.md')),
        })),
        { type: 'separator' },
        {
          label: 'About Skills',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              message: 'Kimi Skills',
              detail:
                `Skills are reusable instructions Kimi loads automatically when relevant.\n\n` +
                `Each skill is a folder in ${SKILLS_DIR.replace(os.homedir(), '~')} containing a SKILL.md file ` +
                `with a name, a description (which controls when it triggers), and instructions.\n\n` +
                `Two starter skills are installed: code-review and commit-messages. ` +
                `Project-local skills can also live inside a project folder.`,
            }),
        },
      ],
    },
    {
      label: 'Model',
      submenu: [
        ...models.map((m) => ({
          label: m.displayName,
          type: 'radio',
          checked: m.alias === defaultModel,
          click: () => switchModel(m.alias),
        })),
        { type: 'separator' },
        { label: 'Add API Provider…', click: addApiProviderDialog },
        { label: 'Open Model Configuration…', click: () => shell.openPath(CONFIG_FILE) },
      ],
    },
    {
      // Mirrors the composer's own toggles; writes the same localStorage keys
      // the web UI reads at boot, then reloads (see setSpaPref).
      label: 'Agent',
      submenu: [
        ...[
          { key: LS.planMode, label: 'Plan Mode' },
          { key: LS.swarmMode, label: 'Swarm Mode' },
          { key: LS.goalMode, label: 'Goal Mode' },
        ].map((t) => ({
          label: t.label,
          type: 'checkbox',
          checked: isOn(spaState[t.key]),
          click: (item) => setSpaPref(t.key, item.checked ? 'true' : 'false'),
        })),
        { type: 'separator' },
        {
          label: 'Permission Mode',
          submenu: [
            { id: 'manual', label: 'Manual' },
            { id: 'auto', label: 'Auto' },
            { id: 'yolo', label: 'YOLO (approve everything)' },
          ].map((m) => ({
            label: m.label,
            type: 'radio',
            checked: (spaState[LS.permission] || 'manual') === m.id,
            click: () => setSpaPref(LS.permission, m.id),
          })),
        },
        { type: 'separator' },
        {
          label: 'Notifications',
          submenu: [
            { key: LS.notifyComplete, label: 'Notify on Completion' },
            { key: LS.notifyApproval, label: 'Notify When Approval Needed' },
            { key: LS.notifyQuestion, label: 'Notify on Question' },
            { key: LS.soundComplete, label: 'Sound on Completion' },
          ].map((n) => ({
            label: n.label,
            type: 'checkbox',
            checked: isOn(spaState[n.key]),
            click: (item) => setSpaPref(n.key, item.checked ? 'true' : 'false'),
          })),
        },
        { type: 'separator' },
        {
          // Same grouping as Help → Slash Commands…; clicking inserts the
          // command into the composer.
          label: 'Slash Commands',
          submenu: [
            {
              label: 'Sessions',
              submenu: ['/new', '/sessions', '/workspaces', '/fork', '/undo', '/compact', '/clear'].map((c) => ({
                label: c,
                click: () => insertComposerText(`${c} `),
              })),
            },
            {
              label: 'Agent',
              submenu: ['/plan', '/swarm', '/goal', '/permission', '/auto', '/yolo', '/thinking'].map((c) => ({
                label: c,
                click: () => insertComposerText(`${c} `),
              })),
            },
            {
              label: 'Setup',
              submenu: ['/model', '/providers', '/config', '/status', '/login', '/mcp-config', '/btw', '/help'].map((c) => ({
                label: c,
                click: () => insertComposerText(`${c} `),
              })),
            },
          ],
        },
        { label: 'MCP Servers', submenu: mcpServersSubmenu() },
        { label: 'Providers…', click: () => insertComposerText('/providers ') },
      ],
    },
    {
      label: 'Workflows',
      submenu: workflowsSubmenu(),
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'Cmd+R',
          click: () => { if (mainWindow) mainWindow.loadURL(kimiUrlWithToken()); },
        },
        { role: 'forceReload' },
        {
          label: 'Go Home',
          accelerator: 'Cmd+Shift+H',
          click: () => { if (mainWindow) mainWindow.loadURL(kimiUrlWithToken()); },
        },
        { type: 'separator' },
        {
          label: 'Toggle Browser Pane',
          accelerator: 'Cmd+Shift+B',
          click: toggleBrowserPane,
        },
        { label: 'Browser Pane', submenu: browserPaneSubmenu() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Run Diagnostics (kimi doctor)',
          click: runDiagnostics,
        },
        {
          label: 'Slash Commands…',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              message: 'Slash commands',
              detail:
                'Type / in the composer to browse all commands.\n\n' +
                'Sessions:  /new  /sessions  /workspaces  /fork  /undo  /compact  /clear\n' +
                'Agent:  /plan  /swarm  /goal  /permission  /auto  /yolo  /thinking\n' +
                'Setup:  /model  /providers  /config  /status  /login  /mcp-config  /btw  /help\n\n' +
                'Attach files with @path — relative to the project folder, or an\n' +
                'absolute path. Dropped files are inserted for you.',
              buttons: ['OK'],
            }),
        },
        { type: 'separator' },
        {
          label: 'Kimi Code Documentation',
          click: () => shell.openExternal('https://moonshotai.github.io/kimi-code/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildDockMenu() {
  if (!app.dock) return;
  app.dock.setMenu(
    Menu.buildFromTemplate([
      { label: 'Open Project Folder…', click: openProjectDialog },
      ...prefs.recentProjects.slice(0, 5).map((dir) => ({
        label: dir.replace(os.homedir(), '~'),
        click: () => openProjectAt(dir),
      })),
    ])
  );
}

function buildTray() {
  const trayIconPath = path.join(__dirname, 'build', 'trayTemplate.png');
  if (!fs.existsSync(trayIconPath)) return;
  const icon = nativeImage.createFromPath(trayIconPath);
  icon.setTemplateImage(true);
  if (!tray) {
    tray = new Tray(icon);
  } else {
    tray.setImage(icon);
  }
  const model = loadModels().find((m) => m.alias === getDefaultModel());
  const status = serverHealthy ? 'OK' : serverStatusMessage;
  tray.setToolTip(model ? `Kimi Code — ${model.displayName}\n${status}` : `Kimi Code\n${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Kimi Code', click: showMainWindow },
      { label: 'Open Project Folder…', click: openProjectDialog },
      { label: 'Nudge Active Session…', click: nudgeMostRecent },
      { type: 'separator' },
      { label: 'Restart Kimi Server', click: restartKimiServer },
      { label: 'Stop Kimi Server', click: stopKimiServer },
      { type: 'separator' },
      { label: 'Quit Kimi Code', click: () => app.quit() },
    ])
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

ipcMain.on('quick-prompt-run', (_event, text) => {
  if (typeof text === 'string' && text.trim()) showQuickPromptResult(text.trim());
});

ipcMain.on('add-provider-submit', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  handleAddProvider(payload).then(() => {
    if (win && !win.isDestroyed()) win.close();
  });
});

// Nudge window -> queue a prompt into the chosen session.
ipcMain.on('nudge-submit', (_event, text) => {
  if (!nudgeTarget || typeof text !== 'string' || !text.trim()) return;
  const target = nudgeTarget;
  nudgeTarget = null;
  apiRequest('POST', `/api/v1/sessions/${encodeURIComponent(target.id)}/prompts`, {
    content: [{ type: 'text', text: text.trim() }],
  })
    .then(() => notifyOK('Nudge sent', target.title || target.id))
    .catch((err) => dialog.showErrorBox('Could not nudge session', err.message));
});

// Background tasks window.
ipcMain.on('task-cancel', async (_event, payload) => {
  try {
    await apiRequest(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(payload.sessionId)}/tasks/${encodeURIComponent(payload.taskId)}:cancel`
    );
  } catch (err) {
    dialog.showErrorBox('Could not cancel task', err.message);
  }
  if (tasksRender) tasksRender();
});

ipcMain.on('tasks-refresh', () => {
  if (tasksRender) tasksRender();
});

// Approvals window.
ipcMain.on('approval-decide', async (_event, payload) => {
  try {
    await apiRequest(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(payload.sessionId)}/approvals/${encodeURIComponent(payload.approvalId)}`,
      { decision: payload.decision }
    );
  } catch (err) {
    dialog.showErrorBox('Could not submit decision', err.message);
  }
  if (approvalsRender) approvalsRender();
});

ipcMain.on('approvals-refresh', () => {
  if (approvalsRender) approvalsRender();
});

ipcMain.on('approval-open-chat', (_event, sessionId) => {
  const found = pendingApprovals.find((p) => p.session.id === sessionId);
  if (found) resumeSession(found.session);
});

// Terminal window.
ipcMain.on('term-ready', (_event, size) => {
  startTerminal(size.cols, size.rows);
});

ipcMain.on('term-input', (_event, data) => {
  if (terminalSession && terminalId && typeof data === 'string') {
    wsSend('terminal_input', { session_id: terminalSession.id, terminal_id: terminalId, data });
  }
});

ipcMain.on('term-resize', (_event, size) => {
  if (terminalSession && terminalId && size.cols > 0 && size.rows > 0) {
    wsSend('terminal_resize', { session_id: terminalSession.id, terminal_id: terminalId, cols: size.cols, rows: size.rows });
  }
});

// Settings window.
ipcMain.on('settings-open-config', () => shell.openPath(CONFIG_FILE));

// New workflow form.
ipcMain.on('workflow-create', (event, wf) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (wf && wf.name && wf.prompt && wf.cwd) {
    prefs.workflows = [...workflowList(), { ...wf, id: `wf-${Date.now()}` }];
    savePrefs(prefs);
    scheduleWorkflows();
    buildMenu();
    notifyOK('Workflow created', wf.schedule && wf.schedule.type === 'daily' ? `${wf.name} — daily at ${wf.schedule.time}` : wf.name);
  }
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.on('settings-save', async (event, values) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const patch = {};
  if (settingsCurrent) {
    if (values.telemetry !== settingsCurrent.telemetry) patch.telemetry = values.telemetry;
    if (values.default_permission_mode !== settingsCurrent.default_permission_mode) {
      patch.default_permission_mode = values.default_permission_mode;
    }
    if (values.default_plan_mode !== settingsCurrent.default_plan_mode) patch.default_plan_mode = values.default_plan_mode;
    if (values.thinking_enabled !== settingsCurrent.thinking_enabled) patch.thinking = { enabled: values.thinking_enabled };
  } else {
    Object.assign(patch, values);
  }
  try {
    if (Object.keys(patch).length) {
      await apiRequest('POST', '/api/v1/config', patch);
      Object.assign(settingsCurrent || {}, values);
    }
    if (win && !win.isDestroyed()) win.webContents.send('settings-saved');
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.send('settings-error', err.message);
  }
});

app.whenReady().then(async () => {
  prefs = loadPrefs();
  ensureStarterSkills();
  buildMenu();
  buildDockMenu();
  buildTray();
  applyHotkey();

  const ok = await ensureKimiServer();
  if (!ok) {
    app.quit();
    return;
  }
  createWindow();

  // Poll server health, reflect it in menus/tray, and auto-recover the
  // daemon (restart + reload the window) if it stops responding.
  updateServerHealth();
  setInterval(updateServerHealth, HEALTH_CHECK_INTERVAL_MS);

  // Check for app/CLI updates in the background (at most once every 24 h).
  maybeAutoCheckUpdates();
  setInterval(maybeAutoCheckUpdates, 6 * 60 * 60 * 1000);

  // Poll for pending approvals/questions more frequently (native notifications).
  pollPendingItems();
  setInterval(pollPendingItems, 8000);

  // Arm timers for daily workflows.
  scheduleWorkflows();

  // Self-test hook (dev only): KIMI_TEST_PANE=1 exercises the browser pane.
  if (process.env.KIMI_TEST_PANE) {
    setTimeout(() => {
      const bail = (msg, code) => { console.error(msg); app.exit(code); };
      try {
        openBrowserPane('https://example.com');
        const pane = browserWin;
        if (!pane) bail('PANE TEST FAILED: pane window was not created', 1);
        const timer = setTimeout(() => bail('PANE TEST TIMEOUT', 1), 15000);
        pane.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          if (pane.isDestroyed()) bail('PANE TEST FAILED: pane closed before load finished', 1);
          console.log(`PANE TEST url=${pane.webContents.getURL()}`);
          const before = pane.getBounds();
          mainWindow.setPosition(120, 120);
          positionBrowserPane(); // 'move' is async on macOS; invoke directly for the test
          const after = pane.getBounds();
          console.log(`PANE TEST before=${JSON.stringify(before)}`);
          console.log(`PANE TEST after-move=${JSON.stringify(after)}`);
          closeBrowserPane();
          setTimeout(() => {
            console.log(`PANE TEST closed=${browserWin === null}`);
            app.quit();
          }, 500);
        });
      } catch (err) {
        bail(`PANE TEST FAILED ${err.stack || err}`, 1);
      }
    }, 3000);
  }

  // Self-test hook (dev only): KIMI_TEST_TERM=1 exercises the embedded terminal.
  if (process.env.KIMI_TEST_TERM) {
    setTimeout(() => {
      const bail = (msg, code) => { console.error(msg); app.exit(code); };
      (async () => {
        try {
          await openTerminalWindow();
          const timer = setTimeout(() => bail('TERM TEST TIMEOUT', 1), 25000);
          // After the WS attach settles, run a marker command in the PTY.
          setTimeout(() => {
            if (terminalSession && terminalId) {
              wsSend('terminal_input', {
                session_id: terminalSession.id,
                terminal_id: terminalId,
                data: 'echo TERM_WIN_OK_$((6*7))\n',
              });
            }
          }, 4000);
          setTimeout(async () => {
            clearTimeout(timer);
            try {
              const buf = await terminalWin.webContents.executeJavaScript('window.__termBuf');
              console.log(buf.includes('TERM_WIN_OK_42') ? 'TERM TEST PASS' : `TERM TEST FAIL buf=${JSON.stringify((buf || '').slice(0, 200))}`);
            } catch (err) {
              console.error('TERM TEST READ FAIL', err);
            }
            if (terminalWin) terminalWin.close();
            setTimeout(() => app.quit(), 500);
          }, 8000);
        } catch (err) {
          bail(`TERM TEST FAILED ${err.stack || err}`, 1);
        }
      })();
    }, 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Mac convention: keep the app running when the window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
