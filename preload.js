// Preload: desktop bridges into the Kimi web UI.
//
// Runs in an isolated world but shares the DOM with the page, so it can feed
// dropped files into the SPA's own attach/mention flows:
//
//   images/videos  -> the composer's hidden <input type=file> (the SPA
//                     uploads them to /api/v1/files and renders a chip)
//   documents      -> an @-mention in the composer; relative to the active
//                     workspace when possible (resolves to a mention chip),
//                     absolute path otherwise (the agent resolves @/abs/path
//                     in prompt text, same as the CLI)
//   folders        -> same, via webkitGetAsEntry().isDirectory
//
// webUtils.getPathForFile() is the only way to real absolute paths in
// Electron 33+ (File.path was removed); it needs this preload.
const { webUtils } = require('electron');

const WORKSPACES_API = 'http://127.0.0.1:58627/api/v1/workspaces';

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:#26262b;color:#fff;padding:10px 16px;border-radius:8px;' +
    'font:13px -apple-system,BlinkMacSystemFont,sans-serif;z-index:99999;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:.96';
  (document.body || document.documentElement).appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function readCredential() {
  try {
    const raw = localStorage.getItem('kimi-web.server-credential');
    return raw ? JSON.parse(raw).credential : null;
  } catch {
    return null;
  }
}

/** Root path of the workspace currently active in the sidebar (best effort). */
async function activeWorkspaceRoot() {
  const token = readCredential();
  const active = document.querySelector('.side .gh.on');
  const name = ((active && active.textContent) || '').trim();
  if (!token || !name) return null;
  try {
    const res = await fetch(WORKSPACES_API, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    const data = json && json.data;
    const list = Array.isArray(data) ? data : (data && (data.items || data.workspaces)) || [];
    const ws = list.find((w) => (w.name || '') === name);
    return (ws && ws.root) || null;
  } catch {
    return null;
  }
}

/** Append an @-mention to the composer (keeps any existing draft). */
function insertMention(path) {
  const ta = document.querySelector('textarea');
  if (!ta) {
    toast('Open a chat first to attach files.');
    return false;
  }
  const mention = `@${path}`;
  const current = ta.value || '';
  const next = current ? `${current.replace(/\s+$/, '')} ${mention} ` : `${mention} `;
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, next);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return true;
}

/** Feed dropped media into the SPA's hidden file input. */
function attachMedia(files) {
  const input = document.querySelector('input[type="file"][accept*="image"]');
  if (!input) {
    toast('Open a chat first to attach files.');
    return;
  }
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function handleDrop(e) {
  const items = [...(e.dataTransfer.items || [])];
  const media = [];
  const paths = [];
  for (const item of items) {
    const file = item.getAsFile && item.getAsFile();
    if (!file) continue; // dragged text, links, …
    if (/^(image|video)\//.test(file.type)) {
      media.push(file);
      continue;
    }
    let abs = '';
    try {
      abs = webUtils.getPathForFile(file) || '';
    } catch {
      abs = '';
    }
    if (abs) paths.push(abs);
  }

  if (media.length) attachMedia(media);
  if (!paths.length) {
    if (!media.length) toast('Drop files to attach them — images attach directly, everything else becomes an @-mention.');
    return;
  }

  const root = await activeWorkspaceRoot();
  for (const abs of paths) {
    const rel = root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
    insertMention(rel);
  }
}

function install() {
  if (window.__kimiDesktopDropInstalled) return;
  window.__kimiDesktopDropInstalled = true;
  // Capture phase: beat the page's own defaults. preventDefault on dragover is
  // required for drop to fire; preventing drop's default stops navigation to
  // the file:// URL.
  window.addEventListener('dragover', (e) => e.preventDefault(), true);
  window.addEventListener(
    'drop',
    (e) => {
      e.preventDefault();
      handleDrop(e).catch(() => {});
    },
    true
  );
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', install);
} else {
  install();
}
