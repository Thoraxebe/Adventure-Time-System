/// <reference no-default-lib="true"/>
/// <reference lib="es2022"/>

/*
  =========================================================================
  AI Dungeon — HUD: Time & Calendar (Auto)
  VERSION: 4.19.10h-patched (integrated commands, notes-only, guards)
  - Calendar parsing: fixed, recurring, ranges, overnight
  - Moon phase + Islamic/Chinese lines
  - SMART CAP for ambiguous NL durations + "next ..." indicators
  - Daily banner + Calendar LLM header (with Events/Holiday/Next lines)
  - Explicit /time commands + Time Settings notes-only "Commands"
  - Section headers in Calendar: -----Holiday----- / -----Events----- / -----Hours-----
  - Banner always starts on a new paragraph (two blank lines before and after)
  =========================================================================
*/

/* Bootstrap ATS state (ES5) */
(function(){
  if (!state._ats) {
    state._ats = {
      version: '4.19.10h-patched',
      clock: { year: 2025, month: 11, day: 28, hour: 8, minute: 0, minutesPerTurn: 5, elapsedMinutes: 0 },
      config: {
        showIslamic: true,
        showChinese: true,
        monthDaysApprox: 30,
        yearDaysApprox: 365,
        showDailyBanner: true,
        bannerShowHolidays: true,
        bannerShowEvents: true,
        bannerShowMoon: true,
        bannerCompact: false,
 bannerDateStyle: "iso",
        idioms: { littleWhileMinutes: 10, severalMinutes: 7 },
        morningHour: 8,
        weekendStart: { weekday: 6, hour: 9, minute: 0 },
        nlMaxMinutesCap: 14 * 24 * 60
      },
      cards: { timeIdx: null, settingsIdx: null, calendarIdx: null },
      pendingMinutes: 0,
      appliedFromTextThisTurn: false,
      _tickChangedThisTurn: false,
      calendar: {
        holidays: [], recHolidays: [], events: [], eventsRanges: [], recEvents: [],
        hours: null, today: { holidays: [], eventsToday: [], ongoing: null, next: null, nextHoliday: null, nextHolidayDays: null }
      },
      dailyBanner: { lastISO: null },
      history: { stack: [] },
_debugBannerNext: null,
      _bannerPrintedThisTurn: false
    };
  }
})();
var ATS = state._ats;

// --- Report buffer for slash commands (structured non-prose output) ---
if (!ATS.cmd) ATS.cmd = { suppressLLM: false, lines: [] };

function ATS_pushReport(line) {
  try {
    line = String(line || "").trim();
    if (!line) return;
    ATS.cmd.lines.push(line);
    ATS.cmd.suppressLLM = true;      // request report-only output for this turn
    ATS.pendingMinutes = 0;          // avoid NL/tick double-advance on report turns
  } catch (_) {}
}

function ATS_formatClockShort() {
  var c = ATS.clock;
  return (c.year + "-" + pad2(c.month) + "-" + pad2(c.day) + " " + pad2(c.hour) + ":" + pad2(c.minute));
}


function ATS_fmtDelta(mins) {
  mins = Math.round(Number(mins)||0);
  var sign = mins >= 0 ? '+' : '-';
  var m = Math.abs(mins);
  var h = Math.floor(m/60), mm = m%60;
  return sign + (h>0 ? (h+'h'+(mm?mm+'m':'')) : (mm+'m'));
}


/* ===== Customizable month & weekday names ===== */
(function(){
  if (!ATS.config) ATS.config = {};
  if (!ATS.config.names) {
    ATS.config.names = {
      months: [
        "January","February","March","April","May","June",
        "July","August","September","October","November","December"
      ],
      weekdays: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
      aliases: {
        months: {},   // e.g., { "Jan": "January", "Octember": "October" }
        weekdays: {}  // e.g., { "Mon": "Monday", "Friyay": "Friday" }
      }
    };
  }
  // Runtime maps rebuilt from config.names; used by parser & renderers
  if (!ATS._namesMaps) ATS._namesMaps = {
    monthNameMap: null,   // { "january":1, "octember":10, ... }
    weekdayNameMap: null  // { "sunday":0, "friyay":5, ... }
  };
})();


/* Identity markers */
var ATS_MARKER_TIME     = "[[ATS:TIME]]";
var ATS_MARKER_SETTINGS = "[[ATS:SETTINGS]]";
var ATS_MARKER_CAL_AUTO = "[[ATS AUTO CONTEXT]]";

/* Helpers */
// --- Next Holiday Line Gate (configurable) ---
function shouldShowNextHolidayLine(days) {
  var MIN_DAYS_AHEAD = 1; // not on the day itself
  var MAX_DAYS_AHEAD = 7; // one week window (set to 5 if preferred)
  return typeof days === "number" && days >= MIN_DAYS_AHEAD && days <= MAX_DAYS_AHEAD;
}

function pad2(n){ n = n|0; return (n<10 ? "0"+n : String(n)); }
function clamp(n,min,max){ return n<min?min:(n>max?max:n); }
function prependWithNewline(block, body){
  var lead = body.startsWith("\n") ? "" : "\n";
  var b = String(block||"").replace(/\s+$/, "");
  return lead + b + "\n" + body;
}
function getBodyText(obj){
  return String((obj && (obj.value!=null?obj.value:(obj.entry!=null?obj.entry:(obj.text!=null?obj.text:"")))) || "");
}
function embedMarkerOnce(body, marker){
  body = String(body||"");
  if (body.indexOf(marker)!==-1) return body;
  return marker + "\n" + body;
}
function findCardIndexByMarker(marker){
  if (!Array.isArray(worldInfo)) return null;
  for (var i=0; i<worldInfo.length; i++){
    var wi = worldInfo[i]; if (!wi) continue;
    var body = getBodyText(wi);
    if (body && body.indexOf(marker)!==-1) return i;
  }
  return null;
}
function findCalendarIndexByMarkerOrKey(){
  var idx = findCardIndexByMarker(ATS_MARKER_CAL_AUTO);
  if (idx != null) return idx;
  if (!Array.isArray(worldInfo)) return null;
  for (var i=0;i<worldInfo.length;i++){
    var wi = worldInfo[i]; if (!wi) continue;
    if (String(wi.keys||"") === "__hud_calendar__") return i;
  }
  return null;
}
function moveIndexToPosition(fromIdx, toIdx){
  try{
    if (!Array.isArray(worldInfo)) return;
    if (fromIdx == null || fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= worldInfo.length) return;
    var item = worldInfo.splice(fromIdx,1)[0];
    worldInfo.splice(Math.min(toIdx, worldInfo.length), 0, item);
  }catch(e){}
}

/* Gregorian + weekday */
function isLeapYear(y){ return (y%4===0) && ((y%100!==0) || (y%400===0)); }
function daysInMonth(y,m){ var L=[31,(isLeapYear(y)?29:28),31,30,31,30,31,31,30,31,30,31]; return L[m-1]; }
function weekdayIndex(y,m,d){ var t=[0,3,2,5,0,3,5,1,4,6,2,4]; if (m<3) y-=1; return (y+Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400)+t[m-1]+d)%7; }

function weekdayNameLong(y,m,d){
  var N = (ATS && ATS.config && ATS.config.names) ? ATS.config.names : null;
  var names = (N && Array.isArray(N.weekdays) && N.weekdays.length===7)
    ? N.weekdays
    : ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return names[weekdayIndex(y,m,d)];
}
function monthNameLong(m){
  var N = (ATS && ATS.config && ATS.config.names) ? ATS.config.names : null;
  var months = (N && Array.isArray(N.months) && N.months.length===12)
    ? N.months
    : ["January","February","March","April","May","June","July","August","September","October","November","December"];
  m = (m|0);
  return months[(m-1+12)%12];
}




function formatLongDateLine(y,m,d){
  var wd = weekdayNameLong(y,m,d);
  var mn = monthNameLong(m);
  return wd + ', ' + mn + ' ' + pad2(d) + ', ' + y;
}
/* JDN conversions */
function gregorianToJDN(y,m,d){
  var a = Math.floor((14-m)/12);
  var y2 = y + 4800 - a;
  var m2 = m + 12*a - 3;
  return d + Math.floor((153*m2+2)/5) + 365*y2 + Math.floor(y2/4) - Math.floor(y2/100) + Math.floor(y2/400) - 32045;
}

/* Islamic calendar (Tabular) */
var ISLAMIC_EPOCH = 1948439;
function islamicToJDN(y,m,d){ return d + Math.ceil(29.5*(m-1)) + (y-1)*354 + Math.floor((3+11*y)/30) + ISLAMIC_EPOCH - 1; }
function jdnToIslamic(jd){
  var jd2 = Math.floor(jd)+0.5;
  var y = Math.floor((30*(jd2-ISLAMIC_EPOCH)+10646)/10631);
  var m = Math.min(12, Math.ceil((jd2 - islamicToJDN(y,1,1))/29.5)+1);
  var d = Math.floor(jd2 - islamicToJDN(y,m,1))+1;
  return {year:y, month:m, day:d};
}
function islamicMonthName(m){
  var names=[
    "Muharram","Safar","Rabi’ al-awwal","Rabi’ al-thani",
    "Jumada al-awwal","Jumada al-thani","Rajab","Sha’ban",
    "Ramadan","Shawwal","Dhu al-Qadah","Dhu al-Hijjah"
  ];
  return names[(m-1)%12];
}
function describeIslamicLunarLine(y,m,d){
  var jdn = gregorianToJDN(y,m,d);
  var isl = jdnToIslamic(jdn);
  return isl.day + " " + islamicMonthName(isl.month) + " " + isl.year + " AH";
}
try{ globalThis.describeIslamicLunarLine = describeIslamicLunarLine; }catch(_){}

/* Chinese lunisolar (approx) */
var NM_EPOCH = 2451550.09765;
var SYNODIC  = 29.530588861;
function firstNewMoonOnOrAfter(jd){ var k = Math.ceil((jd - NM_EPOCH)/SYNODIC); return NM_EPOCH + k*SYNODIC; }
function newMoonBefore(jd){ var k = Math.floor((jd - NM_EPOCH)/SYNODIC); return NM_EPOCH + k*SYNODIC; }
function approximateCNY_JDN(year){
  var solsticeJDN = gregorianToJDN(year-1, 12, 21);
  var nm1 = firstNewMoonOnOrAfter(solsticeJDN);
  var nm2 = nm1 + SYNODIC;
  return Math.floor(nm2 + 0.5);
}
function sexagenaryYearName(chYear){
  var stems = ["Jia","Yi","Bing","Ding","Wu","Ji","Geng","Xin","Ren","Gui"];
  var branches = ["Zi (Rat)","Chou (Ox)","Yin (Tiger)","Mao (Rabbit)","Chen (Dragon)","Si (Snake)","Wu (Horse)","Wei (Goat)","Shen (Monkey)","You (Rooster)","Xu (Dog)","Hai (Pig)"];
  var idx = (chYear - 1984) % 60; if (idx<0) idx += 60;
  var stem   = stems[idx % 10];
  var branch = branches[idx % 12];
  return stem + "-" + branch;
}
function describeChineseLunisolarApprox(y,m,d){
  var jdn = gregorianToJDN(y,m,d);
  var cnyThis  = approximateCNY_JDN(y);
  var lunarYear = y;
  var cnyStart  = cnyThis;
  if (jdn < cnyThis){ lunarYear = y - 1; cnyStart = approximateCNY_JDN(y-1); }
  var monthsSinceCNY = Math.floor((jdn - cnyStart)/SYNODIC);
  if (monthsSinceCNY < 0) monthsSinceCNY = 0;
  var monthStart = cnyStart + monthsSinceCNY*SYNODIC;
  var lunarMonth = monthsSinceCNY + 1;
  var lunarDay   = Math.floor(jdn - Math.floor(monthStart + 0.5)) + 1;
  if (lunarDay <= 0){
    lunarMonth -= 1;
    monthStart -= SYNODIC;
    lunarDay    = Math.floor(jdn - Math.floor(monthStart + 0.5)) + 1;
  }
  var lm   = (((lunarMonth-1)%12)+1);
  var sexY = sexagenaryYearName(lunarYear);
  return { year:lunarYear, sexagenary:sexY, month:lm, day:lunarDay };
}
function chineseMonthName(m){ var names = ["1 (Zhengyue)","2","3","4","5","6","7","8","9","10","11","12"]; return names[(m-1)%12]; }
function describeChineseLine(y,m,d){
  var c = describeChineseLunisolarApprox(y,m,d);
  return c.day + " Day of Lunar Month " + chineseMonthName(c.month) + ", Year " + c.year + " (" + c.sexagenary + ", approx.)";
}
try{ globalThis.describeChineseLine = describeChineseLine; }catch(_){}

/* Moon phase */
function moonPhaseEmojiByAge(a){
  if (a < 1.8457) return "\ud83c\udf11";
  if (a < 5.5369) return "\ud83c\udf12";
  if (a < 9.2283) return "\ud83c\udf13";
  if (a < 12.9196) return "\ud83c\udf14";
  if (a < 16.6109) return "\ud83c\udf15";
  if (a < 20.3023) return "\ud83c\udf16";
  if (a < 23.9936) return "\ud83c\udf17";
  if (a < 27.6849) return "\ud83c\udf18";
  return "\ud83c\udf11";
}
function moonPhaseInfo(y,m,d){
  var jdn = gregorianToJDN(y, m, d);
  var nm  = newMoonBefore(jdn + 0.5);
  var age = (jdn + 0.5) - nm;
  if (age < 0) age += SYNODIC;
  var frac  = age / SYNODIC;
  var illum = Math.round((0.5 * (1 - Math.cos(2 * Math.PI * frac))) * 1000) / 10;
  var name;
  if (age < 1.8457) name = "New Moon";
  else if (age < 5.5369) name = "Waxing Crescent";
  else if (age < 9.2283) name = "First Quarter";
  else if (age < 12.9196) name = "Waxing Gibbous";
  else if (age < 16.6109) name = "Full Moon";
  else if (age < 20.3023) name = "Waning Gibbous";
  else if (age < 23.9936) name = "Last Quarter";
  else name = "Waning Crescent";
  return { age: Math.round(age*10)/10, illumination: illum, phase: name, emoji: moonPhaseEmojiByAge(age) };
}

