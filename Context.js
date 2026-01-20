/// <reference no-default-lib="true"/>
/// <reference lib="es2022"/>

// Initialize Inner-Self
InnerSelf("context");

// ATS config defaults
(function(){
  try {
    if (!state || !state._ats) return;
    if (!state._ats.config) state._ats.config = {};
    var cfg = state._ats.config;
    if (cfg.dawnHour == null)    cfg.dawnHour    = 5;
    if (cfg.dawnMinute == null)  cfg.dawnMinute  = 30;
    if (cfg.duskHour == null)    cfg.duskHour    = 19;
    if (cfg.duskMinute == null)  cfg.duskMinute  = 15;
    if (cfg.contextFlavor == null) cfg.contextFlavor = 'neutral';
  } catch (_) {}
})();

// ── ATS: Character age helpers ────────────────────────────────────────
function _parseISODateToYMD(s) {
  if (typeof s !== "string") return null;
  s = s.trim();
  if (s.length !== 10 || s.charAt(4) !== "-" || s.charAt(7) !== "-") return null;
  var Y = parseInt(s.slice(0,4), 10),
      M = parseInt(s.slice(5,7), 10),
      D = parseInt(s.slice(8,10), 10);
  if (isNaN(Y) || isNaN(M) || isNaN(D)) return null;
  if (M < 1 || M > 12) return null;
  return { y: Y, m: M, d: D };
}

function _computeAgeOnDate(dobY, dobM, dobD, curY, curM, curD) {
  var age = curY - dobY;
  if (curM < dobM || (curM === dobM && curD < dobD)) age -= 1;
  return age < 0 ? 0 : age;
}

function _collectCharactersWithAge(currentContext) {
  var result = [];
  try {
    if (!Array.isArray(worldInfo)) return result;
    const MAX_ENTRIES = 50;
    for (var i = 0; i < Math.min(worldInfo.length, MAX_ENTRIES); i++) {
      var wi = worldInfo[i]; if (!wi) continue;
      
      var keys = String(wi.keys || "").toLowerCase().trim();
      if (keys && !currentContext.toLowerCase().includes(keys)) continue;
      
      var body = String(wi.value || wi.entry || wi.text || "");
      var notes = String(wi.notes || wi.description || wi.desc || "");
      var scan = body + "\n" + notes;
      
      var m = scan.match(/^\s*DOB\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/mi);
      if (!m) continue;
      
      var dob = _parseISODateToYMD(m[1]); if (!dob) continue;
      var name = String(wi.title || wi.keys || "").trim() || "Character";
      
      var c = (state && state._ats && state._ats.clock) ? state._ats.clock : null;
      if (!c) continue;
      
      var age = _computeAgeOnDate(dob.y, dob.m, dob.d, c.year, c.month, c.day);
      var dobISO = dob.y + "-" + (dob.m < 10 ? "0" + dob.m : dob.m) + "-" + (dob.d < 10 ? "0" + dob.d : dob.d);
      
      result.push({ name: name, dobISO: dobISO, age: age });
    }
  } catch (_) {}
  return result;
}

// ── ATS: Build context summary ────────────────────────────────────────
function buildContextSummary(text) {
  var timeCard = (typeof findCardByMarker === 'function')
    ? findCardByMarker("[[ATS:TIME]]") : "";
  var calCard = (typeof findCardByMarker === 'function')
    ? findCardByMarker("[[ATS AUTO CONTEXT]]") : "";
  
  var summary = "### SYSTEM CONTEXT ###\n";
  
  if (timeCard) {
    summary += "Current Time & Moon:\n" + timeCard.split("\n").slice(0,6).join("\n") + "\n\n";
  }
  if (calCard) {
    summary += "Calendar Info:\n" + calCard.split("\n").slice(0,10).join("\n") + "\n\n";
  }
  
  try {
    var people = _collectCharactersWithAge(text);
    if (people && people.length) {
      summary += "Characters & Ages:\n";
      for (var i = 0; i < people.length; i++) {
        var p = people[i];
        summary += "- " + p.name + " — age " + p.age + " (DOB " + p.dobISO + ")\n";
      }
      summary += "\n";
    }
  } catch (_) {}
  
  return summary.trim();
}

// ── Combined modifier ─────────────────────────────────────────────────
const modifier = (text) => {
  // Apply ATS context injection
  try {
    var summary = buildContextSummary(text);
    if (summary && text.indexOf("### SYSTEM CONTEXT ###") === -1) {
      text = text + "\n" + summary;
    }
  } catch (_) {}
  
  // InnerSelf modifications are applied automatically after InnerSelf("context")
  // (no extra call needed in most Inner-Self versions)
  
  return { text, stop: false };
};

modifier(text);
