
# AI Dungeon HUD: Time & Calendar (ATS)

A modular HUD for **time and calendar management** in AI Dungeon. It provides:
- Persistent clock with per-turn ticks
- Natural-language (NL) time advancement
- Rich calendar parsing (fixed, recurring, ranges, overnight)
- Auto-updated cards (Time, Calendar, Settings, Names)
- Hidden SYSTEM CONTEXT for LLM (includes Characters & Ages)

> Version: `4.19.10h-patched`

---

## Features
- Clock & time control: `/time set|add|undo`, per-turn tick
- NL parsing: phrases like "after a while", "the next morning", "X hours later"
- Calendar parsing: Holidays, Events, recurring rules, ranges, overnight
- Banner: daily rollover with moon phase, holidays/events
- Alternative calendars: Islamic (tabular), Chinese (approx.)
- Settings & Names cards: toggles and localization
- Characters & Ages: add `DOB: YYYY-MM-DD` to character cards; SYSTEM CONTEXT lists age

---

## File Layout
- **Library.js** – Core engine: clock, NL parser, calendar parsing, banner, moon phase, Islamic/Chinese calendars, settings UI.
- **Input.js** – Input modifier: routes text through ATS input hooks.
- **Output.js** – Output modifier: routes model output through ATS output hook.
- **Context.js** – Context injector: builds SYSTEM CONTEXT (time, calendar, Characters & Ages).

---

## Quick Start
1. Paste the content of `Library.js` into Library .
2. Paste the content of `Input.js` into the Input.
3. Paste the content of `Output.js` into the Output.
4. Paste the content of `Context.js` into the Context.

On first run, ATS auto-creates **Time**, **Calendar**, **Time Settings**, and **Calendar Names** cards.

---

## Changing Standards (Direct Script Editing)

### Change Start Date & Time
Open **Library.js** and locate the ATS state bootstrap block:
```js
state._ats = {
  version: '4.19.10h-patched',
  clock: { year: 2071, month: 8, day: 25, hour: 8, minute: 0, minutesPerTurn: 5, elapsedMinutes: 0 },
  config: { ... }
};
```
Edit the `clock` object to set your desired start date/time:
```js
clock: { year: 2025, month: 11, day: 28, hour: 9, minute: 30, minutesPerTurn: 5, elapsedMinutes: 0 },
```
- `year`: 4-digit year
- `month`: 1–12
- `day`: 1–31
- `hour`: 0–23
- `minute`: 0–59

Save and reload the script in AI Dungeon.

### Change Dawn/Dusk/Morning/Weekend Standards
In the same block, edit the `config` object:
```js
config: {
  dawnHour: 5,
  dawnMinute: 30,
  duskHour: 19,
  duskMinute: 15,
  morningHour: 8,
  weekendStart: { weekday: 6, hour: 9, minute: 0 }, // 0=Sunday, 6=Saturday
  // ...other config...
}
```
Example customization:
```js
config: {
  dawnHour: 4,
  dawnMinute: 45,
  duskHour: 20,
  duskMinute: 10,
  morningHour: 7,
  weekendStart: { weekday: 5, hour: 18, minute: 0 },
}
```
These values affect NL parsing (e.g., "wait until morning", "next weekend") and banner rendering.

---

## Common Commands
```text
/time add 90m
/time undo
/tick on
/tick 10m
/hud banner off
/hud banner events on
/hud moon off
```

---

## Troubleshooting
- NL didn’t advance time? Use verb-led phrasing (e.g., "talk for an hour") or `/time add 1h`.
- Banner missing? Ensure `/hud banner on` and note suppression on report-only turns.

---

## Notes
- ES5-safe, defensive guards throughout
- SYSTEM CONTEXT appended once per turn; not visible to players