/* Clock advance */
function minutesToHHMM(min){ var hh=(min/60)|0, mm=min%60; return pad2(hh)+":"+pad2(mm); }
function tickMinutes(mins){
  mins = Math.max(0, mins|0);
  ATS.clock.elapsedMinutes += mins;
  var m = ATS.clock.minute + mins;
  ATS.clock.minute = m % 60;
  var addHours = (m/60)|0;
  var h = ATS.clock.hour + addHours;
  ATS.clock.hour = h % 24;
  var addDays = (h/24)|0;
  if (addDays > 0) addDaysToCalendar(addDays);
}


function snapshotClock() {
  var c = ATS.clock;
  return {
    year: c.year, month: c.month, day: c.day,
    hour: c.hour, minute: c.minute,
    elapsed: c.elapsedMinutes
  };
}

function restoreClock(snap) {
  if (!snap) return;
  ATS.clock.year   = snap.year;
  ATS.clock.month  = snap.month;
  ATS.clock.day    = snap.day;
  ATS.clock.hour   = snap.hour;
  ATS.clock.minute = snap.minute;
  ATS.clock.elapsedMinutes = snap.elapsed;
}

function recordAdvance(mins, source) {
  mins = Math.max(0, mins|0);
  if (!ATS.history) ATS.history = { stack: [] };
  ATS.history.stack.push({ before: snapshotClock(), applied: mins, source: String(source||'unknown') });
}

function undoLastAdvance() {
  var last = (ATS.history && ATS.history.stack && ATS.history.stack.length)
             ? ATS.history.stack.pop() : null;
  if (!last) return false;

  // Restore clock and elapsed
  restoreClock(last.before);

  // Clear any queued minutes so nothing re-applies
  ATS.pendingMinutes = 0;

  // Rebuild calendar context after rollback
  try { if (globalThis.crossRefCalendarForToday) globalThis.crossRefCalendarForToday(); } catch (_) {}
  try { updateCalendarCardForLLM(); } catch (_) {}
  try { createOrRecoverTimeCard(); } catch (_) {}
  try { enforceArrayOrder(); } catch (_) {}

  return true;
}
function addDaysToCalendar(days){
  var y=ATS.clock.year, m=ATS.clock.month, d=ATS.clock.day + (days|0);
  while (true){
    var dim = daysInMonth(y,m);
    if (d <= dim) break;
    d -= dim; m += 1; if (m > 12){ m = 1; y += 1; }
  }
  ATS.clock.year=y; ATS.clock.month=m; ATS.clock.day=d;
}
function passiveTurnAdvance(){ tickMinutes(ATS.clock.minutesPerTurn|0); }
try{ if (typeof globalThis.passiveturnadvance==='undefined') globalThis.passiveturnadvance = passiveTurnAdvance; }catch(_){}

/* Keys */
var SIG_TIME     = "__hud_time__";
var KEYS_TIME    = "time,calendar,clock,day,night,morning,evening,noon,midnight,dawn,dusk," + SIG_TIME;
var SIG_CALENDAR = "__hud_calendar__";
var KEYS_CALENDAR= SIG_CALENDAR;
var SIG_SETTINGS = "__hud_time_settings__";
var KEYS_SETTINGS= SIG_SETTINGS;

/* Describe clock + elapsed */
function describeClock(){
  var c = ATS.clock; var wd = weekdayNameLong(c.year, c.month, c.day); var mp = moonPhaseInfo(c.year,c.month,c.day);
  return wd + ", " + c.year + "-" + pad2(c.month) + "-" + pad2(c.day) + " Time: " + pad2(c.hour) + ":" + pad2(c.minute) + " " + mp.emoji;
}
function describeElapsed(){
  var t = ATS.clock.elapsedMinutes|0; var d=(t/(60*24))|0; var h=((t%(60*24))/60)|0; var m=t%60;
  return d + "d " + h + "h " + m + "m elapsed";
}

/* Notes helpers */
var NOTES_MARKER_SETTINGS = "[ATS Notes:TimeSettings]";
var NOTES_MARKER_CALENDAR = "[ATS Notes:Calendar]";
var NOTES_MARKER_CAL_INSTR= "[ATS Notes:Calendar Multi-day Instructions]";
function _getNotesFieldName(wi){
  if (wi == null) return "notes";
  if (typeof wi.notes === "string") return "notes";
  if (typeof wi.description === "string") return "description";
  if (typeof wi.desc === "string") return "desc";
  return "notes";
}
function ensureNotes(idx, marker, lines){
  try{
    if (!Array.isArray(worldInfo) || idx == null || !worldInfo[idx]) return;
    var wi = worldInfo[idx];
    var field = _getNotesFieldName(wi);
    var existing = String(wi[field] || "");
    if (marker && existing.indexOf(marker)!==-1) return;
    var add = marker ? (marker + "\n" + lines.join("\n")) : lines.join("\n");
    wi[field] = existing ? (existing + "\n\n" + add) : add;
  }catch(e){}
}

/* ISO helpers */
function toISODate(y,m,d){ return y + "-" + pad2(m) + "-" + pad2(d); }
function parseISODateStr(s){
  if (typeof s!=="string") return null;
  s=s.trim();
  if (s.length!==10 || s.charAt(4)!=="-" || s.charAt(7)!=="-") return null;
  var Y=parseInt(s.slice(0,4),10), M=parseInt(s.slice(5,7),10), D=parseInt(s.slice(8,10),10);
  if (isNaN(Y)||isNaN(M)||isNaN(D)) return null;
  if (M<1||M>12) return null;
  if (D<1||D>daysInMonth(Y,M)) return null;
  return { y:Y, m:M, d:D, iso: toISODate(Y,M,D) };
}
function parseHHMM(s){
  if (typeof s!=="string") return null;
  s=s.trim();
  var p=s.split(":"); if (p.length!==2) return null;
  var hh=parseInt(p[0],10), mm=parseInt(p[1],10);
  if (isNaN(hh)||isNaN(mm)) return null;
  if (hh<0||hh>23||mm<0||mm>59) return null;
  return hh*60+mm;
}
function isoToDate(iso){
  if (typeof iso!=="string") return null;
  if (iso.length!==10 || iso.charAt(4)!=="-" || iso.charAt(7)!=="-") return null;
  var Y=parseInt(iso.slice(0,4),10);
  var M=parseInt(iso.slice(5,7),10);
  var D=parseInt(iso.slice(8,10),10);
  if (isNaN(Y)||isNaN(M)||isNaN(D)) return null;
  if (M<1||M>12) return null;
  if (D<1||D>daysInMonth(Y,M)) return null;
  return new Date(Y, M-1, D);
}
function dateToISO(d){
  if (!(d instanceof Date)) return null;
  var Y=d.getFullYear(), M=d.getMonth()+1, D=d.getDate();
  return Y + "-" + pad2(M) + "-" + pad2(D);
}
function cleanISO(s){
  s=String(s||"").replace(/\u00A0/g,"").replace(/\u200B/g,"").trim();
  if (s.length!==10 || s.charAt(4)!=="-" || s.charAt(7)!=="-") return null;
  var d=isoToDate(s); return d?dateToISO(d):null;
}
try{ globalThis.isoToDate=isoToDate; globalThis.dateToISO=dateToISO; globalThis.cleanISO=cleanISO; }catch(_){}

/* Ordinal helper */
function ordinalToIndex(s){
  s = String(s||"").trim().toLowerCase();
  if (!s) return null;
  if (s === "last") return -1;
  if (s === "first" || s==="1st" || s==="1") return 1;
  if (s === "second"|| s==="2nd" || s==="2") return 2;
  if (s === "third" || s==="3rd" || s==="3") return 3;
  if (s === "fourth"|| s==="4th" || s==="4") return 4;
  if (s === "fifth" || s==="5th" || s==="5") return 5;
  return null;
}

/* Calendar parsing — full (fixed, recurring, ranges, overnight) */

