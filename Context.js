/// <reference no-default-lib="true"/>
/// <reference lib="es2022"/>
/* ES5-safe Context injector: minimal, relies on Library.js */

// Build compressed hidden summary for LLM
function buildContextSummary(flavor = 'neutral') {
  var c = ATS.clock;
  var summaryLines = [];
  summaryLines.push("### ATS_CONTEXT ###");
  summaryLines.push("Time: " + c.year + "-" + ATS.utils.pad2(c.month) + "-" + ATS.utils.pad2(c.day) + " " + ATS.utils.pad2(c.hour) + ":" + ATS.utils.pad2(c.minute));
  summaryLines.push("Moon: " + ATS.calendar.describeMoonPhase(c.year, c.month, c.day));
  if (ATS.calendar.today.holidays.length) summaryLines.push("Holidays: " + ATS.calendar.today.holidays.join(","));
  if (ATS.calendar.today.eventsToday.length) summaryLines.push("Events: " + ATS.calendar.today.eventsToday.join(","));
  if (ATS.config.showIslamic) summaryLines.push("Islamic: " + ATS.calendar.describeIslamicLunarLine(c.year, c.month, c.day));
  if (ATS.config.showChinese) summaryLines.push("Chinese: " + ATS.calendar.describeChineseLunisolarApprox(c.year, c.month, c.day));
  summaryLines.push(ATS.memory.getDelta());

  // Characters & Ages (compressed)
  var people = ATS.calendar.collectCharactersWithAge();
  if (people.length) {
    var ages = people.map(p => p.name + ":" + p.age + "(" + p.dobISO + ")");
    summaryLines.push("Ages: " + ages.join(";"));
  }

  var summary = summaryLines.join("|"); // Shorthand pipe-separated for compression
  if (flavor !== 'neutral') summary = "[Flavor: " + flavor + "] " + summary;
  return "ATS_STATE: " + summary;
}

/* Prune old ATS states from text */
function pruneContext(text) {
  // Remove lines starting with old ATS_STATE: (keep only latest)
  var lines = text.split("\n");
  var pruned = [];
  var foundLatest = false;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("ATS_STATE:")) {
      if (!foundLatest) {
        pruned.unshift(lines[i]); // Keep the most recent
        foundLatest = true;
      }
    } else {
      pruned.unshift(lines[i]);
    }
  }
  return pruned.join("\n");
}

/* Context modifier: overwrite or fallback */
function modifier(text) {
  try {
    ATS.memory.pruneOldStates(); // Prune history first

    var summary = buildContextSummary(ATS.config.contextFlavor);

    // Check length for fallback
    if (text.length > ATS.config.context_max_length) {
      // Fallback to author's note for non-essential
      var note = state.authorsnote || "";
      var fallbackSummary = summary.replace(/Islamic.*|Chinese.*/g, ""); // Trim alternatives
      state.authorsnote = note + "\n" + fallbackSummary;
      return { text: text, note: state.authorsnote }; // AI Dungeon supports note updates
    }

    // Prune old states
    text = pruneContext(text);

    // Overwrite or add ATS_CONTEXT
    var atsMarker = "### ATS_CONTEXT ###";
    var atsIndex = text.indexOf(atsMarker);
    if (atsIndex !== -1) {
      // Overwrite existing
      var endIndex = text.indexOf("\n###", atsIndex + 1); // Assume next section
      if (endIndex === -1) endIndex = text.length;
      text = text.slice(0, atsIndex) + summary + text.slice(endIndex);
    } else {
      // Append once
      text += "\n" + summary;
    }
  } catch (_) {}
  return { text: text };
}

/* Export ATS_onContext(text) */
try {
  globalThis.ATS_onContext = function(t) {
    var r = modifier(t);
    return (r && typeof r.text === 'string') ? r.text : t;
  };
} catch (_) {}

/* AI Dungeon wrapper */
const modifierWrapper = function(text) {
  return { text: (typeof globalThis.ATS_onContext === 'function' ? globalThis.ATS_onContext(text) : text) };
};
modifierWrapper(text);
