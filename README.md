
# AI Dungeon HUD: Time & Calendar (ATS)

A modular HUD for **time and calendar management** in AI Dungeon. It provides a persistent clock, natural‑language (NL) time advancement, rich calendar parsing, auto‑updated cards, and a hidden **SYSTEM CONTEXT** that now includes **Characters & Ages** when you add `DOB:` to character cards.

> Core version: `4.19.10h-patched` (engine in `Library.js`).

---

## Repository layout

- **`Library.js`** – Core ATS engine
  - Clock & elapsed tracking; `/time set|add|undo` commands; per‑turn tick
  - NL parser for time advancement (named times, “X hours later”, etc.)
  - Calendar parsing: fixed dates, annual rules (MM‑DD / nth weekday of month), recurring events (`Every ...`), multi‑day ranges, overnight spans
  - Card creation & upkeep (Time, Calendar, Time Settings, Calendar Names) and array order enforcement
  - Daily rollover banner, moon phase, optional Islamic (tabular) and Chinese (approx. lunisolar) lines
  - Settings toggles UI + notes‑only commands list; Names card for localization & aliases
- **`Input.js`** – Input modifier; routes text through `/time` command handler and ATS input hook; returns `{ text }`
- **`Output.js`** – Output modifier; routes model output through ATS output hook; returns `{ text }`
- **`Context.js`** – Context injector; builds hidden **SYSTEM CONTEXT** (time + calendar) and appends **Characters & Ages** derived from `DOB:` lines in character cards (LLM‑only; no visible UI)

---

## Installation & load order

1. Paste **`Library.js`** into a Script slot.
2. Paste **`Input.js`** into the Input Modifier.
3. Paste **`Output.js`** into the Output Modifier.
4. Paste **`Context.js`** into the Context Modifier.

On first run, ATS will auto‑create/refresh the **Time**, **Calendar**, **Time Settings**, and **Calendar Names** cards and enforce their order.

---

## Features

### Clock & controls
- **Per‑turn tick**: `/tick on|off|<N>m|<N>h`
- **Slash commands**: `/time set YYYY-MM-DD HH:MM`, `/time add <N>[m|h|d]`, `/time undo`
- Undo history for NL/tick/command advances

### Natural‑language (NL) time advancement
Recognizes many phrasings (e.g., *“after a while”*, *“the next morning”*, *“X hours later”*, *“time passes”*). Ambiguous durations are limited by a **SMART CAP** unless explicit long units (days/weeks/months/years) are present.

> **Tip:** For consistent advancement, prefer **verb‑led phrasing**, e.g.,
> *“We **spend** an hour talking.”*, *“We **talk for an hour**.”*, *“We **linger for two hours**.”*
>
> Phrases like *“We get to know each other for the next hour”* may not match the current NL patterns because they lack a recognized action verb and “next hour” is not a standalone indicator. Use a verb or `/time add 1h`.

### Calendar parsing & context
- Sections: `-----Holiday-----`, `-----Events-----`, `-----Hours-----` (plain or dashed)
- Holidays: fixed (`YYYY-MM-DD Name`), annual numeric (`Annual: MM-DD Name`), annual nth weekday (`Annual: 1st Sunday of July Name`)
- Events: single‑day (optional `HH:MM–HH:MM`), **overnight** by using end < start, **ranges** `YYYY-MM-DD..YYYY-MM-DD [HH:MM–HH:MM]`, and **recurring** (`Every day/week/month/year ...`)
- Cross‑references **today** to compute holiday names, ordered events, ongoing/next event, and next holiday (with gate)
- Auto‑context header for the LLM (date, time, events, holiday lines)
- Daily banner with long date, time (+ moon emoji), optional holidays/events

### Alternative calendars & moon phase
- Moon phase name, age, illumination + emoji
- Optional Islamic (tabular) and Chinese (approx. lunisolar) lines; toggle via `/hud`

### Settings & Names cards
- **Time Settings**: ON/OFF toggles for banner details and calendars; edit tick minutes inline; notes list all commands
- **Calendar Names**: customize months/weekdays and alias mappings (e.g., `Friyay=Friday`); used by parser & renderers

### NEW: Characters & Ages (LLM‑only)
- Add `DOB: YYYY-MM-DD` in any character card (body or notes)
- The hidden **SYSTEM CONTEXT** includes:
  ```text
  Characters & Ages:
  - <Title> — age <N> (DOB YYYY-MM-DD)
  ```
- Ages are computed from **ATS.clock**; they update with `/time set`, `/time add`, NL advancement, and per‑turn ticks

---

## Common commands

```text
/time set 2071-08-25 08:00
/time add 90m
/time undo
/tick on
/tick 10m
/hud banner off
/hud banner events on
/hud moon off
```

---

## Changing Standards (Start Date, Dawn/Dusk, Morning, Weekend)

### Change Start Date & Time
Use the slash command:
```
/time set YYYY-MM-DD HH:MM
```
Example:
```
/time set 2050-01-01 09:00
```
This sets the in-world clock to your chosen date and time. All age calculations, events, and banners will use this new standard.

### Change Dawn/Dusk & Morning Hour
Defaults:
```
dawnHour: 5
dawnMinute: 30
duskHour: 19
duskMinute: 15
morningHour: 8
weekendStart: { weekday: 6, hour: 9, minute: 0 }
```
To change these:
1. Open the **Time Settings** card.
2. Edit the body lines to include your new values, for example:
```
dawnHour: 4
dawnMinute: 45
duskHour: 20
duskMinute: 10
morningHour: 7
weekendStart: { weekday: 5, hour: 8, minute: 0 }
```
3. Submit a turn; changes apply immediately.

These values affect NL parsing for phrases like "wait until morning" or "next weekend" and banner rendering.

---


## Troubleshooting

- **NL didn’t advance time**: Rephrase with an action verb (e.g., *“talk for an hour”*) or use `/time add 1h`.
- **Banner didn’t print**: It’s suppressed on report‑only turns (after a slash command) and prints on day change; ensure `/hud banner on`.
- **Cards out of order**: The engine calls order enforcement each turn; if you edit cards heavily, a fresh turn will realign them.