function MONTH_NAME_MAP_GET(){
  var m = ATS._namesMaps && ATS._namesMaps.monthNameMap;
  if (!m) return { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
  return m;
}


function WEEKDAY_MAP_GET(){
  var w = ATS._namesMaps && ATS._namesMaps.weekdayNameMap;
  if (!w) w = { sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
  // typo guard
  w["firday"] = w.hasOwnProperty("friday") ? w["friday"] : 5;
  return w;
}
function containsCalendarMarkers(s){
  s=String(s||"").toUpperCase();
  return s.indexOf("HOLIDAYS")!==-1 || s.indexOf("EVENTS")!==-1 || s.indexOf("HOURS")!==-1;
}

function parseCalendarText(txt){
  var lines = String(txt || "").split(/\r?\n/);
  var holidays = [], events = [], hours = null;
  var recHolidays = [], recEvents = [];
  var eventsRanges = [];
  var section = null; // "holidays" | "events" | "hours"

  function parseEventLocation(rest){
    var loc = null;
    var atIdx = rest.indexOf(" @ ");
    if (atIdx !== -1){
      loc = rest.slice(atIdx + 3).trim();
      rest = rest.slice(0, atIdx).trim();
    }
    return { title: rest, location: loc };
  }
  function startsWithIgnoreCase(s, head){
    return String(s || "").toLowerCase().indexOf(String(head || "").toLowerCase()) === 0;
  }
  function parseTimeSpan(tkn){
    var dashIdx = tkn.indexOf("–"); if (dashIdx === -1) dashIdx = tkn.indexOf("-");
    var s = null, e = null;
    if (dashIdx !== -1){ s = parseHHMM(tkn.slice(0, dashIdx)); e = parseHHMM(tkn.slice(dashIdx + 1)); }
    else { s = parseHHMM(tkn); e = null; }
    return { s:s, e:e };
  }

  for (var i = 0; i < lines.length; i++){
    var raw = lines[i];
    var line = raw.trim();
    if (!line) continue;

    var upper = line.toUpperCase();

    // ---- Section switches (plain & dashed) ----
    if (upper === "HOLIDAYS:" || upper === "HOLIDAYS"){ section = "holidays"; continue; }
    if (/^\-+\s*holiday(?:s)?\s*\-+$/i.test(raw)){ section = "holidays"; continue; }

    if (upper === "EVENTS:" || upper === "EVENTS"){ section = "events"; continue; }
    // **FIX**: recognize dashed '-----Events-----'
    if (/^\-+\s*events?\s*\-+$/i.test(raw)){ section = "events"; continue; }

    if (upper === "HOURS:" || upper === "HOURS"){ section = "hours"; continue; }
    // **FIX**: recognize dashed '-----Hours-----'
    if (/^\-+\s*hours?\s*\-+$/i.test(raw)){ section = "hours"; continue; }

    // ---- Holidays section ----
    if (section === "holidays"){
      var sp = line.split(/\s+/);
      // Fixed-date holiday: "YYYY-MM-DD Name"
      if (sp.length >= 2 && sp[0].length === 10 && sp[0].charAt(4) === "-" && sp[0].charAt(7) === "-"){
        var d = parseISODateStr(sp[0]);
        if (d){
          holidays.push({ date: d.iso, name: line.slice(11).trim() });
          continue;
        }
      }
      // Annual: numeric or name-based, or Nth weekday of month
      if (startsWithIgnoreCase(line, "Annual:")){
        var restH = line.slice(7).trim();
        var sp2 = restH.split(/\s+/);
        if (sp2.length >= 2){
          if (sp2[0].indexOf("-") !== -1){
            var partsH = sp2[0].split("-");
            var mm = parseInt(partsH[0], 10), dd = parseInt(partsH[1], 10);
            if (!isNaN(mm) && !isNaN(dd)){
              recHolidays.push({ kind:"annual-mmdd", mm:mm, dd:dd, name: restH.slice(sp2[0].length).trim() });
              continue;
            }
          }
          var monH = MONTH_NAME_MAP_GET()[sp2[0].toLowerCase()];
          var dd2 = parseInt(sp2[1], 10);
          if (monH && !isNaN(dd2)){
            recHolidays.push({ kind:"annual-mmdd", mm:monH, dd:dd2, name: restH.slice(sp2[0].length + 1 + sp2[1].length).trim() });
            continue;
          }
          var ofIdx = restH.toLowerCase().indexOf(" of ");
          if (ofIdx !== -1){
            var left = restH.slice(0, ofIdx).trim();
            var right = restH.slice(ofIdx + 4).trim();
            var leftParts = left.split(/\s+/);
            var rightParts = right.split(/\s+/);
            if (leftParts.length === 2 && rightParts.length >= 1){
              var nth = ordinalToIndex(leftParts[0]);
              var wd = WEEKDAY_MAP_GET()[leftParts[1].toLowerCase()];
              var mon2 = MONTH_NAME_MAP_GET()[rightParts[0].toLowerCase()];
              var nm = right.slice(rightParts[0].length).trim();
              if (nth != null && wd != null && mon2 != null){
                recHolidays.push({ kind:"annual-nth", nth:nth, weekday:wd, month:mon2, name:nm });
                continue;
              }
            }
          }
        }
      }
      continue;
    } // end holidays

    // ---- Events section ----
    if (section === "events"){
      var parts = line.split(/\s+/);

      // Range: "YYYY-MM-DD..YYYY-MM-DD [HH:MM–HH:MM] Title @ Location"
      if (parts.length >= 1 && parts[0].indexOf("..") !== -1){
        var rParts = parts[0].split("..");
        var dS = parseISODateStr(rParts[0]);
        var dE = parseISODateStr(rParts[1]);
        if (dS && dE){
          var s = null, e = null, timeTokLen = 0;
          var hasTime = (parts.length >= 2 && parts[1].indexOf(":") !== -1);
          if (hasTime){
            var se = parseTimeSpan(parts[1]); s = se.s; e = se.e; timeTokLen = parts[1].length + 1;
          }
          var restTitle = line.slice(parts[0].length + 1 + timeTokLen).trim();
          var info = parseEventLocation(restTitle);
          eventsRanges.push({ startISO: dS.iso, endISO: dE.iso, startMin: s, endMin: e, title: info.title, location: info.location });
          continue;
        }
      }

      // Single date (optional time): "YYYY-MM-DD [HH:MM–HH:MM] Title @ Location"
      if (parts.length >= 1 && parts[0].length === 10 && parts[0].charAt(4) === "-" && parts[0].charAt(7) === "-"){
        var d2 = parseISODateStr(parts[0]);
        if (d2){
          var timeText = (parts.length >= 2 ? parts[1] : "");
          var s=null, e=null, timeLen=0;
          if (timeText){
            var se2 = parseTimeSpan(timeText);
            s = se2.s; e = se2.e;
            timeLen = timeText.length + 1;
          }
          var restTitle2 = line.slice(parts[0].length + 1 + timeLen).trim();
          var info2 = parseEventLocation(restTitle2);
          events.push({ date: d2.iso, startMin: s, endMin: e, title: info2.title, location: info2.location });
          continue;
        }
      }

      // **FIX** Recurring: "Every ..."
      var lineTrim = line.trim();
      if (startsWithIgnoreCase(lineTrim, "Every ")){
        // define parts from trimmed text first
        var partsEvery = lineTrim.split(/\s+/);
        var rest = partsEvery.slice(1).join(" ").trim();

        // Every day HH:MM–HH:MM Title @ Location
        if (startsWithIgnoreCase(rest, "day ")){
          var t = rest.slice(4).trim();
          var s_e = t.split(/\s+/)[0];
          var se = parseTimeSpan(s_e);
          var title = t.slice(s_e.length).trim();
          var info = parseEventLocation(title);
          recEvents.push({ freq:"DAILY", startMin: se.s, endMin: se.e, title: info.title, location: info.location });
          continue;
        }

        // Every week Weekday HH:MM–HH:MM Title
        if (startsWithIgnoreCase(rest, "week ")){
          var p2 = rest.slice(5).trim().split(/\s+/);
          if (p2.length >= 2){
            var wd = WEEKDAY_MAP_GET()[p2[0].toLowerCase()];
            var se2 = parseTimeSpan(p2[1]);
            var title2 = rest.slice(5 + p2[0].length + 1 + p2[1].length).trim();
            var info2 = parseEventLocation(title2);
            if (wd != null) recEvents.push({ freq:"WEEKLY", weekday: wd, startMin: se2.s, endMin: se2.e, title: info2.title, location: info2.location });
            continue;
          }
        }

        // Every month DD HH:MM–HH:MM Title
        if (startsWithIgnoreCase(rest, "month ")){
          var p3 = rest.slice(6).trim().split(/\s+/);
          if (p3.length >= 2){
            var dom = parseInt(p3[0], 10);
            var se3 = parseTimeSpan(p3[1]);
            var title3 = rest.slice(6 + p3[0].length + 1 + p3[1].length).trim();
            var info3 = parseEventLocation(title3);
            if (!isNaN(dom) && dom >= 1 && dom <= 31) recEvents.push({ freq:"MONTHLY", monthDay: dom, startMin: se3.s, endMin: se3.e, title: info3.title, location: info3.location });
            continue;
          }
        }

        // Every year MM-DD HH:MM–HH:MM Title
        if (startsWithIgnoreCase(rest, "year ")){
          var r4 = rest.slice(5).trim();
          var p4 = r4.split(/\s+/);
          if (p4.length >= 2){
            if (p4[0].indexOf("-") !== -1){
              var partsY = p4[0].split("-");
              var mm = parseInt(partsY[0], 10), dd = parseInt(partsY[1], 10);
              var se4 = parseTimeSpan(p4[1]);
              var title4 = r4.slice(p4[0].length + 1 + p4[1].length).trim();
              var info4 = parseEventLocation(title4);
              recEvents.push({ freq:"YEARLY_MMDD", mm:mm, dd:dd, startMin:se4.s, endMin:se4.e, title:info4.title, location:info4.location });
              continue;
            }
            var ofIdx2 = r4.toLowerCase().indexOf(" of ");
            if (ofIdx2 !== -1){
              var left = r4.slice(0, ofIdx2).trim();
              var right = r4.slice(ofIdx2+4).trim();
              var leftParts = left.split(/\s+/);
              var rightParts = right.split(/\s+/);
              if (leftParts.length === 2 && rightParts.length >= 2){
                var nth = ordinalToIndex(leftParts[0]);
                var wd2 = WEEKDAY_MAP_GET()[leftParts[1].toLowerCase()];
                var mon = MONTH_NAME_MAP_GET()[rightParts[0].toLowerCase()];
                var se5 = parseTimeSpan(rightParts[1]);
                var title5 = right.slice(rightParts[0].length + 1 + rightParts[1].length).trim();
                var info5 = parseEventLocation(title5);
                if (nth != null && wd2 != null && mon != null){
                  recEvents.push({ freq:"YEARLY_NTH", nth:nth, weekday:wd2, month:mon, startMin:se5.s, endMin:se5.e, title:info5.title, location:info5.location });
                }
                continue;
              }
            }
          }
        }
      } // end "Every ..."
      continue;
    } // end events

    // ---- Hours section ----
    if (section === "hours"){
      var pH = line.split(/\s+/);
      if (pH.length >= 1){
        var timeText = pH[0];
        var dashIdx = timeText.indexOf("–"); if (dashIdx === -1) dashIdx = timeText.indexOf("-");
        if (dashIdx !== -1){
          var open = parseHHMM(timeText.slice(0, dashIdx));
          var close = parseHHMM(timeText.slice(dashIdx + 1));
          if (open != null && close != null) hours = { openMin: open, closeMin: close };
        }
      }
      continue;
    }
  } // end for lines

  ATS.calendar.holidays = holidays;
  ATS.calendar.events = events;
  ATS.calendar.eventsRanges = eventsRanges;
  ATS.calendar.hours = hours;
  ATS.calendar.recHolidays = recHolidays;
  ATS.calendar.recEvents = recEvents;
}

try{ globalThis.parseCalendarText = parseCalendarText; }catch(_){}

/* ISO range helpers */
function isoMinusOneDay(iso){
  var d = isoToDate(iso); if (!d) return null;
  d.setDate(d.getDate()-1);
  return dateToISO(d);
}
function isoBetweenInclusive(iso, startISO, endISO){
  var x = isoToDate(iso), s = isoToDate(startISO), e = isoToDate(endISO);
  if (!x || !s || !e) return false;
  return x.getTime() >= s.getTime() && x.getTime() <= e.getTime();
}
function nextAnnualMMDD(currentISO, mm, dd){
  var cur = isoToDate(currentISO);
  var y = cur.getFullYear();
  var cand = new Date(y, mm-1, dd);
  if (cand.getTime() <= cur.getTime()) cand = new Date(y+1, mm-1, dd);
  return dateToISO(cand);
}
function nthWeekdayOfMonth(year, month, weekday, nth){
  var date = new Date(year, month-1, 1);
  var firstW = date.getDay();
  var day;
  if (nth === -1){
    var lastDay = daysInMonth(year, month);
    var d = new Date(year, month-1, lastDay).getDay();
    day = lastDay - ((d - weekday + 7) % 7);
  } else {
    var offset = (weekday - firstW + 7) % 7;
    day = 1 + offset + (nth-1)*7;
    if (day > daysInMonth(year, month)) return null;
  }
  return day;
}
function nextAnnualNthWeekday(currentISO, month, weekday, nth){
  var cur = isoToDate(currentISO);
  var y = cur.getFullYear();
  var day = nthWeekdayOfMonth(y, month, weekday, nth);
  var cand = new Date(y, month-1, (day||1));
  if (!day || cand.getTime() <= cur.getTime()){
    y += 1;
    day = nthWeekdayOfMonth(y, month, weekday, nth);
    cand = new Date(y, month-1, (day||1));
  }
  return dateToISO(cand);
}

/* Cross-reference calendar for today (holidays, events, next/ongoing) */
function crossRefCalendarForToday(){
  var c = ATS.clock, todayISO = toISODate(c.year, c.month, c.day), todayDate = isoToDate(todayISO);

  var todayFixed = (ATS.calendar.holidays||[]).filter(function(h){ return String(h.date||"").trim()===todayISO; })
                   .map(function(h){ return { iso:h.date, name:h.name }; });

  var todayRec = [];
  var recH = ATS.calendar.recHolidays||[];
  for (var i=0;i<recH.length;i++){
    var h = recH[i];
    if (h.kind==="annual-mmdd"){
      var mm=h.mm, dd=h.dd;
      if (typeof mm === "string"){
        var mmLc = mm.toLowerCase();
        var _map=MONTH_NAME_MAP_GET(); mm = (_map && _map.hasOwnProperty(mmLc)) ? _map[mmLc] : parseInt(mm,10);
      }
      dd = parseInt(dd,10);
      if (c.month===mm && c.day===dd) todayRec.push({ iso:todayISO, name:h.name });
    } else if (h.kind==="annual-nth" && c.month===h.month){
      var d = nthWeekdayOfMonth(c.year, h.month, h.weekday, h.nth);
      if (d === c.day) todayRec.push({ iso:todayISO, name:h.name });
    }
  }
  var todayNames = todayFixed.concat(todayRec).map(function(x){ return String(x.name||"").trim(); }).filter(Boolean);

  var candidates = [];
  function pushCandidate(iso, name, source){
    name = String(name||"").replace(/\u00A0/g,"").replace(/\u200B/g,"").trim();
    iso  = cleanISO(iso);
    if (!iso || !name) return;
    var dCand = isoToDate(iso);
    if (!dCand || dCand.getTime() <= todayDate.getTime()) return;
    candidates.push({ iso: iso, name: name, ts: dCand.getTime(), source: source });
  }
  for (var j=0;j<(ATS.calendar.holidays||[]).length;j++){
    pushCandidate(String(ATS.calendar.holidays[j].date||""), String(ATS.calendar.holidays[j].name||""), "fixed");
  }
  for (var k=0;k<recH.length;k++){
    var hr = recH[k], nextIso = null;
    if (hr.kind==="annual-mmdd"){
      var mm2 = hr.mm, dd2 = hr.dd;
      if (typeof mm2 === "string"){
        var mLc=mm2.toLowerCase();
        var _map2=MONTH_NAME_MAP_GET(); mm2 = (_map2 && _map2.hasOwnProperty(mLc)) ? _map2[mLc] : parseInt(mm2,10);
      }
      dd2 = parseInt(dd2,10);
      if (!isNaN(mm2) && !isNaN(dd2)) nextIso = nextAnnualMMDD(todayISO, mm2, dd2);
    } else if (hr.kind==="annual-nth"){
      nextIso = nextAnnualNthWeekday(todayISO, hr.month, hr.weekday, hr.nth);
    }
    pushCandidate(nextIso, hr.name, "rec");
  }
  var byISO = Object.create(null);
  for (var x=0;x<candidates.length;x++){
    var cnd = candidates[x], keyIso = cnd.iso;
    var prev = byISO[keyIso];
    if (!prev || cnd.ts < prev.ts || (cnd.ts === prev.ts && prev.source==="rec" && cnd.source==="fixed")){
      byISO[keyIso] = cnd;
    }
  }
  var finalCandidates = Object.values(byISO);
  finalCandidates.sort(function(a,b){ return a.ts - b.ts; });
  var nextHoliday = finalCandidates.length ? finalCandidates[0] : null;
  var daysUntil = null;
  if (nextHoliday){
    daysUntil = Math.round((nextHoliday.ts - todayDate.getTime()) / (1000*60*60*24));
  }

  var todayEvents = [];
  var evs = ATS.calendar.events||[];
  var prevISO = isoMinusOneDay(todayISO);

  for (var iE=0;iE<evs.length;iE++){
    var ev = evs[iE];
    if (String(ev.date||"") === todayISO){
      if (ev.startMin!=null && ev.endMin!=null && ev.endMin < ev.startMin){
        todayEvents.push({ date: todayISO, startMin: ev.startMin, endMin: (24*60-1), title: ev.title, location: ev.location });
      } else {
        todayEvents.push({ date: todayISO, startMin: ev.startMin, endMin: ev.endMin, title: ev.title, location: ev.location });
      }
    } else if (prevISO && String(ev.date||"") === prevISO){
      if (ev.startMin!=null && ev.endMin!=null && ev.endMin < ev.startMin){
        todayEvents.push({ date: todayISO, startMin: 0, endMin: ev.endMin, title: ev.title, location: ev.location });
      }
    }
  }

  var ranges = ATS.calendar.eventsRanges||[];
  for (var r=0;r<ranges.length;r++){
    var rg = ranges[r];
    if (isoBetweenInclusive(todayISO, rg.startISO, rg.endISO)){
      todayEvents.push({ date: todayISO, startMin: rg.startMin, endMin: rg.endMin, title: rg.title, location: rg.location });
    }
  }

  var wdToday = weekdayIndex(c.year, c.month, c.day);
  var recE = ATS.calendar.recEvents||[];
  for (var rE=0;rE<recE.length;rE++){
    var evR = recE[rE];
    var include = false;
    if (evR.freq === "DAILY"){ include = true; }
    else if (evR.freq === "WEEKLY" && evR.weekday === wdToday){ include = true; }
    else if (evR.freq === "MONTHLY" && c.day === evR.monthDay){ include = true; }
    else if (evR.freq === "YEARLY_MMDD" && c.month === evR.mm && c.day === evR.dd){ include = true; }
    else if (evR.freq === "YEARLY_NTH" && c.month === evR.month){
      var dX = nthWeekdayOfMonth(c.year, evR.month, evR.weekday, evR.nth);
      if (dX === c.day) include = true;
    }
    if (include){
      todayEvents.push({ date: todayISO, startMin: evR.startMin, endMin: evR.endMin, title: evR.title, location: evR.location });
    }
  }

  todayEvents.sort(function(a,b){
    var sa = (a.startMin!=null? a.startMin: 0);
    var sb = (b.startMin!=null? b.startMin: 0);
    return sa - sb;
  });

  var nowMin = c.hour*60 + c.minute;
  var ongoing = null, next = null;
  for (var i2=0;i2<todayEvents.length;i2++){
    var ev2 = todayEvents[i2];
    var s2 = (ev2.startMin!=null? ev2.startMin : 0);
    var e2 = (ev2.endMin!=null? ev2.endMin : null);
    if (e2!=null && nowMin>=s2 && nowMin<=e2){ ongoing = ev2; break; }
    if (e2==null && nowMin===s2){ ongoing = ev2; break; }
    if (nowMin < s2){ next = ev2; break; }
  }

  ATS.calendar.today = {
    holidays: todayNames,
    eventsToday: todayEvents,
    ongoing: ongoing,
    next: next,
    nextHoliday: nextHoliday ? { iso: nextHoliday.iso, name: nextHoliday.name } : null,
    nextHolidayDays: (daysUntil != null) ? daysUntil : null
  };
}
try{ globalThis.crossRefCalendarForToday = crossRefCalendarForToday; }catch(_){}

/* Render Time card */
function renderTimeEntry(){
  var c = ATS.clock, cfg = ATS.config||{}, mp = moonPhaseInfo(c.year,c.month,c.day);
  var cal = ATS.calendar.today || { holidays:[], ongoing:null, next:null, nextHoliday:null, nextHolidayDays:null };
  var lines = [];

  // Long date line + ISO line with time
  lines.push(formatLongDateLine(c.year,c.month,c.day));
  lines.push(toISODate(c.year,c.month,c.day) + " Time: " + pad2(c.hour) + ":" + pad2(c.minute) + " " + mp.emoji);
  lines.push("");

  // Next holiday
  var lineH = "Next holiday: ";
  if (cal.nextHoliday){
    lineH += cal.nextHoliday.name + " on " + cal.nextHoliday.iso;
    if (cal.nextHolidayDays != null) lineH += " (in " + cal.nextHolidayDays + " days)";
  } else lineH += "None scheduled";
  lines.push(lineH);

  // Next event
  var lineE = "Next event: ";
  if (cal.next){
    var at = minutesToHHMM(cal.next.startMin||0);
    lineE += cal.next.title + " at " + at + (cal.next.location ? (" @ " + cal.next.location) : "");
  } else lineE += "None today";
  lines.push(lineE);

  lines.push("");

  // Other calendars & moon
  if (cfg.showIslamic) lines.push("Islamic (Tabular): " + describeIslamicLunarLine(c.year, c.month, c.day));
  if (cfg.showChinese) lines.push("Chinese (Lunisolar, approx.): " + describeChineseLine(c.year, c.month, c.day));
  lines.push("Moon: " + mp.emoji + " " + mp.phase + " - age " + mp.age + " d, illum " + mp.illumination + "%");
  lines.push(describeElapsed());

  return lines.join("\n");

}
/* Calendar auto-header for LLM — with your requested lines */
function buildCalendarAutoHeader(){
  var c = ATS.clock;
  var cal = ATS.calendar.today || {
    holidays: [],
    eventsToday: [],
    next: null,
    nextHoliday: null,
    nextHolidayDays: null
  };
  var mp = moonPhaseInfo(c.year, c.month, c.day);

  var eventsTodayLine;
  if (cal.eventsToday && cal.eventsToday.length) {
    var first = cal.eventsToday[0];
    var s = (first.startMin!=null ? minutesToHHMM(first.startMin) : "—");
    var span = (first.endMin!=null ? (s + "–" + minutesToHHMM(first.endMin)) : s);
    var more = (cal.eventsToday.length > 1) ? (" (+" + (cal.eventsToday.length - 1) + " more)") : "";
    eventsTodayLine = "Events today: " + first.title + " (" + span + (first.location ? (" @ " + first.location) : "") + ")" + more;
  } else {
    eventsTodayLine = "Events today: none";
  }

  var holidayTodayLine = (cal.holidays && cal.holidays.length)
    ? ("Holiday today: " + cal.holidays.join(", "))
    : "Holiday today: none";

  var nextHolidayLine = "Next holiday: ";
  if (cal.nextHoliday) {
    nextHolidayLine += cal.nextHoliday.name + " on " + cal.nextHoliday.iso;
    if (cal.nextHolidayDays != null) nextHolidayLine += " (in " + cal.nextHolidayDays + " days)";
  } else {
    nextHolidayLine += "none";
  }

  var lines = [];
  lines.push(ATS_MARKER_CAL_AUTO);
  lines.push("Calendar Context:");
  lines.push("Date: " + c.year + "-" + pad2(c.month) + "-" + pad2(c.day) + " (" + weekdayNameLong(c.year, c.month, c.day) + ")");
  lines.push("Time: " + pad2(c.hour) + ":" + pad2(c.minute) + " " + mp.emoji);
  lines.push(eventsTodayLine);
  lines.push(holidayTodayLine);
  (function(){ var ndays = cal.nextHolidayDays; if (cal.nextHoliday && shouldShowNextHolidayLine(ndays)) lines.push(nextHolidayLine); })();
  return lines.join("\n");
}

/* Update Calendar card to show header above the custom sections */
function updateCalendarCardForLLM(){
  var calIdx = null;
  if (Array.isArray(worldInfo)){
    for (var i=0;i<worldInfo.length;i++){
      var wi = worldInfo[i];
      if (wi && String(wi.keys||"")==="__hud_calendar__"){ calIdx = i; break; }
    }
    if (calIdx == null){
      for (var j=0;j<worldInfo.length;j++){
        var wi2 = worldInfo[j]; if (!wi2) continue;
        var tU = String(wi2.title||"").trim().toUpperCase();
        if (tU==="CALENDAR"){ calIdx = j; break; }
      }
    }
  }
  if (calIdx == null) return;

  var header = buildCalendarAutoHeader();

  var wi = worldInfo[calIdx];
  var oldBody = getBodyText(wi);

  var skeleton = [
    "-----Holiday-----",
    "",
    "-----Events-----",
    "",
    "-----Hours-----",
    "  09:00–18:00"
  ].join("\n");

  var sections = ["-----Holiday-----", "-----Events-----", "-----Hours-----"];
  var upper = String(oldBody||"").toUpperCase();
  var markerPos = oldBody.indexOf(ATS_MARKER_CAL_AUTO);
  var tail = skeleton;

  if (markerPos !== -1) {
    var cutPos = -1;
    for (var s=0; s<sections.length; s++){
      var p = upper.indexOf(sections[s].toUpperCase(), markerPos);
      if (p !== -1) cutPos = (cutPos === -1 ? p : Math.min(cutPos, p));
    }
    if (cutPos !== -1) {
      tail = oldBody.slice(cutPos);
    }
  } else {
    var hasCustom = /\-\-\-\-\-Holiday\-\-\-\-\-|\-\-\-\-\-Events\-\-\-\-\-|\-\-\-\-\-Hours\-\-\-\-\-/i.test(oldBody);
    if (hasCustom) tail = oldBody;
  }

  var newBody = header + "\n\n" + tail;
  updateWorldEntry(calIdx, "__hud_calendar__", newBody);
  try { worldInfo[calIdx].title = "Calendar"; } catch(_){}
}

/* Banner — force clean new paragraph before and after */
function buildDayRolloverBanner(mp){
  var c = ATS.clock;
  var iso = toISODate(c.year, c.month, c.day);
  var cal = ATS.calendar.today || { holidays:[], eventsToday:[] };
  var lines = [];

  // Line 1: long date
  lines.push(formatLongDateLine(c.year, c.month, c.day));

  // Line 2: ISO date with time + moon emoji (respect bannerShowMoon)
  var timeLine = iso + " Time: " + pad2(c.hour) + ":" + pad2(c.minute);
  if (ATS.config.bannerShowMoon){
    timeLine += " " + (mp ? mp.emoji : moonPhaseInfo(c.year, c.month, c.day).emoji);
  }
  lines.push(timeLine);

  // Optional holiday line (today)
  if (ATS.config.bannerShowHolidays){
    if (cal.holidays && cal.holidays.length){
      lines.push("Holiday(s): " + cal.holidays.join(", "));
    }
    // NEW: show Next holiday if within gate (1..7 days by default)
    var ndays = cal.nextHolidayDays;
    if (cal.nextHoliday && shouldShowNextHolidayLine(ndays)){
      var nh = cal.nextHoliday;
      lines.push("Next holiday: " + nh.name + " on " + nh.iso +
                 (typeof ndays === "number" ? " (in " + ndays + " days)" : ""));
    }
  }

  // Optional events line(s)
  if (ATS.config.bannerShowEvents){
    if (cal.eventsToday && cal.eventsToday.length){
      if (ATS.config.bannerCompact){
        var evs = cal.eventsToday, first = evs[0];
        var s = (first.startMin != null ? minutesToHHMM(first.startMin) : "--");
        var span = (first.endMin != null ? (s + "-" + minutesToHHMM(first.endMin)) : s);
        var base = "Events today: " + first.title + " (" + span +
                   (first.location ? " @ " + first.location : "") + ")";
        var more = (evs.length > 1) ? (" (+" + (evs.length - 1) + " more)") : "";
        lines.push(base + more);
      } else {
        lines.push("Events today:");
        for (var i2=0;i2<cal.eventsToday.length;i2++){
          var e = cal.eventsToday[i2];
          var s2 = (e.startMin != null ? minutesToHHMM(e.startMin) : "--");
          var span2 = (e.endMin != null ? (s2 + "-" + minutesToHHMM(e.endMin)) : s2);
          lines.push("- " + e.title + " (" + span2 + (e.location ? " @ " + e.location : "") + ")");
        }
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}



/* Card management helpers */
function isSettingsCard(wi){
  if (!wi) return false;
  var k = String(wi.keys||"");
  var tU = String(wi.title||"").trim().toUpperCase();
  var body = getBodyText(wi);
  return (k===SIG_SETTINGS) || (tU==="TIME SETTINGS") || (body.indexOf(ATS_MARKER_SETTINGS)!==-1);
}
function cardIndexIsValid(idx){ return Array.isArray(worldInfo) && idx!=null && idx>=0 && idx<worldInfo.length && worldInfo[idx]; }
function ensureCard(title, keys, entry, currentIdx){
  if (cardIndexIsValid(currentIdx)){
    var wiCurr = worldInfo[currentIdx];
    if (isSettingsCard(wiCurr) && keys!==SIG_SETTINGS){
      // don't overwrite Settings from non-settings paths
    } else {
      updateWorldEntry(currentIdx, keys, entry);
      try{ worldInfo[currentIdx].title = title; }catch(_){}
      return currentIdx;
    }
  }
  if (Array.isArray(worldInfo)){
    for (var i=0;i<worldInfo.length;i++){
      var wi=worldInfo[i]; if (!wi) continue;
      if (String(wi.keys||"")===keys){
        if (isSettingsCard(wi) && keys!==SIG_SETTINGS) continue;
        updateWorldEntry(i, keys, entry);
        try{ worldInfo[i].title = title; }catch(_){}
        return i;
      }
    }
  }
  var newIdx = addWorldEntry(keys, entry);
  try{ worldInfo[newIdx].title = title; }catch(_){}
  return newIdx;
}

/* Create or recover Time card */
function createOrRecoverTimeCard(){
  var idx = findCardIndexByMarker(ATS_MARKER_TIME);
  var entry = renderTimeEntry();
  if (idx != null){
    var withMarker = embedMarkerOnce(entry, ATS_MARKER_TIME);
    updateWorldEntry(idx, KEYS_TIME, withMarker);
    try{ worldInfo[idx].title = "Time"; }catch(_){}
    ATS.cards.timeIdx = idx;
    return;
  }
  var newBody = embedMarkerOnce(entry, ATS_MARKER_TIME);
  var newIdx = addWorldEntry(KEYS_TIME, newBody);
  try{ worldInfo[newIdx].title = "Time"; }catch(_){}
  ATS.cards.timeIdx = newIdx;
}

/* Calendar card creation (exported) */
function injectCalendarInstructionsAndExamplesToNotes(calIdx){
  var lines = [
    "Instructions:",
    "",
    "Holidays:",
    "  - Fixed date: YYYY-MM-DD Name",
    "  - Annual (numeric): Annual: MM-DD Name",
    "  - Annual (nth): Annual: 1st Sunday of July Name",
    "",
    "Events (single-day):",
    "  - Fixed time: YYYY-MM-DD HH:MM–HH:MM Title @ Location",
    "  - Start-only: YYYY-MM-DD HH:MM Title @ Location",
    "",
    "Overnight events (single-day):",
    "  - Use HH:MM–HH:MM with end < start; spans midnight.",
    "    Example: 2071-08-26 23:00–02:00 Night shift @ Lab 3",
    "    Projects 23:00–23:59 on start day, and 00:00–02:00 on next day.",
    "",
    "Multi-day ranges (Option A):",
    "  - Syntax: YYYY-MM-DD..YYYY-MM-DD [HH:MM–HH:MM] Title @ Location",
    "  - Times apply to EACH day if provided; otherwise all-day.",
    "  - Range is inclusive."
  ];
  var examples = [
    "Examples:",
    "Holidays:",
    "  2071-12-25 Christmas",
    "  Annual: 12-25 Christmas",
    "  Annual: 1st Sunday of July Family Day",
    "",
    "Events:",
    "  2071-08-26 14:00–15:30 Board meeting @ Lab 3",
    "  2071-08-26 23:00–02:00 Overnight maintenance @ Lab 3",
    "  2071-08-26..2071-08-28 Conference @ HQ",
    "  2071-09-10..2071-09-12 09:00–17:00 Workshop @ Training Center",
    "  Every day 09:00–09:15 Standup @ Lab 3",
    "  Every week Monday 14:00–15:30 Sprint Review",
    "  Every month 15 10:00–11:00 Billing Run",
    "  Every year 12-31 23:00–00:30 New Year’s Bash @ Plaza",
    "  Every year 1st Sunday of July 12:00–16:00 Company Picnic @ Park"
  ];
  ensureNotes(calIdx, NOTES_MARKER_CAL_INSTR, lines.concat([""]).concat(examples));
}

function ensureCalendarCard() {
  // Helper: does this card look like a real ATS Calendar card?
  function isRealCalendarCard(wi) {
    return wi && String(wi.keys || "") === "__hud_calendar__" &&
           (wi.entry || wi.value || wi.text || "").indexOf("[[ATS AUTO CONTEXT]]") !== -1;
  }

  if (cardIndexIsValid(ATS.cards.calendarIdx)) {
    try {
      var wi = worldInfo[ATS.cards.calendarIdx];
      if (isRealCalendarCard(wi)) {
        wi.title = "Calendar";
      }
      injectCalendarInstructionsAndExamplesToNotes(ATS.cards.calendarIdx);
    } catch (_) {}
    return;
  }
  var idx = null;
  if (Array.isArray(worldInfo)) {
    for (var i = 0; i < worldInfo.length; i++) {
      var wi = worldInfo[i];
      if (isRealCalendarCard(wi)) { idx = i; break; }
    }
  }
  if (idx != null) {
    ATS.cards.calendarIdx = idx;
    try {
      var wi = worldInfo[idx];
      if (isRealCalendarCard(wi)) {
        wi.title = "Calendar";
      }
      injectCalendarInstructionsAndExamplesToNotes(idx);
    } catch (_) {}
    return;
  }
  var template = [
    "[[ATS AUTO CONTEXT]]",
    "CALENDAR",
    "",
    "-----Holiday-----",
    "",
    "-----Events-----",
    "",
    "-----Hours-----",
    "  09:00–18:00"
  ].join("\n");
  var newIdx = addWorldEntry("__hud_calendar__", template);
  ATS.cards.calendarIdx = newIdx;
  try {
    var wi = worldInfo[newIdx];
    if (isRealCalendarCard(wi)) {
      wi.title = "Calendar";
    }
  } catch (_) {}
}

try{ globalThis.ensureCalendarCard = ensureCalendarCard; }catch(_){}

/* Read Calendar text */
function readCalendarText(){ 
 try{ 
 if (Array.isArray(worldInfo)){
 for (var i=0;i<worldInfo.length;i++){ 
 var wi = worldInfo[i]; 
 if (wi && String(wi.keys||"")===KEYS_CALENDAR){ 
 ATS.cards.calendarIdx = i; 
 return getBodyText(wi); 
 } 
 } 
 } 
 if (Array.isArray(worldInfo)){
 for (var j=0;j<worldInfo.length;j++){ 
 var wt = worldInfo[j]; if (!wt) continue; 
 var titleU = String(wt.title||"").trim().toUpperCase(); 
 if (titleU==="CALENDAR"){ 
 try{ wt.keys = KEYS_CALENDAR; ATS.cards.calendarIdx = j; }catch(_){} 
 return getBodyText(wt); 
 } 
 } 
 } 
 // Fallback — pick the first entry that has dashed section markers
 if (Array.isArray(worldInfo)){
 for (var k=0;k<worldInfo.length;k++){ 
 var wk = worldInfo[k]; if (!wk) continue; 
 var bodyK = getBodyText(wk); 
 if (containsCalendarMarkers(bodyK)){
 try{ wk.keys = KEYS_CALENDAR; ATS.cards.calendarIdx = k; }catch(_){} 
 return bodyK; 
 } 
 } 
 } 
 }catch(_){} 
 return ""; 
} 

/* Hard order enforcement */

function enforceArrayOrder(){
  try{
    if (!Array.isArray(worldInfo)) return;
    var idxTime = findCardIndexByMarker(ATS_MARKER_TIME);
    var idxCal = findCalendarIndexByMarkerOrKey();
    var idxNames = findCardIndexByMarker(ATS_MARKER_NAMES);
    var idxSettings = findCardIndexByMarker(ATS_MARKER_SETTINGS);

    if (idxTime != null){
      moveIndexToPosition(idxTime, 0);
      idxCal = findCalendarIndexByMarkerOrKey();
    }
    if (idxCal != null) moveIndexToPosition(idxCal, 1);
    if (idxSettings != null) moveIndexToPosition(idxSettings, 2);
    if (idxNames != null){
      var target = (findCardIndexByMarker(ATS_MARKER_SETTINGS) != null) ? 3 : 2;
      moveIndexToPosition(idxNames, target);
    }
    for (var z=0; z<worldInfo.length; z++){
      var body = getBodyText(worldInfo[z]); if (!body) continue;
      if (body.indexOf(ATS_MARKER_TIME)!==-1)  try{ worldInfo[z].title="Time"; }catch(_){}
      if (body.indexOf(ATS_MARKER_SETTINGS)!==-1) try{ worldInfo[z].title="Time Settings"; }catch(_){}
      if (body.indexOf(ATS_MARKER_CAL_AUTO)!==-1) try{ worldInfo[z].title="Calendar"; }catch(_){}
      if (body.indexOf(ATS_MARKER_NAMES)!==-1) try{ worldInfo[z].title="Calendar Names"; }catch(_){}
    }
  }catch(_){}
}

/* Rebuild detector */
function isRebuildNeeded(){
  var hasTime     = (findCardIndexByMarker(ATS_MARKER_TIME)     != null);
  var hasCal      = (findCalendarIndexByMarkerOrKey()           != null);
  var hasSettings = (findCardIndexByMarker(ATS_MARKER_SETTINGS) != null);
  return (!hasTime && !hasCal && !hasSettings);
}

/* SMART CAP helper */
function applyDurationCap(minutesParsed, sourceText){
  var t = String(sourceText||"").toLowerCase();
  var explicitLongUnit =
    /\b(months?|years?|weeks?|days?)\b/.test(t) ||
    /\b\d+\s*(months?|years?|weeks?|days?)\b/.test(t);
  if (explicitLongUnit) return minutesParsed;
  var cap = (ATS.config && ATS.config.nlMaxMinutesCap!=null) ? (ATS.config.nlMaxMinutesCap|0) : (14*24*60);
  if (cap <= 0) return minutesParsed;
  return Math.min(minutesParsed, cap);
}

/* Standalone "the next ..." indicators */
function minutesForStandaloneNextIndicator(text){
  text = String(text||"");
  var lower = text.toLowerCase();
  var BLOCKERS = [
    "in the next ","within the next ","during the next ","over the next ",
    "somewhere in the next ","sometime in the next ","around the next "
  ];
  for (var i=0;i<BLOCKERS.length;i++){ if (lower.indexOf(BLOCKERS[i])!==-1) return 0; }
  function appearsStandalone(phrase){
    var escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var boundary = new RegExp('(?:^|[.\\n\\r;:\\!?\\)\"\'\-,]|\\bthen\\b)\\s*' + escaped + '\\b', 'i');
    return boundary.test(lower);
  }
  var c = ATS.clock;
  var morningHour = (ATS.config && ATS.config.morningHour!=null) ? (ATS.config.morningHour|0) : 8;
  var weekendStart = (ATS.config && ATS.config.weekendStart) ? ATS.config.weekendStart : { weekday:6, hour:9, minute:0 };
  function minutesUntilTomorrowAt(targetHour, targetMinute){
    targetHour = targetHour|0; targetMinute = targetMinute|0;
    var nowTotalMin = c.hour*60 + c.minute;
    var targetTotalMin = targetHour*60 + targetMinute;
    var deltaToday = targetTotalMin - nowTotalMin;
    return 24*60 + deltaToday;
  }
  function minutesUntilNextWeekdayAt(targetWeekday, targetHour, targetMinute){
    targetWeekday = targetWeekday|0; targetHour = targetHour|0; targetMinute = targetMinute|0;
    var nowTotalMin = c.hour*60 + c.minute;
    var todayWeekday = weekdayIndex(c.year,c.month,c.day);
    var dayDelta = (targetWeekday - todayWeekday + 7) % 7;
    var targetTotalMinToday = targetHour*60 + targetMinute;
    if (dayDelta===0 && targetTotalMinToday<=nowTotalMin) dayDelta = 7;
    var minutesToAdd = dayDelta*24*60 + (targetTotalMinToday - nowTotalMin);
    return minutesToAdd;
  }
  var candidates = [
    { key:"the next morning", compute:function(){ return minutesUntilTomorrowAt(morningHour,0); } },
    { key:"next morning",     compute:function(){ return minutesUntilTomorrowAt(morningHour,0); } },
    { key:"the next evening", compute:function(){ return minutesUntilTomorrowAt(18,0); } },
    { key:"next evening",     compute:function(){ return minutesUntilTomorrowAt(18,0); } },
    { key:"the next night",   compute:function(){ return minutesUntilTomorrowAt(21,0); } },
    { key:"next night",       compute:function(){ return minutesUntilTomorrowAt(21,0); } },
    { key:"the next day",     compute:function(){ return 24*60; } },
    { key:"next day",         compute:function(){ return 24*60; } },
    { key:"the next week",    compute:function(){ return 7*24*60; } },
    { key:"next week",        compute:function(){ return 7*24*60; } },
    { key:"the next weekend", compute:function(){ return minutesUntilNextWeekdayAt(weekendStart.weekday|0, weekendStart.hour|0, (weekendStart.minute|0)); } },
    { key:"next weekend",     compute:function(){ return minutesUntilNextWeekdayAt(weekendStart.weekday|0, weekendStart.hour|0, (weekendStart.minute|0)); } },
    { key:"the next month",   compute:function(){ return (ATS.config.monthDaysApprox|0) * 24 * 60; } },
    { key:"next month",       compute:function(){ return (ATS.config.monthDaysApprox|0) * 24 * 60; } },
    { key:"the next year",    compute:function(){ return (ATS.config.yearDaysApprox|0) * 24 * 60; } },
    { key:"next year",        compute:function(){ return (ATS.config.yearDaysApprox|0) * 24 * 60; } }
  ];
  var IMP_VERBS = ["wait","rest","sleep","nap","linger","idle","stand by","meditate","fast-forward","fast forward","skip"];
  for (var j=0;j<candidates.length;j++){ var cand = candidates[j]; if (appearsStandalone(cand.key)) return cand.compute(); }
  for (var k=0;k<candidates.length;k++){
    var cand2 = candidates[k]; var phrase = "until " + cand2.key;
    if (lower.indexOf(phrase)!==-1){
      var hasVerb = false;
      for (var v=0; v<IMP_VERBS.length; v++){ if (lower.indexOf(IMP_VERBS[v])!==-1){ hasVerb=true; break; } }
      if (hasVerb) return cand2.compute();
    }
  }
  for (var t=0;t<candidates.length;t++){
    var candX = candidates[t];
    var thenPhrase = new RegExp('\\bthen\\b\\s*' + candX.key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\b','i');
    if (thenPhrase.test(lower)) return candX.compute();
  }
  return 0;
}
try{ globalThis.minutesForStandaloneNextIndicator = minutesForStandaloneNextIndicator; }catch(_){}

/* === parseForTime (merged & robust) === */
var WORD_NUMS = { a:1, an:1, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirty:30, forty:40, fifty:50, sixty:60, couple:2 };
function parseNumberToken(tok){ tok=String(tok||"").trim().toLowerCase(); if (WORD_NUMS.hasOwnProperty(tok)) return WORD_NUMS[tok]; var f=parseFloat(tok); return isNaN(f)?null:f; }
function minutesFromUnitVal(val, unit){
  unit=String(unit||"").toLowerCase(); val=Number(val);
  if (unit.indexOf("min")===0) return Math.round(val);
  if (unit.indexOf("hour")===0 || unit.indexOf("hr")===0) return Math.round(val*60);
  if (unit.indexOf("day")===0)  return Math.round(val*60*24);
  if (unit.indexOf("week")===0) return Math.round(val*60*24*7);
  if (unit.indexOf("month")===0)return Math.round(val*60*24*(ATS.config.monthDaysApprox||30));
  if (unit.indexOf("year")===0) return Math.round(val*60*24*(ATS.config.yearDaysApprox||365));
  return null;
}
function minutesUntilNextHour(targetHour){ targetHour=(targetHour|0)%24; var c=ATS.clock; var now=c.hour*60 + c.minute; var tgt=targetHour*60; if (tgt<=now) tgt+=24*60; return tgt-now; }
function minutesUntilAbsoluteClock(text){
  text = String(text||"").toLowerCase();
  var m = text.match(/\b(?:until|by|at)\b\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?)*\b/);
  if (!m) return null;
  var hh=parseInt(m[1],10), mm = m[2]!=null ? parseInt(m[2],10) : 0;
  var ampm = m[3] ? m[3].replace(/\./g,'') : null;
  if (isNaN(hh)||hh<0||hh>23) return null;
  if (isNaN(mm)||mm<0||mm>59) return null;
  if (ampm){
    var isPM = (ampm==='pm');
    if (hh===12) hh = isPM ? 12 : 0;
    else if (isPM) hh = hh + 12;
  }
  var c = ATS.clock; var now = c.hour*60 + c.minute; var tgt = (hh%24)*60 + mm; if (tgt<=now) tgt += 24*60; return tgt - now;
}
function parseForTime(text){
  text = String(text||"");

  if (/a\s+little\s+while/i.test(text)) return ATS.config.idioms ? (ATS.config.idioms.littleWhileMinutes||10) : 10;
  if (/several\s+minutes?/i.test(text)) return ATS.config.idioms ? (ATS.config.idioms.severalMinutes||7) : 7;
  if (/\b(?:half(?:\s+of)?\s+(?:an?\s+)?hour|half\s*hour|half\s*an\s*hour)\b/i.test(text)) return 30;
  if (/\b(?:quarter(?:\s+of)?\s+(?:an?\s+)?hour|quarter\s*hour)\b/i.test(text)) return 15;
  if (/\b(?:three\s+quarters(?:\s+of)?\s+(?:an?\s+)?hour|¾\s*hour)\b/i.test(text)) return 45;

  var mFrac = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+and\s+a\s+(half|quarter)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/i);
  if (mFrac){ var base=parseNumberToken(mFrac[1])||0; var frac=(mFrac[2].toLowerCase()==='half')?0.5:0.25; return minutesFromUnitVal(base+frac, mFrac[3]); }

  var _nextDayMinutes = (function(){
    var t = String(text||""); var lower=t.toLowerCase();
    var blockers = [ "in the next ","within the next ","during the next ","over the next ","somewhere in the next ","sometime in the next ","around the next " ];
    for (var i=0;i<blockers.length;i++){ if (lower.indexOf(blockers[i])!==-1) return 0; }
    var boundaryDay = /(?:^|[.\n\r;:!\?,\"'\)\-\]\bthen\b])\s*(?:the\s+)?next\s+day\b/i;
    if (boundaryDay.test(t)) return 24*60;
    return 0;
  })();
  if ((_nextDayMinutes|0) > 0) return _nextDayMinutes;

  var nextIndicatorMins = minutesForStandaloneNextIndicator(text);
  if ((nextIndicatorMins|0) > 0) return nextIndicatorMins;

  var mActionNum = text.match(/\b(?:wait|rest|sleep|nap|linger|idle|stand\s*by|meditate|pass(?:\s+time)?|spend|travel|march|journey)\b[^.\n\r]*?(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/i);
  if (mActionNum){ var dec=parseNumberToken(mActionNum[1]); var minsDec=minutesFromUnitVal(dec, mActionNum[2]); if (minsDec!=null) return minsDec; }

  var mActionFor = text.match(/\b(?:wait|rest|sleep|nap|linger|idle|stand\s*by|meditate|pass(?:\s+time)?|spend|travel|march|journey)\b[^.\n\r]*?(?:for\s+)?(?:about\s+|around\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/i);
  if (mActionFor){ var n=parseNumberToken(mActionFor[1]); var mins2=minutesFromUnitVal(n, mActionFor[2]); if (mins2!=null) return mins2; }

  var mUntilNamed = text.match(/\b(?:sleep|rest|wait|linger|idle|stand\s*by|nap|meditate|pass(?:\s+time)?)\b[^.\n\r]*?\buntil\b\s+(dawn|morning|noon|evening|dusk|midnight|sunrise|sunset)\b/i);
  if (mUntilNamed){ var map={ dawn:6, morning:8, noon:12, evening:18, dusk:18, midnight:0, sunrise:6, sunset:18 }; var name=mUntilNamed[1].toLowerCase(); if (map.hasOwnProperty(name)) return minutesUntilNextHour(map[name]); }

  var absDelta = minutesUntilAbsoluteClock(text); if (absDelta!=null) return absDelta;

  if (/\bshort\s+rest(?:ed|ing)?\b/i.test(text)) return 60;
  if (/\blong\s+rest(?:ed|ing)?\b/i.test(text)) return 8*60;
  if (/\b(?:sleep(?:s|ing|ed)?|fell\s+asleep|falls\s+asleep|doze(?:s|d)?\s+off|drift(?:s|ed)?\s+off)\b/i.test(text)) return 8*60;
  if (/\b(?:nap(?:s|ping|ped)?|take(?:s|n)?\s+a\s+nap|took\s+a\s+nap)\b/i.test(text)) return 2*60;
  if (/\b(?:rest(?:s|ed|ing)?|take(?:s|n)?\s+a\s+rest|took\s+a\s+rest)\b/i.test(text)) return (ATS.clock.minutesPerTurn||5)*6;
  if (/\b(?:wait(?:s|ed|ing)?|linger(?:s|ed|ing)?|idle(?:s|d|ing)?|stand\s*by)\b/i.test(text)) return (ATS.clock.minutesPerTurn||5)*3;

  
 // "A day goes by", "Three hours go by", "Centuries go by"
 var mGoesBy = text.match(/(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple|few|several|\d+(?:\.\d+)?)?\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|years?|decades?|centuries?|millennia?)\s+go(?:es)?\s+by(?!\s+(that|when|where|without|but|unless|if|as|since|because))/i);
 if (mGoesBy){
   var tok = (mGoesBy[1]||'').toLowerCase();
   var valGB;
   if (!tok) valGB = 1; else if (tok==='couple') valGB = 2; else if (tok==='few') valGB = 3; else if (tok==='several') valGB = 7; else valGB = parseNumberToken(tok)||1;
   var unitGB = mGoesBy[2];
   var minsGB = minutesFromUnitVal(valGB, unitGB);
   if (minsGB!=null) return minsGB;
 }
 // "Time passes/goes by/slips by" -> default 60 minutes
 var mTimePasses = text.match(/time\s+(passes|goes\s+by|slips\s+by)(?!\s+(that|when|where|without|but|unless|if|as|since|because))/i);
 if (mTimePasses){ return 60; }
 // "After a while" / "After some time" -> default 30 minutes
 var mAfterWhile = text.match(/after\s+(a\s+while|some\s+time)/i);
 if (mAfterWhile){ return 30; }
 // "The next X passes/goes by"
 var mNextPasses = text.match(/the\s+next\s+(few|several|couple\s+of|\d+(?:\.\d+)?)?\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|years?|decades?|centuries?|millennia?)\s+(passes|goes\s+by)/i);
 if (mNextPasses){
   var q = (mNextPasses[1]||'').toLowerCase();
   var valNP = !q?1 : (q.indexOf('couple')!==-1?2 : (q==='few'?3 : (q==='several'?7 : parseFloat(q))));
   if (isNaN(valNP)) valNP = 1;
   var unitNP = mNextPasses[2];
   var minsNP = minutesFromUnitVal(valNP, unitNP);
   if (minsNP!=null) return minsNP;
 }
 // "Before long, X has passed/have passed"
 var mBeforeLong = text.match(/before\s+long,\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|several|couple|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|years?|decades?|centuries?|millennia?)\s+ha(?:s|ve)\s+passed/i);
 if (mBeforeLong){
   var tokBL = (mBeforeLong[1]||'').toLowerCase();
   var valBL = tokBL==='couple'?2 : tokBL==='few'?3 : tokBL==='several'?7 : (parseNumberToken(tokBL)||1);
   var unitBL = mBeforeLong[2];
   var minsBL = minutesFromUnitVal(valBL, unitBL);
   if (minsBL!=null) return minsBL;
 }
 // "By morning/noon/evening/night/midnight" -> jump to next named time
 var mByNamed = text.match(/by\s+(morning|noon|evening|night|midnight)/i);
 if (mByNamed){
   var mapBN = { morning:8, noon:12, evening:18, night:21, midnight:0 };
   return minutesUntilNextHour(mapBN[mByNamed[1].toLowerCase()]);
 }
 // "Nothing happens for X units"
 var mNothingFor = text.match(/nothing\s+happens\s+for\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|several|couple|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|years?|decades?|centuries?|millennia?)/i);
 if (mNothingFor){
   var tokNH = (mNothingFor[1]||'').toLowerCase();
   var valNH = tokNH==='couple'?2 : tokNH==='few'?3 : tokNH==='several'?7 : (parseNumberToken(tokNH)||1);
   var unitNH = mNothingFor[2];
   var minsNH = minutesFromUnitVal(valNH, unitNH);
   if (minsNH!=null) return minsNH;
 }
 // "The hours/days drag on" or "crawl by" -> default 60 minutes
 var mDragCrawl = text.match(/the\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|years?)\s+(drag\s+on|crawl\s+by)/i);
 if (mDragCrawl){ return 60; }
var mPass = text.match(/\b(?:(?:a|an|\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple)\s+)?(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+pass(?:es)?|go(?:es)?\s+by\b/i);
  if (mPass){
    var quantMatch = text.match(/\b(a|an|\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple)\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+pass(?:es)?|go(?:es)?\s+by\b/i);
    var val = quantMatch ? parseNumberToken(quantMatch[1]) : 1;
    var unit = mPass[1];
    var minsPass = minutesFromUnitVal(val||1, unit);
    if (minsPass!=null) return minsPass;
  }

  var mXLater = text.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple)\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+later\b/i);
  if (mXLater){ var valXL=parseNumberToken(mXLater[1]); var unitXL=mXLater[2]; var minsXL=minutesFromUnitVal(valXL||1, unitXL); if (minsXL!=null) return minsXL; }

  var TRAIN_VERBS = "(?:train|practice|study|research|drill|drills|work\\s*out|workout|spar|sparring|exercise|prepare|meditate)";
  var mTrainFor = text.match(new RegExp("\\b"+TRAIN_VERBS+"\\b[^.\\n\\r]*?(?:for\\s+)?(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple)\\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\\b","i"));
  if (mTrainFor){ var valTrain=parseNumberToken(mTrainFor[1]); var minsTrain=minutesFromUnitVal(valTrain, mTrainFor[2]); if (minsTrain!=null) return minsTrain; }
  var mTrainCompact = text.match(new RegExp("\\b"+TRAIN_VERBS+"\\b\\s+(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|couple)\\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\\b","i"));
  if (mTrainCompact){ var valTC=parseNumberToken(mTrainCompact[1]); var minsTC=minutesFromUnitVal(valTC, mTrainCompact[2]); if (minsTC!=null) return minsTC; }

  if (/\btomorrow\b/i.test(text)) return 24*60;
  if (/\bday\s+after\s+tomorrow\b/i.test(text)) return 2*24*60;
  if (/\btonight\b/i.test(text)) return minutesUntilNextHour(21);
  if (/\bnext\s+week\b/i.test(text)) return 7*24*60;
  if (/\bnext\s+month\b/i.test(text)) return ATS.config.monthDaysApprox * 24 * 60;
  if (/\bnext\s+year\b/i.test(text)) return ATS.config.yearDaysApprox * 24 * 60;
  var morningHour = (ATS.config && ATS.config.morningHour!=null) ? (ATS.config.morningHour|0) : 8;
  if (/\btomorrow\s+morning\b/i.test(text)) return (24*60) + (morningHour*60);

  return 0;
}

/* ====== Epoch-style /time commands (integrated) ====== */

(function(){
  function toInt(x){ var n=parseInt(x,10); return isNaN(n)?0:n; }
  function _getClock(){ return (globalThis.state && state._ats && state._ats.clock) ? state._ats.clock : null; }

  try {
    globalThis.ATS_timeCommand = function(text){
      var t = String(text||"");
      var low = t.toLowerCase();

      // --- /time set YYYY-MM-DD HH:MM ---
      var mSet = low.match(/\/time\s+set\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
      if (mSet){
        var clock = _getClock();
        if (clock){
          var iso = mSet[1], hm = mSet[2].split(":");
          var Y = toInt(iso.slice(0,4)), M = toInt(iso.slice(5,7)), D = toInt(iso.slice(8,10));
          var H = toInt(hm[0]), Min = toInt(hm[1]);
          clock.year = Y; clock.month = M; clock.day = D;
          clock.hour = clamp(H,0,23); clock.minute = clamp(Min,0,59);
          try{ state._ats.pendingMinutes = 0; }catch(_){}
        }
        // structured report line
        ATS_pushReport("⟦TIME⟧ SET → " + mSet[1] + " " + mSet[2] + " | now " + ATS_formatClockShort());
        return text;
      }

      // --- /time add <N>[m|h|d] ---
      var mAdd = low.match(/\/time\s+add\s+(\d+(?:\.\d+)?)([mhd])/);
      if (mAdd){
        var val = parseFloat(mAdd[1]||"0"), unit = mAdd[2], mins = 0;
        if (unit === 'm') mins = Math.round(val);
        else if (unit === 'h') mins = Math.round(val*60);
        else if (unit === 'd') mins = Math.round(val*60*24);

        // snapshot BEFORE advancing time
        var before = snapshotClock();
        recordAdvance(mins, 'command');

        // perform the advance (both global and local, guarded)
        try{ if (typeof globalThis.tickMinutes === 'function') globalThis.tickMinutes(mins); }catch(_){}
        try{ tickMinutes(mins); }catch(_){}

        try{ state._ats.pendingMinutes = 0; }catch(_){}

        // structured report line
        ATS_pushReport(
          "⟦TIME⟧ ADD " + ATS_fmtDelta(mins) +
          " | " + pad2(before.hour) + ":" + pad2(before.minute) +
          " → " + pad2(ATS.clock.hour) + ":" + pad2(ATS.clock.minute) +
          " | " + before.year + "-" + pad2(before.month) + "-" + pad2(before.day) +
          " → " + ATS.clock.year + "-" + pad2(ATS.clock.month) + "-" + pad2(ATS.clock.day)
        );

        return text;
      }

      // --- /time undo ---
      if (/\/time\s+undo\b/.test(low)){
        var ok = false;
        try { ok = undoLastAdvance(); } catch (_) {}
        ATS_pushReport("⟦TIME⟧ UNDO " + (ok ? "✓" : "✗ (no history)"));
        return text;
      }

      // default: no match
      return text;
    };
  } catch(_){}
})();


/* ====== Settings card (patched: commands only in Notes) ====== */
var NOTES_MARKER_COMMANDS = "[ATS Notes:TimeCommands]";
function buildCommandsLines(){
  return [
    "Commands:",
    "",
    "Time control:",
    "  /time set YYYY-MM-DD HH:MM    - Set clock to an exact date and 24h time.",
    "  /time add <N><m|h|d>           - Advance by minutes (m), hours (h), or days (d).",
    "    Examples: /time add 90m   /time add 2h   /time add 1d",
    "  /time undo                      - Revert the last time advance (NL, tick, or /time add).",
    "",
    "Turn tick (passive time per turn):",
    "  /tick on                       - Enable passive time advance each turn.",
    "  /tick off                      - Disable passive time advance.",
    "  Natural language:              - You can type 'per-turn 5 minutes' or 'time per tick 2 hours'.",
    "",
    "HUD banner (day rollover banner):",
    "  /hud banner on|off             - Toggle banner visibility.",
    "  /hud holidays on|off           - Show or hide holiday line.",
    "  /hud events on|off             - Show or hide events line.",
    "  /hud moon on|off               - Show or hide moon emoji.",
    "  /hud compact on|off            - Compact event summary in banner.",
    "",
    "Calendar auto-context:",
    "  The Calendar card header is auto-updated to inform the model about date, time, events.",
    "",
    "Named time shortcuts (type naturally in story text):",
    "  'wait until morning', 'until evening', 'until midnight', 'tomorrow', 'next weekend', etc.",
    "  The parser will advance time automatically when these phrases appear."
  ];
}
function ensureSettingsCard(){
  var idx = findCardIndexByMarker(ATS_MARKER_SETTINGS);
  var baseHeader = [
    "Time Settings",
    "",
    "All configuration is via slash commands only.",
    "(See the Notes section for the full list of commands.)"
  ].join("\n");

  if (idx != null){
    var body = getBodyText(worldInfo[idx]);
    var withMarker = embedMarkerOnce(body, ATS_MARKER_SETTINGS);
    updateWorldEntry(idx, KEYS_SETTINGS, withMarker);
    try{ worldInfo[idx].title="Time Settings"; }catch(_){}
    ATS.cards.settingsIdx = idx;

    var reBlock = /(?:^|\n)Commands:\n[\s\S]*$/;
    var cleaned = withMarker.replace(reBlock, "").replace(/\n{3,}/g,"\n\n").trim();
    updateWorldEntry(idx, KEYS_SETTINGS, cleaned);
    ensureNotes(idx, NOTES_MARKER_COMMANDS, buildCommandsLines());
    ensureNotes(idx, NOTES_MARKER_SETTINGS, [
      "These settings apply to the HUD: Time & Calendar.",
      "Editing is safe. Commands are idempotent."
    ]);
    return;
  }

  var newBody = embedMarkerOnce(baseHeader, ATS_MARKER_SETTINGS);
  var newIdx = addWorldEntry(KEYS_SETTINGS, newBody);
  try{ worldInfo[newIdx].title="Time Settings"; }catch(_){}
  ATS.cards.settingsIdx = newIdx;

  ensureNotes(newIdx, NOTES_MARKER_COMMANDS, buildCommandsLines());
  ensureNotes(newIdx, NOTES_MARKER_SETTINGS, [
    "These settings apply to the HUD: Time & Calendar.",
    "Editing is safe. Commands are idempotent."
  ]);
}
try{ globalThis.ensureSettingsCard = ensureSettingsCard; }catch(_){}

/* Input/Output Hooks */
globalThis.ATS_onInput = function(text){
  try{
    var t = String(text||"");
    var idx = t.indexOf("/tick ");
    if (idx!==-1){
      var tok = t.slice(idx+6).split(/\s+/)[0].trim().toLowerCase();
      var before = ATS.clock.minutesPerTurn|0;
      var val = null;
      if (tok==="off"||tok==="disable"||tok==="disabled"||tok==="none"||tok==="0") val = 0;
      else if (tok==="on") val = (ATS.clock.minutesPerTurn>0?ATS.clock.minutesPerTurn:5);
      else {
        var num = parseFloat(tok);
        if (!isNaN(num)){ if (tok.indexOf("h")!==-1) val = Math.round(num*60); else val = Math.round(num); }
      }
      if (val!=null){
        ATS.clock.minutesPerTurn = clamp(val,0,1440);
        ATS._tickChangedThisTurn = ((ATS.clock.minutesPerTurn|0)!==before);
      }
    }

    var lower = t.toLowerCase();
    var phraseIdx = lower.indexOf("per-turn");
    if (phraseIdx===-1) phraseIdx = lower.indexOf("time per tick");
    if (phraseIdx!==-1){
      var NUMS = ["minutes","minute","mins","min","hours","hour","hrs","hr"];
      var unit = null;
      for (var uu=0;uu<NUMS.length;uu++){ if (lower.indexOf(NUMS[uu])!==-1){ unit=NUMS[uu]; break; } }
      var numMatch = lower.match(/(\d+(?:\.\d+)?)/);
      if (unit && numMatch){
        var n = parseFloat(numMatch[1]);
        var mins = (unit.indexOf("hour")!==-1 || unit.indexOf("hr")!==-1) ? Math.round(n*60) : Math.round(n);
        var before2 = ATS.clock.minutesPerTurn|0;
        ATS.clock.minutesPerTurn = clamp(mins,0,1440);
        ATS._tickChangedThisTurn = ((ATS.clock.minutesPerTurn|0)!==before2);
      }
    }

    var hudIdx = t.indexOf("/hud ");
    if (hudIdx!==-1){
      var tail = t.slice(hudIdx+5).trim().toLowerCase();
      if (tail.indexOf("islamic")===0){
        var arg = tail.slice(8).trim();
        ATS.config.showIslamic = /^(on|enable|enabled)$/i.test(arg);
      } else if (tail.indexOf("chinese")===0){
        var arg2 = tail.slice(8).trim();
        ATS.config.showChinese = /^(on|enable|enabled)$/i.test(arg2);
      } else if (tail.indexOf("banner")===0){
        var arg3 = tail.slice(7).trim();
        if (/^(on|enable|enabled)$/i.test(arg3)) ATS.config.showDailyBanner = true;
        else if (/^(off|disable|disabled)$/i.test(arg3)) ATS.config.showDailyBanner = false;
        else {
          var parts = arg3.split(/\s+/);
          var section = parts[0]||"";
          var opt = (parts[1]||"").trim();
          var isOn  = /^(on|enable|enabled)$/i.test(opt);
          var isOff = /^(off|disable|disabled)$/i.test(opt);
          if (section==="holidays") ATS.config.bannerShowHolidays = isOn ? true : (isOff ? false : ATS.config.bannerShowHolidays);
          else if (section==="events") ATS.config.bannerShowEvents = isOn ? true : (isOff ? false : ATS.config.bannerShowEvents);
          else if (section==="moon")   ATS.config.bannerShowMoon    = isOn ? true : (isOff ? false : ATS.config.bannerShowMoon);
          else if (section==="compact")ATS.config.bannerCompact     = isOn ? true : (isOff ? false : ATS.config.bannerCompact);
        }
      }
    }

    if (hudIdx !== -1) {
    ATS_pushReport("⟦HUD⟧ banner:" + (ATS.config.showDailyBanner?"ON":"OFF") +  " holidays:" + (ATS.config.bannerShowHolidays?"ON":"OFF") + " events:" + (ATS.config.bannerShowEvents?"ON":"OFF") + " moon:" + (ATS.config.bannerShowMoon?"ON":"OFF") + " compact:" + (ATS.config.bannerCompact?"ON":"OFF") + " islamic:" + (ATS.config.showIslamic?"ON":"OFF") + " chinese:" + (ATS.config.showChinese?"ON":"OFF"));
  }
    var addNL = parseForTime(t);
    if ((addNL|0) > 0){
      ATS.pendingMinutes = (ATS.pendingMinutes|0) + applyDurationCap(addNL, t);
    }
  }catch(e){}
  return text;
};


/* ===== Names card (months & weekdays) ===== */
var ATS_MARKER_NAMES = "[[ATS:NAMES]]";
var SIG_NAMES = "__hud_names__";
var KEYS_NAMES = SIG_NAMES;

function buildNamesCardBody(){
  var N = ATS.config.names;
  function csv(arr){ return (arr||[]).join(", "); }
  return [
    ATS_MARKER_NAMES,
    "Calendar Names",
    "",
    "Months:",
    csv(N.months),
    "",
    "Weekdays:",
    csv(N.weekdays),
    "",
    "Aliases (optional):",
    "Months: Jan=January; Feb=February",
    "Weekdays: Mon=Monday; Friyay=Friday",
    "",
    "Tip: Edit the lines above to rename months/weekdays or add aliases.",
    "Parsing recognizes both main names and aliases."
  ].join("\n");
}


function ensureNamesNotes(idx){
  try{
    ensureNotes(idx, "[ATS Notes:CalendarNames]", [
      "Edit the body lines:",
      "- Months: 12 names separated by commas.",
      "- Weekdays: 7 names separated by commas.",
      "- Aliases: 'Months: Alias=Primary; Alias2=Primary2' and 'Weekdays: Alias=Primary'.",
      "Counts must be 12 and 7 respectively for main lists.",
      "Aliases map extra names to the primary ones you listed."
    ]);
  }catch(_){}
}

function ensureNamesCard(){
  var idx = null;
  // Find by key first
  if (Array.isArray(worldInfo)){
    for (var i=0;i<worldInfo.length;i++){
      var wi = worldInfo[i]; if (!wi) continue;
      if (String(wi.keys||"")===KEYS_NAMES){ idx = i; break; }
    }
  }
  // If not found by key, try marker and set key
  if (idx == null){
    idx = findCardIndexByMarker(ATS_MARKER_NAMES);
    if (idx != null){ try{ worldInfo[idx].keys = KEYS_NAMES; }catch(_){} }
  }
  if (idx != null){
    // EXISTING CARD: preserve body; only ensure marker & title
    try{
      var body = getBodyText(worldInfo[idx]) || "";
      var withMarker = embedMarkerOnce(body, ATS_MARKER_NAMES);
      if (withMarker !== body){ updateWorldEntry(idx, KEYS_NAMES, withMarker); }
      else { updateWorldEntry(idx, KEYS_NAMES, body); }
      try{ worldInfo[idx].title = "Calendar Names"; }catch(_){}
      ATS.cards.namesIdx = idx;
      ensureNamesNotes(idx);
    }catch(_){}
    return;
  }
  // CREATE card once with starter body
  var newIdx = addWorldEntry(KEYS_NAMES, buildNamesCardBody());
  try{ worldInfo[newIdx].title = "Calendar Names"; }catch(_){}
  ATS.cards.namesIdx = newIdx;
  ensureNamesNotes(newIdx);
}
try{ globalThis.ensureNamesCard = ensureNamesCard; }catch(_){}
function _splitCSVLineToArray(line){
  return String(line||"").split(",").map(function(s){
    return s.replace(/\u00A0/g,"").replace(/\u200B/g,"").trim();
  }).filter(Boolean);
}

function readNamesCard(){
  var body = "";
  if (Array.isArray(worldInfo)){
    for (var i=0;i<worldInfo.length;i++){
      var wi = worldInfo[i]; if (!wi) continue;
      if (String(wi.keys||"")===KEYS_NAMES){
        ATS.cards.namesIdx = i;
        body = getBodyText(wi);
        break;
      }
    }
  }
  if (!body) {
    var idx = findCardIndexByMarker(ATS_MARKER_NAMES);
    if (idx != null) {
      ATS.cards.namesIdx = idx;
      body = getBodyText(worldInfo[idx]);
      try{ worldInfo[idx].keys = KEYS_NAMES; }catch(_){}
    }
  }
  if (!body) return;

  var lines = String(body).split(/\r?\n/);
  var months = null, weekdays = null, aliasesMonths = {}, aliasesWeekdays = {};
  var section = null;

  function parseAliases(line, kind){
    var m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+)$/);
    if (!m) return;
    var bucket = (kind==="Months" ? aliasesMonths : aliasesWeekdays);
    m[2].split(";").forEach(function(pair){
      var p = pair.trim();
      if (!p) return;
      var kv = p.split("=");
      if (kv.length===2){
        var alias = kv[0].trim();
        var target = kv[1].trim();
        if (alias && target) bucket[alias] = target;
      }
    });
  }

  for (var i=0;i<lines.length;i++){
    var raw = lines[i];
    var line = raw.trim();
    if (!line) continue;
    var u = line.toUpperCase();

    if (u==="MONTHS:" || u==="MONTHS") { section = "months"; continue; }
    if (u==="WEEKDAYS:" || u==="WEEKDAYS") { section = "weekdays"; continue; }
    if (u.indexOf("ALIASES")===0) { section = "aliases"; continue; }

    if (section==="months" && !months) months = _splitCSVLineToArray(line);
    else if (section==="weekdays" && !weekdays) weekdays = _splitCSVLineToArray(line);
    else if (section==="aliases"){
      if (/^Months:/i.test(line)) parseAliases(line, "Months");
      else if (/^Weekdays:/i.test(line)) parseAliases(line, "Weekdays");
    }
  }

  if (Array.isArray(months) && months.length===12) ATS.config.names.months = months;
  if (Array.isArray(weekdays) && weekdays.length===7) ATS.config.names.weekdays = weekdays;

  ATS.config.names.aliases = {
    months: aliasesMonths,
    weekdays: aliasesWeekdays
  };
}
try{ globalThis.readNamesCard = readNamesCard; }catch(_){}

function rebuildMonthWeekdayMaps(){
  var N = ATS.config.names;
  var mm = Object.create(null);
  for (var i=0;i<12;i++){
    var name = String(N.months[i]||"").toLowerCase();
    if (name) mm[name] = i+1;
  }
  var am = N.aliases && N.aliases.months ? N.aliases.months : {};
  Object.keys(am).forEach(function(alias){
    var tgt = String(am[alias]||"").toLowerCase();
    var idx = mm[tgt];
    if (idx!=null) mm[String(alias).toLowerCase()] = idx;
  });
  var wm = Object.create(null);
  for (var j=0;j<7;j++){
    var wname = String(N.weekdays[j]||"").toLowerCase();
    if (wname) wm[wname] = j;
  }
  var aw = N.aliases && N.aliases.weekdays ? N.aliases.weekdays : {};
  Object.keys(aw).forEach(function(alias){
    var tgt = String(aw[alias]||"").toLowerCase();
    var idx = wm[tgt];
    if (idx!=null) wm[String(alias).toLowerCase()] = idx;
  });
  ATS._namesMaps.monthNameMap = mm;
  ATS._namesMaps.weekdayNameMap = wm;
}
try{ globalThis.rebuildMonthWeekdayMaps = rebuildMonthWeekdayMaps; }catch(_){}

globalThis.ATS_onOutput = function(text){
  
// Report-only turn: print structured lines, suppress LLM prose and banner
if (ATS.cmd && ATS.cmd.suppressLLM && ATS.cmd.lines && ATS.cmd.lines.length) {
  try { createOrRecoverTimeCard(); } catch (_){}
  try { if (globalThis.ensureCalendarCard) globalThis.ensureCalendarCard(); } catch (_){}
  try { updateCalendarCardForLLM(); } catch (_){}
  ATS._bannerPrintedThisTurn = true;

  // Build report block using escaped newlines, not literal newlines
  var reportBlock = "[ATS REPORT]\n" + ATS.cmd.lines.join("\n") + "\n";

  // Clear and reset so the following turn behaves normally
  ATS.cmd.lines = [];
  ATS.cmd.suppressLLM = false;

  // IMPORTANT: leading "!" prevents AI Dungeon from adding "You ..." / "You say ..."
  return "!\n\n" + reportBlock;
}

  ATS.appliedFromTextThisTurn = false;
  ATS._bannerPrintedThisTurn  = false;

  var rebuild = isRebuildNeeded();
  if (rebuild){
    createOrRecoverTimeCard();
    if (globalThis.ensureCalendarCard){ globalThis.ensureCalendarCard(); }
    parseSettingsTogglesFromCard();
    ensureSettingsCard();
    refreshSettingsCardToggles();
    enforceArrayOrder();
  } else {
    parseSettingsTogglesFromCard();
    ensureSettingsCard();
    refreshSettingsCardToggles();
    createOrRecoverTimeCard();
    if (globalThis.ensureCalendarCard){ globalThis.ensureCalendarCard(); }
    enforceArrayOrder();
  }

  if (ATS._tickChangedThisTurn) ATS.pendingMinutes = 0;

  if ((ATS.pendingMinutes|0)===0){
    try{
      var addOutNL = parseForTime(String(text||""));
      if ((addOutNL|0) > 0){
        ATS.pendingMinutes = (ATS.pendingMinutes|0) + applyDurationCap(addOutNL, String(text||""));
      }
    }catch(_){}
  }

  if ((ATS.pendingMinutes|0) > 0){
    var applied = ATS.pendingMinutes|0;
    recordAdvance(applied, 'nl');
    tickMinutes(applied);
    ATS.pendingMinutes = 0;
    ATS.appliedFromTextThisTurn = true;
  }

  if (!ATS.appliedFromTextThisTurn && (ATS.clock.minutesPerTurn|0) > 0) {
    recordAdvance(ATS.clock.minutesPerTurn|0, 'tick');
    passiveTurnAdvance();
  }

   try { if (typeof globalThis.ensureNamesCard === 'function') globalThis.ensureNamesCard(); } catch(_){}
  try { if (typeof globalThis.readNamesCard === 'function') globalThis.readNamesCard(); } catch(_){}
  try { if (typeof globalThis.rebuildMonthWeekdayMaps === 'function') globalThis.rebuildMonthWeekdayMaps(); } catch(_){}
 var calTxt = readCalendarText();
  if (globalThis.parseCalendarText){ globalThis.parseCalendarText(calTxt); }
  if (globalThis.crossRefCalendarForToday){ globalThis.crossRefCalendarForToday(); }

  (function(){
    if (!ATS.config.showDailyBanner) return;
    if (ATS._bannerPrintedThisTurn) return;

    var currentISO = toISODate(ATS.clock.year, ATS.clock.month, ATS.clock.day);
    var markerLine = formatLongDateLine(ATS.clock.year, ATS.clock.month, ATS.clock.day);

    if (text.indexOf(markerLine)!==-1){ ATS._bannerPrintedThisTurn = true; return; }

    if (ATS.dailyBanner.lastISO !== currentISO){
      var banner = buildDayRolloverBanner(moonPhaseInfo(ATS.clock.year, ATS.clock.month, ATS.clock.day));

      text = text.replace(/^\s*Time:\s*\d{2}:\d{2}.*?(?:\n|$)/, '');
      text = text.replace(/^\s*Holiday\(s\):.*?(?:\n|$)/, '');

      text = "\n\n" + banner + text;

      ATS.dailyBanner.lastISO = currentISO;
      ATS._bannerPrintedThisTurn = true;
    }
  })();

  updateCalendarCardForLLM();
  enforceArrayOrder();
  createOrRecoverTimeCard();
  enforceArrayOrder();
  ATS._tickChangedThisTurn = false;
  return text;
};

globalThis.ATS_onContext = function(text){ return text; };


// --- General helpers (moved from Context.js) ---
function timeOfDayLabel(h, m) {
  h = h|0; m = m|0;
  var c = (state && state._ats && state._ats.config) ? state._ats.config : {};
  var dH = c.dawnHour|0, dM = c.dawnMinute|0, kH = c.duskHour|0, kM = c.duskMinute|0;
  if (h === 0) return "midnight";
  if (h >= 1 && h <= 4) return "late night";
  if (h === dH && m < dM) return "pre‑dawn";
  if (h === dH && m >= dM) return "dawn";
  if (h === (dH+1)) return "dawn";
  if (h >= 7 && h <= 11) return "morning";
  if (h === 12) return "noon";
  if (h >= 13 && h <= 17) return "afternoon";
  if (h === (kH-1)) return "evening";
  if (h === kH && m < kM) return "evening";
  if (h === kH && m >= kM) return "dusk";
  if (h >= 20 && h <= 23) return "night";
  return "late night";
}

function buildClockLine() {
  try {
    var c = state._ats.clock, wd = weekdayNameLong(c.year, c.month, c.day);
    return wd + ", " + c.year + "-" + pad2(c.month) + "-" + pad2(c.day) + " " + pad2(c.hour) + ":" + pad2(c.minute);
  } catch(_) { return "(time unavailable)"; }
}

function tryMoonPhaseLine() {
  try {
    if (typeof moonPhaseInfo === 'function') {
      var c = state._ats.clock, mp = moonPhaseInfo(c.year, c.month, c.day);
      return " — Moon: " + mp.emoji + " " + mp.phase;
    }
  } catch(_) {}
  return "";
}

function flavorSuffix() {
  try {
    var f = (state._ats.config && state._ats.config.contextFlavor) || 'neutral';
    f = String(f).toLowerCase();
    if (f === 'fantasy') return "Align ambience, torches, watch rotations, and tavern hours to this time.";
    if (f === 'scifi' || f === 'sci-fi') return "Align station cycles, shift schedules, lighting bands, and system operations to this time.";
    if (f === 'modern') return "Align business hours, traffic, lighting, and daily routines to this time.";
    return "Align descriptions, lighting, schedules, and pacing to this time (e.g., sunrise/sunset, night watch, shops open/closed).";
  } catch(_) { return "Align descriptions, lighting, schedules, and pacing to this time."; }
}


// ====== Settings toggles (UI in card body) ======
function buildSettingsTogglesBody() {
  var c = ATS.clock || { minutesPerTurn: 0 };
  var cfg = ATS.config || {};
  function onOff(b) { return b ? "[ON]" : "[OFF]"; }
  function mptText() {
    var m = (c.minutesPerTurn||0);
    return m > 0 ? (m + "m [ON]") : "OFF";
  }
  var lines = [
    ATS_MARKER_SETTINGS,
    "Time Settings",
    "",
    "Toggles:",
    " Islamic calendar: " + onOff(!!cfg.showIslamic) + "   (/hud islamic on|off)",
    " Chinese calendar: " + onOff(!!cfg.showChinese) + "   (/hud chinese on|off)",
    " Day banner: " + onOff(!!cfg.showDailyBanner) + "   (/hud banner on|off)",
    "   Banner details:",
    "    - Holidays: " + onOff(!!cfg.bannerShowHolidays) + "   (/hud banner holidays on|off)",
    "    - Events:   " + onOff(!!cfg.bannerShowEvents)   + "   (/hud banner events on|off)",
    "    - Moon:     " + onOff(!!cfg.bannerShowMoon)     + "   (/hud banner moon on|off)",
    "    - Compact:  " + onOff(!!cfg.bannerCompact)      + "   (/hud banner compact on|off)",
    " Tick per turn: " + mptText() + "   (/tick on|off|<N>m|<N>h)",
    "",
    "Tip: Edit the ON/OFF tokens above (and the tick minutes) and the changes are applied next turn."
  ];
  return lines.join("\n");
}

function parseSettingsTogglesFromCard() {
  try {
    if (!Array.isArray(worldInfo)) return;
    var idx = findCardIndexByMarker(ATS_MARKER_SETTINGS);
    if (idx == null || !worldInfo[idx]) return;
    var body = getBodyText(worldInfo[idx]);
    if (!body) return;

    function pickFlag(label) {
      var re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + "\\s*:\\s*\\[(ON|OFF)\\]", "i");
      var m = body.match(re);
      if (!m) return null;
      return (m[1].toUpperCase() === "ON");
    }
    function pickTick() {
      var reOff = /Tick\s+per\s+turn:\s*OFF\b/i;
      if (reOff.test(body)) return 0;
      var reVal = /Tick\s+per\s+turn:\s*(\d+)\s*([mh])(?:\s*\[ON\])?/i;
      var m = body.match(reVal);
      if (!m) return null;
      var n = parseInt(m[1],10);
      var unit = (m[2]||"m").toLowerCase();
      if (isNaN(n) || n < 0) return null;
      return unit === "h" ? Math.min(n*60, 1440) : Math.min(n, 1440);
    }

    var islamic = pickFlag("Islamic calendar");
    var chinese = pickFlag("Chinese calendar");
    var banner  = pickFlag("Day banner");
    var bHol    = pickFlag("Holidays");
    var bEv     = pickFlag("Events");
    var bMoon   = pickFlag("Moon");
    var bComp   = pickFlag("Compact");
    var tickMin = pickTick();

    if (islamic !== null) ATS.config.showIslamic = !!islamic;
    if (chinese !== null) ATS.config.showChinese = !!chinese;
    if (banner  !== null) ATS.config.showDailyBanner = !!banner;
    if (bHol    !== null) ATS.config.bannerShowHolidays = !!bHol;
    if (bEv     !== null) ATS.config.bannerShowEvents   = !!bEv;
    if (bMoon   !== null) ATS.config.bannerShowMoon     = !!bMoon;
    if (bComp   !== null) ATS.config.bannerCompact      = !!bComp;
    if (tickMin !== null) {
      var before = ATS.clock.minutesPerTurn||0;
      ATS.clock.minutesPerTurn = clamp(tickMin, 0, 1440);
      ATS._tickChangedThisTurn = ((ATS.clock.minutesPerTurn||0) !== before);
    }
  } catch (_) {}
}

