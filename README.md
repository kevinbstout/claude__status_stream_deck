# Agent Usage Meter

Live usage limits, spend, and burn rate for Claude Code, on your Stream Deck + dials and touch strip.

**Reads local files only. No network access, no credentials.** The plugin never opens
`.credentials.json`, never touches the keychain or Windows Credential Manager, never reads an API
key, and never contacts Anthropic or anyone else. Everything it shows comes from files Claude Code
already writes to your own disk.

*Not affiliated with or endorsed by Anthropic.*

---

## What it does

Claude Code enforces a rolling 5-hour session limit and a 7-day cap. You normally find out where
you stand by running `/usage` — which means noticing you should, mid-task. This puts the same
numbers on hardware you are already looking at, and adds a pace indicator so you can tell whether
you are on track to hit the wall before the window resets.

## The four actions

| Action | Controller | What it shows |
| --- | --- | --- |
| **Usage Meter** | Dial + key | One metric: session allowance, weekly allowance, allowance burn rate, context, or API cost |
| **Dual Meter** | Dial | Session over weekly, both bars in one slot |
| **Spend Tracker** | Dial + key | API list-price value of local token use, by day / 7 days / month / block |
| **Threshold Alert** | Key | Ambient key: dark, amber, then red as you approach a limit |

### Interactions

- **Rotate** — Usage Meter cycles the metric; Spend Tracker cycles the window
- **Press** — force an immediate refresh
- **Tap** the touch strip — toggle between compact and detailed views
- **Hold** the touch strip — open your usage page in the browser

### The pace indicator

Raw percentage tells you where you are; pace tells you where you are heading. It compares percent
consumed against percent of the window elapsed:

- `▼ easy` — you have headroom
- `● on pace` — consumption is tracking the clock
- `▲ fast` — you are burning faster than the window is passing, and will hit the limit early

Pace needs a reset time to know where the window started. Without one it is hidden rather than
guessed.

### The allowance burn rate

The metric worth putting on a dial. It shows how many percentage points of your plan allowance you
are consuming **per hour**, and — the actual point — **when you would hit the cap** if you carried
on at that rate:

```
Burn · session
              14%/hr
cap in 1h 40m
```

It automatically follows whichever window bites first. If the 5-hour session limit will stop you
before the weekly cap does, it shows the session; if the weekly cap is the binding constraint, it
switches to that. When neither is on course to run out before it resets, it reads `clears the
window` and you can stop worrying.

Nothing in Claude Code shows you this — `/usage` tells you where you stand, not where you are
heading. In the first few minutes of a window there isn't enough elapsed time for the rate to mean
anything, so it reads `warming up` rather than extrapolating from a single request.

### Reset countdowns

The desktop usage record stores no reset times, but the resets are visible in it: the 5-hour window
drops straight to zero in a single sample rather than decaying. So the current block is located by
walking back through the run of non-zero readings, and the reset is **five hours after it opened**.

An inferred countdown is shown with a `~`:

```
~resets 2h 10m
```

It is deliberately one-sided. Usage below half a percent reads as zero, so the first non-zero sample
sits at or after the true start — meaning an inferred reset **runs late, never early**. It cannot
claim a window resets sooner than it does.

Three situations produce no countdown at all, rather than a doubtful one: no active block, a
sampling gap wide enough that the desktop app was clearly closed (two blocks can then look like one),
and a first reading of 3% or more — which means usage accumulated before the first sample, so the
estimate would run late by hours.

Even when the countdown is withheld, the reset is still used to **clip the cap projection**, since
running late only ever makes clipping more conservative. A real reset time from the statusline hook
always takes precedence and is shown without the `~`.

## Where the numbers come from

Your Claude plan allowance is shared across Claude desktop, claude.ai and Claude Code. The plugin
reads two local sources and merges them, taking percentages from whichever is fresher.

**1. Claude desktop's own usage record — no setup required.**

The desktop app maintains `plan-usage-history.json` in its application data folder, sampling both
allowance windows every five minutes:

```json
{ "t": 1784639187219, "u": { "fh": 20, "sd": 2 } }
```

`fh` is the 5-hour window and `sd` the 7-day window, as integer percentages. Because this is the
desktop app's own record, it reflects **everything you do on the plan** — desktop, web and Claude
Code alike. If you work mainly in the desktop or web apps, this is the source that matters, and it
works the moment you install the plugin.

It also gives the burn rate its accuracy: with ten days of five-minute samples, the rate is
*measured* across real history rather than extrapolated from a single reading.

