/// <reference no-default-lib="true"/>
/// <reference lib="es2022"/>
/* ES5-safe Context injector: minimal, relies on Library.js */

// Build hidden summary for LLM
function buildContextSummary() {
  var timeCard = ATS.utils.findCardIndexByMarker("[[ATS:TIME]]");
  var calCard = ATS.utils.findCardIndexByMarker("[[ATS AUTO CONTEXT]]");
  var summary = "### SYSTEM CONTEXT ###\n";
  if (timeCard) { summary += "Current Time & Moon:\n" + ATS.utils.getBodyText(worldInfo[timeCard]).split("\n").slice(0, 6).join("\n") + "\n"; }
  if (calCard) { summary += "Calendar Info:\n" + ATS.utils.getBodyText(worldInfo[calCard]).split("\n").slice(0, 10).join("\n") + "\n"; }

  // Characters & Ages block
  try {
    var people = ATS.calendar.collectCharactersWithAge();
    if (people && people.length) {
      summary += "Characters & Ages:\n";
      for (var i = 0; i < people.length; i++) {
        var p = people[i];
        summary += "- " + p.name + " — age " + p.age + " (DOB " + p.dobISO + ")\n";
      }
    }
  } catch (_) {}

  return summary.trim();
}

/* Context modifier: inject summary for LLM only */
function modifier(text) {
  try {
    var summary = buildContextSummary();
    if (summary && text.indexOf("### SYSTEM CONTEXT ###") === -1) {
      text = text + "\n" + summary;
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
