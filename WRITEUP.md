# I wanted Kimi Code as a Mac app, so I built one

*A native macOS desktop app for Kimi Code — and what I learned wrapping someone else's
local server.*

---

## The itch

I use [Kimi Code](https://moonshotai.github.io/kimi-code/) daily. It's a genuinely strong
coding agent, and it ships something a lot of people miss: a built-in local web UI. You
run `kimi web`, a browser tab opens, and you get a real chat interface with workspaces,
sessions, tool calls, the works.

But it's a browser tab. Browser tabs get buried behind forty others. They don't have a
Dock icon. They don't survive a restart. They can't ping you when the agent has been
sitting there for ten minutes waiting for you to approve `npm install`.

I wanted the Claude desktop experience — ⌘Space, type the name, there it is — but for
Kimi. So I built it.

## The key decision: don't rebuild the UI

The obvious move is to write a chat client against Kimi's API. That's also the wrong
move. It's weeks of work to get worse than what already exists, and it breaks every time
Kimi ships a feature.

Poking at the daemon showed the better path. `kimi web` runs a local server on
`127.0.0.1:58627` — REST plus WebSocket — and the web UI is just a client of it. Every
capability is already exposed over HTTP:

```
POST /api/v1/sessions              create a session in any folder
POST /api/v1/sessions/{id}/prompts queue a prompt into a running session
GET  /api/v1/sessions/{id}/approvals   what's blocked waiting on you
POST /api/v1/sessions/{id}/terminals   a real PTY
GET  /api/v1/workspaces            projects
```

So the app doesn't reimplement anything. It **wraps the real UI** in a `BrowserWindow`
and spends all of its effort on what a browser tab can't do: OS integration.

```
┌─────────────────────────┐
│  Kimi Code.app          │   menus, ⌥Space, notifications, tray, dialogs
└───────────┬─────────────┘
            │  REST + WebSocket on 127.0.0.1
┌───────────▼─────────────┐
│  kimi web  (daemon)     │   the official server + web UI
└─────────────────────────┘
```

The upside is that the chat experience is always exactly as good as Kimi's, because it
*is* Kimi's. When they ship an improvement, I get it for free. My code is the shell.

## Three problems worth writing down

### 1. The token wall

Newer Kimi daemons protect the local UI with a bearer token, handed over as a URL
fragment: `http://127.0.0.1:58627/#token=…`. Load the bare URL and you get a
"Server token required" wall.

Passing the fragment worked once — then every reload hit the wall again. The SPA reads
the token from the fragment, stores it, and **strips the fragment**. So the app would
authenticate on first load and lock itself out on ⌘R.

The fix: stop treating it as a URL problem. The app reads
`~/.kimi-code/server.token` and writes the credential straight into the page's
localStorage on every `dom-ready`, in the same shape the UI writes itself:

```js
mainWindow.webContents.on('dom-ready', () => injectServerCredential(mainWindow.webContents));
```

Now the token survives reloads, daemon restarts, and rotation.

### 2. "It's stuck" was three retries and a swallowed error

One morning every request started hanging. The UI just… sat there. No error, no
feedback. Congestion? A bug in my wrapper?

The daemon writes a wire log per session (`~/.kimi-code/sessions/**/wire.jsonl`), and it
told the real story. Every turn fired **exactly three requests, ~65 seconds apart, then
died silently**:

```
09:36:39  llm.request   step 4.1
09:37:49  llm.request   step 4.1   ← retry
09:38:57  llm.request   step 4.1   ← retry
          (nothing)
```

Reproducing it against the CLI directly surfaced what the UI had swallowed:

```
provider.rate_limit: 429 The engine is currently overloaded, please try again later
```

Real congestion. But the interesting part was the shape of it:

| Model | Context | Result |
|---|---|---|
| K3 | small | ✅ 16s |
| K3 | 180k | ❌ 429 after ~3 min |
| K2.7 Highspeed | 180k | ✅ 61s |

The pool wasn't down — it was **shedding large-context requests first**. Small prompts
sailed through while my 180k-token session got rejected every time. Same session on the
Highspeed pool worked fine.

Two lessons. One: when a client retries three times at 60s each and then swallows the
error, three minutes of silence is indistinguishable from a hang — surface the retry.
Two: check the wire log before blaming your own code.

### 3. Screenshots leak more than you think

I nearly published a screenshot with a clean, faked sidebar — demo workspaces, nothing
personal — and completely real conversation content in the main pane, including local
paths and half a handover doc.

The capture script now hard fails instead of trusting me:

```js
const strayGroups = groups.filter((g) => !DEMO_WORKSPACES.includes(g));
if (strayGroups.length) throw new Error(`LEAK: non-demo workspaces visible: ${strayGroups}`);
for (const needle of [os.homedir(), os.userInfo().username, '/Users/']) {
  if (body.includes(needle)) throw new Error(`LEAK: frame contains "${needle}"`);
}
```

If a real workspace name or a home path would land in a published frame, the build dies.
A demo seed script creates two throwaway projects and a real conversation in each, so the
shots are authentic app output with nothing personal in them.

## What it does now

- **⌥Space** from anywhere; menu bar icon; native notifications when a session needs approval
- **⌘O** opens any folder as a workspace; recent projects in the Dock menu
- **Nudge (⌘⇧M)** — queue a line into a *running* session to steer the agent mid-work
- **Terminal (⌘⇧T)** — a real PTY attached to the session's workspace
- **Workflows** — saved agent runs (Goal / Swarm / Plan) with an optional daily time
- **Skills** — same `SKILL.md` format as Claude skills, listed in a menu
- **Model menu** — switch models (including K3), bring your own API keys

## Built with Kimi, on Kimi

Fitting detail: this was built almost entirely *by* Kimi Code, *for* Kimi Code. The app
wrapping the agent was written by the agent it wraps.

It wasn't free. Shipping this pushed the 5-hour budget to **94%** more than once — that's
what the 429 investigation above was really about — and burned through roughly **half my
7-day quota** on an Allegretto plan. The irony of hitting rate limits while building a
nicer front-end for the thing rate-limiting you is not lost on me.

Half my credits went into it so yours don't have to. It's MIT — take it.

## Takeaway

The best thing about this project is how little of it there is. Every feature is a thin
call to an API that already existed. The daemon does the hard part; the app just gives it
a Dock icon and a keyboard shortcut.

If a tool you like ships a localhost server, go read what's on it. It's usually more than
the UI shows you.

**Code:** https://github.com/schmoenraad/kimi-desktop — MIT.
Unofficial, not affiliated with Moonshot AI.