function refreshSettingsCardToggles() {
  try {
    var idx = ATS.cards && ATS.cards.settingsIdx;
    if (cardIndexIsValid(idx)) {
      var body = buildSettingsTogglesBody();
      updateWorldEntry(idx, KEYS_SETTINGS, body);
      try { worldInfo[idx].title = "Time Settings"; } catch(_) {}
    }
  } catch(_) {}
}

// Patch ensureSettingsCard to use toggles UI
function ensureSettingsCard() {
  var idx = findCardIndexByMarker(ATS_MARKER_SETTINGS);
  var togglesBody = buildSettingsTogglesBody();

  if (idx != null) {
    updateWorldEntry(idx, KEYS_SETTINGS, togglesBody);
    try { worldInfo[idx].title = "Time Settings"; } catch(_) {}
    ATS.cards.settingsIdx = idx;
    ensureNotes(idx, NOTES_MARKER_COMMANDS, buildCommandsLines());
    ensureNotes(idx, NOTES_MARKER_SETTINGS, [
      "These settings apply to the HUD: Time & Calendar.",
      "Editing is safe. Commands are idempotent."
    ]);
    return;
  }

  var newIdx = addWorldEntry(KEYS_SETTINGS, togglesBody);
  try { worldInfo[newIdx].title = "Time Settings"; } catch(_) {}
  ATS.cards.settingsIdx = newIdx;
  ensureNotes(newIdx, NOTES_MARKER_COMMANDS, buildCommandsLines());
  ensureNotes(newIdx, NOTES_MARKER_SETTINGS, [
    "These settings apply to the HUD: Time & Calendar.",
    "Editing is safe. Commands are idempotent."
  ]);
}


