
// ===== START: Context.js (original) =====
const modifier_original = (text) => {
  // ES5-safe Context injector: minimal, relies on Library.js for helpers
  (function(){try{
    if(!state || !state._ats)return;
    if(!state._ats.config)state._ats.config={};
    var cfg=state._ats.config;
    if(cfg.dawnHour==null)cfg.dawnHour=5;
    if(cfg.dawnMinute==null)cfg.dawnMinute=30;
    if(cfg.duskHour==null)cfg.duskHour=19;
    if(cfg.duskMinute==null)cfg.duskMinute=15;
    if(cfg.contextFlavor==null)cfg.contextFlavor='neutral';
  }catch(_){}})();
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
  function _collectCharactersWithAge() {
    var result = [];
    try {
      if (!Array.isArray(worldInfo)) return result;
      for (var i = 0; i < worldInfo.length; i++) {
        var wi = worldInfo[i]; if (!wi) continue;
        var body = String((wi.value!=null?wi.value:(wi.entry!=null?wi.entry:(wi.text!=null?wi.text:""))));
        var notes = String(wi.notes || wi.description || wi.desc || "");
        var scan = body + "\n" + notes;
        var m = scan.match(/^\s*DOB\s*:\s*(\d{4}\-\d{2}\-\d{2})\s*$/mi);
        if (!m) continue;
        var dob = _parseISODateToYMD(m[1]); if (!dob) continue;
        var name = String(wi.title || wi.keys || "").trim();
        if (!name) name = "Character";
        var c = (state && state._ats && state._ats.clock) ? state._ats.clock : null;
        if (!c) continue;
        var age = _computeAgeOnDate(dob.y, dob.m, dob.d, c.year, c.month, c.day);
        var dobISO = dob.y + "-" + (dob.m < 10 ? "0" + dob.m : dob.m) + "-" + (dob.d < 10 ? "0" + dob.d : dob.d);
        result.push({ name: name, dobISO: dobISO, age: age });
      }
    } catch (_) {}
    return result;
  }
  function buildContextSummary(){
    var timeCard = (typeof findCardByMarker === 'function')
      ? findCardByMarker("[[ATS:TIME]]")
      : "";
    var calCard = (typeof findCardByMarker === 'function')
      ? findCardByMarker("[[ATS AUTO CONTEXT]]")
      : "";
    var summary="### SYSTEM CONTEXT ###\n";
    if(timeCard){ summary+="Current Time & Moon:\n"+timeCard.split("\n").slice(0,6).join("\n")+"\n"; }
    if(calCard){ summary+="Calendar Info:\n"+calCard.split("\n").slice(0,10).join("\n")+"\n"; }
    try {
      var people = _collectCharactersWithAge();
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
  try{
    var summary=buildContextSummary();
    if(summary && text.indexOf("### SYSTEM CONTEXT ###")===-1){
      text=text+"\n"+summary;
    }
  }catch(_){}
  return { text:text };
};
// ===== END: Context.js =====


// ===== START: AC Hidden quest context.js =====
const modifier_AC = (text) => {
  [text, stop] = AutoCards("context", text, stop);
  // Ensure defaults to prevent crashes
  state.relationships ??= {};
  state.traits ??= {};
  state.memories ??= {};
  // 0) TURN-1: Detect and set initial in-game time
  if (!state.startDate && state.turnCount === 1) {
    const time24 = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
    const time12 = text.match(/\b(1[0-2]|[1-9])\s*(am|pm)\b/i);
    const kw = text.toLowerCase();
    let hour = null;
    if (time24) {
      hour = parseInt(time24[1], 10);
    } else if (time12) {
      const h = parseInt(time12[1], 10) % 12;
      hour = h + (time12[2].toLowerCase() === "pm" ? 12 : 0);
    } else if (kw.includes("dawn")) hour = 6;
    else if (kw.includes("morning")) hour = 9;
    else if (kw.includes("noon")) hour = 12;
    else if (kw.includes("afternoon")) hour = 15;
    else if (kw.includes("dusk")) hour = 18;
    else if (kw.includes("evening")) hour = 19;
    else if (kw.includes("night")) hour = 22;
    else if (kw.includes("midnight")) hour = 0;
    if (hour === null) hour = 8;
    try {
      const today = new Date();
      const iso = isNaN(today.getTime()) ? "2024-01-01" : today.toISOString().slice(0,10);
      state.startDate = `${iso}T${String(hour).padStart(2,'0')}:00:00`;
    } catch {
      state.startDate = `2024-01-01T${String(hour).padStart(2,'0')}:00:00`;
    }
  }
  // 1) run SAE context hook with fallback if undefined or erroring
  let ctx;
  try {
    ctx = typeof onContext_SAE === "function" ? onContext_SAE(text) : text;
  } catch (err) {
    ctx = text;
  }
  // 2) compute world time: 1 hour per 25 turns + manual override
  try {
    const start = new Date(state.startDate);
    if (isNaN(start.getTime())) throw new Error("Invalid startDate");
    const autoHours = Math.floor(state.turnCount / 25);
    const manual = state.manualHours || 0;
    start.setHours(start.getHours() + autoHours + manual);
    const currentDate = start.toISOString().slice(0, 16).replace("T", " ");
    const timeNote = `-- Current In-Game Time: ${currentDate} --\n\n`;
    // 3) build Character Profiles note
    let profileNote = "-- Character Profiles --\n";
    for (const name of Object.keys(state.relationships)) {
      const traits = state.traits[name] || ["none"];
      const score = state.relationships[name];
      const mood = score > 20 ? "friendly"
        : score < -20 ? "hostile"
        : "neutral";
      const recentMems = (state.memories[name] || []).slice(-3);
      const recent = recentMems.length ? recentMems.join("\n ") : "no memories";
      profileNote += `${name}: [traits: ${traits.join(", ")}] `
        + `[mood: ${mood} (${score})] `
        + `[recent: ${recent}]\n`;
    }
    profileNote += "\n";
    // 4) build World Event note
    const eventNote = `<< World Event: ${state.worldEvent
      || "Clear skies"} >>\n\n`;
    // 5) prepend time, profiles, event, then return
    return { text: timeNote + profileNote + eventNote + ctx };
  } catch (err) {
    return { text: ctx };
  }
  // Your other context modifier scripts go here (alternative)
  return {text, stop};
};
// ===== END: AC Hidden quest context.js =====


// ===== CHAINED MODIFIER =====
const modifier = (text) => {
  // Run the original modifier first
  const result1 = modifier_original(text);
  // Then run the AC Hidden quest modifier on the output of the first
  return modifier_AC(result1.text);
};

// AiDungeon will call this under the hood:
modifier(text);
