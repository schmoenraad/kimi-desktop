# Launch posts

Ready to paste. Attach `screenshots/app-hero.png` to the first tweet.

---

## Primary — 2 tweets (use this)

**Tweet 1** — 273 chars, attach `screenshots/app-hero.png`

> Kimi Code doesn't have a desktop app yet — so I built one.
>
> Like Claude Desktop, but for Kimi. ⌥Space from anywhere, real Dock icon, native
> notifications when the agent needs approval. No more lost browser tab.
>
> First thing I've properly shipped 🙂
>
> https://github.com/schmoenraad/kimi-desktop

**Tweet 2** (reply to Tweet 1) — 188 chars

> Burnt through a lot of tokens getting this right — not all of them, I'm building a
> game on the side too 😅
>
> It just makes Kimi Code easier to live with day to day.
>
> MIT, unofficial. Enjoy!

## Alternative — single tweet

276 chars, attach `screenshots/app-hero.png`

> Kimi Code doesn't have a desktop app yet — so I built one.
>
> Like Claude Desktop but for Kimi: ⌥Space from anywhere, Dock icon, notifications
> when the agent needs you.
>
> First thing I've properly shipped. Burnt a lot of tokens getting it right 😅 Enjoy!
>
> https://github.com/schmoenraad/kimi-desktop

---

## Longer thread (optional, more technical detail)

**1/**
> Kimi Code ships a genuinely good local web UI.
>
> It's also a browser tab. No Dock icon. Gets buried. Can't tell you the agent has been
> waiting 10 minutes for you to approve `npm install`.
>
> So I built it as a real Mac app. 🧵

*(attach screenshots/app-hero.png)*

**2/**
> The key call: don't rebuild the chat UI.
>
> `kimi web` runs a local REST + WebSocket server on 127.0.0.1. The web UI is just a
> client of it. So the app wraps the *real* UI in a window and spends its effort on what
> a browser tab can't do.
>
> When Kimi ships a feature, I get it free.

**3/**
> What that buys you:
>
> ⌥Space from anywhere
> Menu bar icon
> Native notifications on approvals
> ⌘O — open any folder as a workspace
> ⌘⇧M — nudge a *running* session to steer the agent mid-work
> ⌘⇧T — real PTY terminal
> Workflows: saved agent runs, optional daily

*(attach screenshots/approvals.png)*

**4/**
> Debugging story. One morning every request hung. No error, just silence.
>
> The daemon's wire log had it: every turn fired exactly 3 requests, 65s apart, then died
> quietly. Reproducing against the CLI surfaced what the UI swallowed:
>
> `429 The engine is currently overloaded`

**5/**
> But the shape was the interesting bit:
>
> K3 + small context → ✅ 16s
> K3 + 180k context → ❌ 429 after 3 min
> Highspeed + 180k → ✅ 61s
>
> The pool wasn't down. It was shedding *large-context* requests first. Small prompts
> sailed through while my big session got rejected every time.

**6/**
> Also: I nearly shipped a screenshot with a faked sidebar and a completely real
> conversation in the main pane. Local paths and all.
>
> The capture script now throws if a real workspace name or home path would land in a
> published frame. Don't trust yourself, assert.

**7/**
> Burnt through a lot of tokens getting this right — not all of them, I'm building a
> game on the side too 😅
>
> Half my credits went into it so yours don't have to 🙂

**8/**
> The best part is how little code it is. Every feature is a thin call to an API that
> already existed.
>
> If a tool you like ships a localhost server, go read what's on it. It's usually more
> than the UI shows.
>
> MIT, unofficial: https://github.com/schmoenraad/kimi-desktop

---

## Notes before posting

- The repo is **unofficial and not affiliated with Moonshot AI** — that's stated in the
  README and the posts avoid implying otherwise. Worth keeping if you reword.
- The app is **unsigned**; expect "unidentified developer" questions. Answer: right-click
  → Open, or build it yourself from source.
- It's **Apple Silicon only** right now — the most likely first question.
