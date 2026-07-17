# Launch posts

Ready to paste. Replace `github.com/schmoenraad/kimi-desktop` if you name the repo
something else. Attach `screenshots/app-hero.png` to the first post of either version.

---

## Option A — single post (simplest)

> Kimi Code ships a great local web UI — as a browser tab.
>
> So I wrapped it in a real Mac app: ⌥Space from anywhere, Dock icon, native
> notifications when the agent needs approval.
>
> Burned ~half my weekly Kimi quota building it 🙂
>
> MIT, unofficial: github.com/schmoenraad/kimi-desktop

*(269 chars, fits the 280 limit — attach `screenshots/app-hero.png`)*

---

## Option B — thread (more reach)

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
> Built with Kimi, on Kimi.
>
> Shipping this nearly maxed my 5-hour budget (94%) more than once and ate ~half my
> 7-day quota.
>
> Half my credits went into it so yours don't have to 🙂

*(optional: attach your quota screenshot here — see the note below before you do)*

**8/**
> The best part is how little code it is. Every feature is a thin call to an API that
> already existed.
>
> If a tool you like ships a localhost server, go read what's on it. It's usually more
> than the UI shows.
>
> MIT, unofficial: github.com/schmoenraad/kimi-desktop

---

## Notes before posting

- **The quota numbers are real** — 93.87% of the 5-hour budget, 47.43% of the 7-day, on
  an Allegretto plan (26.02% of the month). If you round them in a reword, keep them
  honest; "half my credits" is the 7-day figure, not the monthly one.
- **If you attach the quota screenshot**, it shows your plan tier and renewal date
  (2027-01-29). No name, email or account ID is visible, so it's safe enough — but it is
  billing-adjacent, so it's your call rather than a default.
- The repo is **unofficial and not affiliated with Moonshot AI** — that's stated in the
  README and the posts avoid implying otherwise. Worth keeping if you reword.
- The app is **unsigned**; expect "unidentified developer" questions. Answer: right-click
  → Open, or build it yourself from source.
- It's **Apple Silicon only** right now — the most likely first question.
- The 429 numbers are from one morning's testing, not a benchmark. If someone pushes
  back, that's the honest framing.