On Windows the plugin probes two locations for this file, because `%APPDATA%\Claude` is a
redirection link when Claude desktop is installed as a packaged app — the real data lives at
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`, and processes that don't resolve the
link see no folder at all.

**2. The Claude Code statusline hook — optional.**

Reports the same percentages but only while Claude Code is running. What it adds is context usage,
the current model, and **exact reset times** — the plugin infers those from sample history otherwise,
but a reported one is always preferred. Install it if you use Claude Code; skip it if you don't.

Neither source involves a network call, an API key, or an OAuth token. Both are plain reads of files
Anthropic's own applications already wrote to your disk.

## What you need

- **A Stream Deck +** for the dials and touch strip. Usage Meter, Spend Tracker and Threshold Alert
  also work as ordinary keys; Dual Meter is dial-only.
- **A Claude Pro or Max subscription.** The allowance percentages only exist for subscribers.
- **Claude desktop, installed and opened at least once** — that is where the usage figures are read
  from.

**Claude Code is not required**, despite what the plugin's subject matter suggests. It is an
optional extra that adds reset countdowns and context usage.

Windows is tested. macOS paths are implemented but unverified.

## Install

1. Download `com.revductive.usage-meter.streamDeckPlugin` from
   [Releases](../../releases) and double-click it.
2. Drag any of the four actions onto a dial or key.
3. Optionally open the action's settings and click **Install hook** to add reset countdowns.

The plugin is sideloaded rather than distributed through the Elgato Marketplace, so Stream Deck may
warn about installing it.

Building from source produces the same file at the repository root:

```bash
npm install
npm run build
npm test
npm run pack
```

`npm run diagnose` prints exactly what the plugin sees on your machine — which sources were found,
parse timings, and the resulting figures. Run it first if a dial shows `--`.

## The statusline hook

Claude Code passes a JSON payload to a user-configured statusline command. That payload is the only
local source of your actual rate-limit percentages, so the plugin ships a small shim that reads it.

**Install** from the Property Inspector patches `~/.claude/settings.json` to add:

```json
{ "statusLine": { "type": "command", "command": "node \"…/statusline-hook.mjs\"", "padding": 0 } }
```

It backs the file up first, to `%APPDATA%\agent-usage-meter\settings.json.bak` (or
`~/.config/agent-usage-meter/` on macOS). **Remove** restores that backup byte for byte.

The shim itself reads stdin, writes the parsed values to `state.json`, and prints a one-line
statusline so you still get one:

```
Opus 4.6  ctx 12%  $0.80  5h 30%  7d 73%
```

### If you already have a statusline

The installer **refuses** rather than overwriting, and shows you your current command in the
Property Inspector. It cannot chain to your existing statusline — chaining would mean spawning a
child process, which this plugin does not do under any circumstance. Merge the shim into your own
script, or remove yours first. Non-destructive by refusal.

### Removing it

Click **Remove** in the Property Inspector. To do it by hand, delete the `statusLine` key from
`~/.claude/settings.json`.

## What works without the hook

Almost everything. Allowance percentages and burn rate come from Claude desktop's record, and API
cost comes from Claude Code's transcripts in `~/.claude/projects/**/*.jsonl`. Only the reset
countdowns, context percentage and model name need the hook.

Limit percentages are never inferred from token counts. Your plan's true denominator is not knowable
locally, and a confidently wrong number is worse than no number — so with neither source available,
limit displays read `--` / `no data` rather than guessing.

## Stale data

Both sources stop when their app does: the statusline fires only while Claude Code renders, and
desktop stops sampling when you quit it. Once the freshest source falls behind, the plugin dims the
display to 40% and draws a small clock glyph (`○` on the touch strip). A frozen number is never
shown as if it were live.

The thresholds differ by source, because their cadences do: five minutes for the statusline, twelve
for desktop — two of its five-minute sampling intervals plus slack, so the normal gap between
samples never reads as staleness.

## API cost is not your bill

**If you are on a Pro or Max plan, the Spend Tracker is not showing money you spent.**

It shows what your local token usage **would have cost on the pay-as-you-go API**, priced at
standard list rates. On a subscription you pay a flat fee, that figure is never billed to you, and
it has nothing to do with your plan allowance. This is why every surface labels it "API" and the
subtitle reads `list price`.

Claude Code's own `/usage` does exactly the same thing, and says the same of it — that for Max and
Pro subscribers "the session cost figure isn't relevant for billing purposes."

It is still worth a dial for two reasons: it is real money if you use an API key or Console
billing, and on a subscription it is a decent proxy for how hard you are working the model — plus a
reminder of what the subscription is saving you.

For where you actually stand against your plan, use the allowance meters and the burn rate.

## Editing `pricing.json`

Claude Code's transcripts do not always carry a pre-computed cost, so API cost is usually estimated
from published rates. Any figure with at least one estimated entry behind it is shown with a
leading `~`.

Rates live in `pricing.json` inside the plugin folder and are **user-maintained** — they were seeded
at build time and will drift. Rates are USD per million tokens:

```json
{ "match": "opus", "rate": { "input": 15, "output": 75, "cacheWrite": 18.75, "cacheRead": 1.5 } }
```

`match` is a case-insensitive substring of the model id; the longest match wins, and `default`
covers anything unmatched. Whole-line `//` comments are stripped before parsing.

Spend windows: **today** is since local midnight, **7 days** is the last seven calendar days
including today, and **month** is since the 1st of the current local month.

## Privacy and security

- **No network calls.** Nothing egresses; there is nothing to intercept. The Property Inspector's
  only socket is the localhost one Stream Deck itself requires to register an inspector.
- **No credential access.** No `.credentials.json`, no keychain, no Credential Manager, no API key.
- **No child processes.** Nothing is spawned or shelled out to.
- **Read-only** on all Claude Code data. The single write is the opt-in `settings.json` patch above,
  which backs up first and is reversible from the Property Inspector.
- **Log hygiene.** Percentages and error types only — never file contents, prompts, project paths,
  or session identifiers.
- `npm run audit:offline` enforces all of this as a build gate.

## Credits

The transcript rollup approach is informed by [`ccusage`](https://ccusage.com), the reference
implementation for parsing agent CLI usage from local JSONL. This plugin ships its own parser and
takes no runtime dependency on it.
