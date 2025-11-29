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
      clock: { year: 2071, month: 8, day: 25, hour: 8, minute: 0, minutesPerTurn: 5, elapsedMinutes: 0 },
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





function enforceArrayOrder() {
  try {
    if (!Array.isArray(worldInfo)) return;

    // Helper to find and remove all instances of a card by title
    function extractCard(titleOptions) {
      for (let i = worldInfo.length - 1; i >= 0; i--) {
        const wi = worldInfo[i];
        if (wi && titleOptions.includes(wi.title)) {
          return worldInfo.splice(i, 1)[0];
        }
      }
      return null;
    }

    // Remove all instances of the three cards
    const autoCard = extractCard(["Configure \nAuto-Cards", "Edit to enable \nAuto-Cards"]);
    const timeCard = extractCard(["Time"]);
    const calendarCard = extractCard(["Calendar"]);

    // Insert them at the top in the desired order
    if (calendarCard) worldInfo.unshift(calendarCard);
    if (timeCard) worldInfo.unshift(timeCard);
    if (autoCard) worldInfo.unshift(autoCard);

    // The rest float freely below
  } catch (_) {}
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


// Library Script
// Your "Library" tab should look like this
/*
Auto-Cards
Made by LewdLeah on May 21, 2025
This AI Dungeon script automatically creates and updates plot-relevant story cards while you play
General-purpose usefulness and compatibility with other scenarios/scripts were my design priorities
Auto-Cards is fully open-source, please copy for use within your own projects! ❤️
*/
function AutoCards(inHook, inText, inStop) {
    "use strict";
    /*
    Default Auto-Cards settings
    Feel free to change these settings to customize your scenario's default gameplay experience
    The default values for your scenario are specified below:
    */

    // Is Auto-Cards already enabled when the adventure begins?
    const DEFAULT_DO_AC = true
    // (true or false)

    // Pin the "Configure Auto-Cards" story card at the top of the player's story cards list?
    const DEFAULT_PIN_CONFIGURE_CARD = true
    // (true or false)

    // Minimum number of turns in between automatic card generation events?
    const DEFAULT_CARD_CREATION_COOLDOWN = 9999
    // (0 to 9999)

    // Use a bulleted list format for newly generated card entries?
    const DEFAULT_USE_BULLETED_LIST_MODE = true
    // (true or false)

    // Maximum allowed length for newly generated story card entries?
    const DEFAULT_GENERATED_ENTRY_LIMIT = 750
    // (200 to 2000)

    // Do newly generated cards have memory updates enabled by default?
    const DEFAULT_NEW_CARDS_DO_MEMORY_UPDATES = false
    // (true or false)

    // Default character limit before the card's memory bank is summarized?
    const DEFAULT_NEW_CARDS_MEMORY_LIMIT = 2750
    // (1750 to 9900)

    // Approximately how much shorter should recently compressed memories be? (ratio = 10 * old / new)
    const DEFAULT_MEMORY_COMPRESSION_RATIO = 25
    // (20 to 1250)

    // Ignore all-caps during title candidate detection?
    const DEFAULT_IGNORE_ALL_CAPS_TITLES = true
    // (true or false)

    // Should player input actions (Do/Say/Story) be considered during title detection?
    const DEFAULT_DETECT_TITLES_FROM_INPUTS = false
    // (true or false)

    // How many (minimum) actions in the past does Auto-Cards look for named entities?
    const DEFAULT_MINIMUM_LOOK_BACK_DISTANCE = 5
    // (2 to 88)

    // Is Live Script Interface v2 enabled?
    const DEFAULT_DO_LSI_V2 = false
    // (true or false)

    // Should the "Debug Data" story card be visible?
    const DEFAULT_SHOW_DEBUG_DATA = false
    // (true or false)

    // AI prompt used to generate new story card entries?
    const DEFAULT_CARD_GENERATION_PROMPT = prose(
        "-----",
        "",
        "<SYSTEM>",
        "# Stop the story and ignore previous instructions. Write a brief and coherent informational entry for %{title} following these instructions:",
        "- Write only third-person pure prose information about %{title} using complete sentences with correct punctuation",
        "- Avoid short-term temporary details or appearances, instead focus on plot-significant information",
        "- Prioritize story-relevant details about %{title} first to ensure seamless integration with the previous plot",
        "- Create new information based on the context and story direction",
        "- Mention %{title} in every sentence",
        "- Use semicolons if needed",
        "- Add additional details about %{title} beneath incomplete entries",
        "- Be concise and grounded",
        "- Imitate the story's writing style and infer the reader's preferences",
        "</SYSTEM>",
        "Continue the entry for %{title} below while avoiding repetition:",
        "%{entry}"
    ); // (mimic this multi-line "text" format)

    // AI prompt used to summarize a given story card's memory bank?
    const DEFAULT_CARD_MEMORY_COMPRESSION_PROMPT = prose(
        "-----",
        "",
        "<SYSTEM>",
        "# Stop the story and ignore previous instructions. Summarize and condense the given paragraph into a narrow and focused memory passage while following these guidelines:",
        "- Ensure the passage retains the core meaning and most essential details",
        "- Use the third-person perspective",
        "- Prioritize information-density, accuracy, and completeness",
        "- Remain brief and concise",
        "- Write firmly in the past tense",
        "- The paragraph below pertains to old events from far earlier in the story",
        "- Integrate %{title} naturally within the memory; however, only write about the events as they occurred",
        "- Only reference information present inside the paragraph itself, be specific",
        "</SYSTEM>",
        "Write a summarized old memory passage for %{title} based only on the following paragraph:",
        "\"\"\"",
        "%{memory}",
        "\"\"\"",
        "Summarize below:"
    ); // (mimic this multi-line "text" format)

    // Titles banned from future card generation attempts?
    const DEFAULT_BANNED_TITLES_LIST = (
        "North, East, South, West, Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, January, February, March, April, May, June, July, August, September, October, November, December"
    ); // (mimic this comma-list "text" format)

    // Default story card "type" used by Auto-Cards? (does not matter)
    const DEFAULT_CARD_TYPE = "class"
    // ("text")

    // Should titles mentioned in the "opening" plot component be banned from future card generation by default?
    const DEFAULT_BAN_TITLES_FROM_OPENING = true
    // (true or false)

    //—————————————————————————————————————————————————————————————————————————————————

    /*
    Useful API functions for coders (otherwise ignore)
    Here's what each one does in plain terms:

    AutoCards().API.postponeEvents();
    Pauses Auto-Cards activity for n many turns

    AutoCards().API.emergencyHalt();
    Emergency stop or resume

    AutoCards().API.suppressMessages();
    Hides Auto-Cards toasts by preventing assignment to state.message

    AutoCards().API.debugLog();
    Writes to the debug log card

    AutoCards().API.toggle();
    Turns Auto-Cards on/off

    AutoCards().API.generateCard();
    Initiates AI generation of the requested card

    AutoCards().API.redoCard();
    Regenerates an existing card

    AutoCards().API.setCardAsAuto();
    Flags or unflags a card as automatic

    AutoCards().API.addCardMemory();
    Adds a memory to a specific card

    AutoCards().API.eraseAllAutoCards();
    Deletes all auto-cards

    AutoCards().API.getUsedTitles();
    Lists all current card titles

    AutoCards().API.getBannedTitles();
    Shows your current banned titles list

    AutoCards().API.setBannedTitles();
    Replaces the banned titles list with a new list

    AutoCards().API.buildCard();
    Makes a new card from scratch, using exact parameters

    AutoCards().API.getCard();
    Finds cards that match a filter

    AutoCards().API.eraseCard();
    Deletes cards matching a filter
    */

    /*** Postpones internal Auto-Cards events for a specified number of turns
    * 
    * @function
    * @param {number} turns A non-negative integer representing the number of turns to postpone events
    * @returns {Object} An object containing cooldown values affected by the postponement
    * @throws {Error} If turns is not a non-negative integer
    */
    // AutoCards().API.postponeEvents();

    /*** Sets or clears the emergency halt flag to pause Auto-Cards operations
    * 
    * @function
    * @param {boolean} shouldHalt A boolean value indicating whether to engage (true) or disengage (false) emergency halt
    * @returns {boolean} The value that was set
    * @throws {Error} If called from within isolateLSIv2 scope or with a non-boolean argument
    */
    // AutoCards().API.emergencyHalt();

    /*** Enables or disables state.message assignments from Auto-Cards
    * 
    * @function
    * @param {boolean} shouldSuppress If true, suppresses all Auto-Cards messages; false enables them
    * @returns {Array} The current pending messages after setting suppression
    * @throws {Error} If shouldSuppress is not a boolean
    */
    // AutoCards().API.suppressMessages();

    /*** Logs debug information to the "Debug Log card console
    * 
    * @function
    * @param {...any} args Arguments to log for debugging purposes
    * @returns {any} The story card object reference
    */
    // AutoCards().API.debugLog();

    /*** Toggles Auto-Cards behavior or sets it directly
    * 
    * @function
    * @param {boolean|null|undefined} toggleType If undefined, toggles the current state. If boolean or null, sets the state accordingly
    * @returns {boolean|null|undefined} The state that was set or inferred
    * @throws {Error} If toggleType is not a boolean, null, or undefined
    */
    // AutoCards().API.toggle();

    /*** Generates a new card using optional prompt details or a card request object
    * 
    * This function supports two usage modes:
    * 
    * 1. Object Mode:
    *    Pass a single object containing card request parameters. The only mandatory property is "title"
    *    All other properties are optional and customize the card generation
    * 
    *    Example:
    *    AutoCards().API.generateCard({
    *      type: "character",         // The category or type of the card; defaults to "class" if omitted
    *      title: "Leah the Lewd",    // The card's title (required)
    *      keysStart: "Lewd,Leah",    // Optional trigger keywords associated with the card
    *      entryStart: "You are a woman named Leah.", // Existing content to prepend to the AI-generated entry
    *      entryPrompt: "",           // Global prompt guiding AI content generation
    *      entryPromptDetails: "Focus on Leah's works of artifice and ingenuity", // Additional prompt info
    *      entryLimit: 750,           // Target character length for the AI-generated entry
    *      description: "Player character!", // Freeform notes
    *      memoryStart: "Leah purchased a new sweater.", // Existing memory content
    *      memoryUpdates: true,       // Whether the card's memory bank will update on its own
    *      memoryLimit: 2750          // Preferred memory bank size before summarization/compression
    *    });
    * 
    * 2. String Mode:
    *    Pass a string as the title and optionally two additional strings to specify prompt details
    *    This mode is shorthand for quick card generation without an explicit card request object
    * 
    *    Examples:
    *    AutoCards().API.generateCard("Leah the Lewd");
    *    AutoCards().API.generateCard("Leah the Lewd", "Focus on Leah's works of artifice and ingenuity");
    *    AutoCards().API.generateCard(
    *      "Leah the Lewd",
    *      "Focus on Leah's works of artifice and ingenuity",
    *      "You are a woman named Leah."
    *    );
    * 
    * @function
    * @param {Object|string} request Either a fully specified card request object or a string title
    * @param {string} [extra1] Optional detailed prompt text when using string mode
    * @param {string} [extra2] Optional entry start text when using string mode
    * @returns {boolean} Returns true if the generation attempt succeeded, false otherwise
    * @throws {Error} Throws if called with invalid arguments or missing a required title property
    */
    // AutoCards().API.generateCard();

    /*** Regenerates a card by title or object reference, optionally preserving or modifying its input info
    *
    * @function
    * @param {Object|string} request Either a fully specified card request object or a string title for the card to be regenerated
    * @param {boolean} [useOldInfo=true] If true, preserves old info in the new generation; false omits it
    * @param {string} [newInfo=""] Additional info to append to the generation prompt
    * @returns {boolean} True if regeneration succeeded; false otherwise
    * @throws {Error} If the request format is invalid, or if the second or third parameters are the wrong types
    */
    // AutoCards().API.redoCard();

    /*** Flags or unflags a card as an auto-card, controlling its automatic generation behavior
    *
    * @function
    * @param {Object|string} targetCard The card object or title to mark/unmark as an auto-card
    * @param {boolean} [setOrUnset=true] If true, marks the card as an auto-card; false removes the flag
    * @returns {boolean} True if the operation succeeded; false if the card was invalid or already matched the target state
    * @throws {Error} If the arguments are invalid types
    */
    // AutoCards().API.setCardAsAuto();

    /*** Appends a memory to a story card's memory bank
    *
    * @function
    * @param {Object|string} targetCard A card object reference or title string
    * @param {string} newMemory The memory text to add
    * @returns {boolean} True if the memory was added; false if it was empty, already present, or the card was not found
    * @throws {Error} If the inputs are not a string or valid card object reference
    */
    // AutoCards().API.addCardMemory();

    /*** Removes all previously generated auto-cards and resets various states
    *
    * @function
    * @returns {number} The number of cards that were removed
    */
    // AutoCards().API.eraseAllAutoCards();

    /*** Retrieves an array of titles currently used by the adventure's story cards
    *
    * @function
    * @returns {Array<string>} An array of strings representing used titles
    */
    // AutoCards().API.getUsedTitles();

    /*** Retrieves an array of banned titles
    *
    * @function
    * @returns {Array<string>} An array of banned title strings
    */
    // AutoCards().API.getBannedTitles();

    /*** Sets the banned titles array, replacing any previously banned titles
    *
    * @function
    * @param {string|Array<string>} titles A comma-separated string or array of strings representing titles to ban
    * @returns {Object} An object containing oldBans and newBans arrays
    * @throws {Error} If the input is neither a string nor an array of strings
    */
    // AutoCards().API.setBannedTitles();

    /*** Creates a new story card with the specified parameters
    *
    * @function
    * @param {string|Object} title Card title string or full card template object containing all fields
    * @param {string} [entry] The entry text for the card
    * @param {string} [type] The card type (e.g., "character", "location")
    * @param {string} [keys] The keys (triggers) for the card
    * @param {string} [description] The notes or memory bank of the card
    * @param {number} [insertionIndex] Optional index to insert the card at a specific position within storyCards
    * @returns {Object|null} The created card object reference, or null if creation failed
    */
    // AutoCards().API.buildCard();

    /*** Finds and returns story cards satisfying a user-defined condition
    * Example:
    * const leahCard = AutoCards().API.getCard(card => (card.title === "Leah"));
    *
    * @function
    * @param {Function} predicate A function which takes a card and returns true if it matches
    * @param {boolean} [getAll=false] If true, returns all matching cards; otherwise returns the first match
    * @returns {Object|Array<Object>|null} A single card object reference, an array of cards, or null if no match is found
    * @throws {Error} If the predicate is not a function or getAll is not a boolean
    */
    // AutoCards().API.getCard();

    /*** Removes story cards based on a user-defined condition or by direct reference
    * Example:
    * AutoCards().API.eraseCard(card => (card.title === "Leah"));
    *
    * @function
    * @param {Function|Object} predicate A predicate function or a card object reference
    * @param {boolean} [eraseAll=false] If true, removes all matching cards; otherwise removes the first match
    * @returns {boolean|number} True if a single card was removed, false if none matched, or the number of cards erased
    * @throws {Error} If the inputs are not a valid predicate function, card object, or boolean
    */
    // AutoCards().API.eraseCard();

    //—————————————————————————————————————————————————————————————————————————————————

    /*
    To everyone who helped, thank you:

    AHotHamster22
    Most extensive testing, feedback, ideation, and kindness

    BinKompliziert
    UI feedback

    Boo
    Discord communication

    bottledfox
    API ideas for alternative card generation use-cases

    Bruno
    Most extensive testing, feedback, ideation, and kindness
    https://play.aidungeon.com/profile/Azuhre

    Burnout
    Implementation improvements, algorithm ideas, script help, and LSIv2 inspiration

    bweni
    Testing

    DebaczX
    Most extensive testing, feedback, ideation, and kindness

    Dirty Kurtis
    Card entry generation prompt engineering

    Dragranis
    Provided the memory dataset used for boundary calibration

    effortlyss
    Data, testing, in-game command ideas, config settings, and other UX improvements

    Hawk
    Grammar and special-cased proper nouns

    Idle Confusion
    Testing
    https://play.aidungeon.com/profile/Idle%20Confusion

    ImprezA
    Most extensive testing, feedback, ideation, and kindness
    https://play.aidungeon.com/profile/ImprezA

    Kat-Oli
    Title parsing, grammar, and special-cased proper nouns

    KryptykAngel
    LSIv2 ideas
    https://play.aidungeon.com/profile/KryptykAngel

    Mad19pumpkin
    API ideas
    https://play.aidungeon.com/profile/Mad19pumpkin

    Magic
    Implementation and syntax improvements
    https://play.aidungeon.com/profile/MagicOfLolis

    Mirox80
    Testing, feedback, and scenario integration ideas
    https://play.aidungeon.com/profile/Mirox80

    Nathaniel Wyvern
    Testing
    https://play.aidungeon.com/profile/NathanielWyvern

    NobodyIsUgly
    All-caps title parsing feedback

    OnyxFlame
    Card memory bank implementation ideas and special-cased proper nouns

    Purplejump
    API ideas for deep integration with other AID scripts

    Randy Viosca
    Context injection and card memory bank structure
    https://play.aidungeon.com/profile/Random_Variable

    RustyPawz
    API ideas for simplified card interaction
    https://play.aidungeon.com/profile/RustyPawz

    sinner
    Testing

    Sleepy pink
    Testing and feedback
    https://play.aidungeon.com/profile/Pinkghost

    Vutinberg
    Memory compression ideas and prompt engineering

    Wilmar
    Card entry generation and memory summarization prompt engineering

    Yi1i1i
    Idea for the redoCard API function and "/ac redo" in-game command

    A note to future individuals:
    If you fork or modify Auto-Cards... Go ahead and put your name here too! Yay! 🥰
    */

    //—————————————————————————————————————————————————————————————————————————————————

    /*
    The code below implements Auto-Cards
    Enjoy! ❤️
    */

    // My class definitions are hoisted by wrapper functions because it's less ugly (lol)
    const Const = hoistConst();
    const O = hoistO();
    const Words = hoistWords();
    const StringsHashed = hoistStringsHashed();
    const Internal = hoistInternal();
    // AutoCards has an explicitly immutable domain: HOOK, TEXT, and STOP
    const HOOK = inHook;
    const TEXT = ((typeof inText === "string") && inText) || "\n";
    const STOP = (inStop === true);
    // AutoCards returns a pseudoimmutable codomain which is initialized only once before being read and returned
    const CODOMAIN = new Const().declare();
    // Transient sets for high-performance lookup
    const [used, bans, auto, forenames, surnames] = Array.from({length: 5}, () => new Set());
    // Holds a reference to the data card singleton, remains unassigned unless required
    let data = null;
    // Validate globalThis.text
    text = ((typeof text === "string") && text) || "\n";
    // Container for the persistent state of AutoCards
    const AC = (function() {
        if (state.LSIv2) {
            // The Auto-Cards external API is also available from within the inner scope of LSIv2
            // Call with AutoCards().API.nameOfFunction(yourArguments);
            return state.LSIv2;
        } else if (state.AutoCards) {
            // state.AutoCards is prioritized for performance
            const ac = state.AutoCards;
            delete state.AutoCards;
            return ac;
        }
        const dataVariants = getDataVariants();
        data = getSingletonCard(false, O.f({...dataVariants.critical}), O.f({...dataVariants.debug}));
        // Deserialize the state of Auto-Cards from the data card
        const ac = (function() {
            try {
                return JSON.parse(data?.description);
            } catch {
                return null;
            }
        })();
        // If the deserialized state fails to match the following structure, fallback to defaults
        if (validate(ac, O.f({
            config: [
                "doAC", "deleteAllAutoCards", "pinConfigureCard", "addCardCooldown", "bulletedListMode", "defaultEntryLimit", "defaultCardsDoMemoryUpdates", "defaultMemoryLimit", "memoryCompressionRatio", "ignoreAllCapsTitles", "readFromInputs", "minimumLookBackDistance", "LSIv2", "showDebugData", "generationPrompt", "compressionPrompt", "defaultCardType"
            ],
            signal: [
                "emergencyHalt", "forceToggle", "overrideBans", "swapControlCards", "recheckRetryOrErase", "maxChars", "outputReplacement", "upstreamError"
            ],
            generation: [
                "cooldown", "completed", "permitted", "workpiece", "pending"
            ],
            compression: [
                "completed", "titleKey", "vanityTitle", "responseEstimate", "lastConstructIndex", "oldMemoryBank", "newMemoryBank"
            ],
            message: [
                "previous", "suppress", "pending", "event"
            ],
            chronometer: [
                "turn", "step", "amnesia", "postpone"
            ],
            database: {
                titles: [
                    "used", "banned", "candidates", "lastActionParsed", "lastTextHash", "pendingBans", "pendingUnbans"
                ],
                memories: [
                    "associations", "duplicates"
                ]
            }
        }))) {
            // The deserialization was a success
            return ac;
        }
        function validate(obj, finalKeys) {
            if ((typeof obj !== "object") || (obj === null)) {
                return false;
            } else {
                return Object.entries(finalKeys).every(([key, value]) => {
                    if (!(key in obj)) {
                        return false;
                    } else if (Array.isArray(value)) {
                        return value.every(finalKey => {
                            return (finalKey in obj[key]);
                        });
                    } else {
                        return validate(obj[key], value);
                    }
                });
            }
        }
        // AC is malformed, reinitialize with default values
        return {
            // In-game configurable parameters
            config: getDefaultConfig(),
            // Collection of various short-term signals passed forward in time
            signal: {
                // API: Suspend nearly all Auto-Cards processes
                emergencyHalt: false,
                // API: Forcefully toggle Auto-Cards on or off
                forceToggle: null,
                // API: Banned titles were externally overwritten
                overrideBans: 0,
                // Signal the construction of the opposite control card during the upcoming onOutput hook
                swapControlCards: false,
                // Signal a limited recheck of recent title candidates following a retry or erase
                recheckRetryOrErase: false,
                // Signal an upcoming onOutput text replacement
                outputReplacement: "",
                // info.maxChars is only defined onContext but must be accessed during other hooks too
                maxChars: Math.abs(info?.maxChars || 3200),
                // An error occured within the isolateLSIv2 scope during an earlier hook
                upstreamError: ""
            },
            // Moderates the generation of new story card entries
            generation: {
                // Number of story progression turns between card generations
                cooldown: validateCooldown(underQuarterInteger(validateCooldown(DEFAULT_CARD_CREATION_COOLDOWN))),
                // Continues prompted so far
                completed: 0,
                // Upper limit on consecutive continues
                permitted: 34,
                // Properties of the incomplete story card
                workpiece: O.f({}),
                // Pending card generations
                pending: [],
            },
            // Moderates the compression of story card memories
            compression: {
                // Continues prompted so far
                completed: 0,
                // A title header reference key for this auto-card
                titleKey: "",
                // The full and proper title
                vanityTitle: "",
                // Response length estimate used to compute # of outputs remaining
                responseEstimate: 1400,
                // Indices [0, n] of oldMemoryBank memories used to build the current memory construct
                lastConstructIndex: -1,
                // Bank of card memories awaiting compression
                oldMemoryBank: [],
                // Incomplete bank of newly compressed card memories
                newMemoryBank: [],
            },
            // Prevents incompatibility issues borne of state.message modification
            message: {
                // Last turn's state.message
                previous: getStateMessage(),
                // API: Allow Auto-Cards to post messages?
                suppress: false,
                // Pending Auto-Cards message(s)
                pending: (function() {
                    if (DEFAULT_DO_AC !== false) {
                        const startupMessage = "Enabled! You may now edit the \"Configure Auto-Cards\" story card";
                        logEvent(startupMessage);
                        return [startupMessage];
                    } else {
                        return [];
                    }
                })(),
                // Counter to track all Auto-Cards message events
                event: 0
            },
            // Timekeeper used for temporal events
            chronometer: {
                // Previous turn's measurement of info.actionCount
                turn: getTurn(),
                // Whether or not various turn counters should be stepped (falsified by retry actions)
                step: true,
                // Number of consecutive turn interruptions
                amnesia: 0,
                // API: Postpone Auto-Cards externalities for n many turns
                postpone: 0,
            },
            // Scalable atabase to store dynamic game information
            database: {
                // Words are pale shadows of forgotten names. As names have power, words have power
                titles: {
                    // A transient array of known titles parsed from card titles, entry title headers, and trigger keywords
                    used: [],
                    // Titles banned from future card generation attempts and various maintenance procedures
                    banned: getDefaultConfigBans(),
                    // Potential future card titles and their turns of occurrence
                    candidates: [],
                    // Helps avoid rechecking the same action text more than once, generally
                    lastActionParsed: -1,
                    // Ensures weird combinations of retry/erase events remain predictable
                    lastTextHash: "%@%",
                    // Newly banned titles which will be added to the config card
                    pendingBans: [],
                    // Currently banned titles which will be removed from the config card
                    pendingUnbans: []
                },
                // Memories are parsed from context and handled by various operations (basically magic)
                memories: {
                    // Dynamic store of 'story card -> memory' conceptual relations
                    associations: {},
                    // Serialized hashset of the 2000 most recent near-duplicate memories purged from context
                    duplicates: "%@%"
                }
            }
        };
    })();
    O.f(AC);
    O.s(AC.config);
    O.s(AC.signal);
    O.s(AC.generation);
    O.s(AC.generation.workpiece);
    AC.generation.pending.forEach(request => O.s(request));
    O.s(AC.compression);
    O.s(AC.message);
    O.s(AC.chronometer);
    O.f(AC.database);
    O.s(AC.database.titles);
    O.s(AC.database.memories);
    if (!HOOK) {
        globalThis.stop ??= false;
        AC.signal.maxChars = Math.abs(info?.maxChars || AC.signal.maxChars);
        if (HOOK === null) {
            if (/Recent\s*Story\s*:/i.test(text)) {
                // AutoCards(null) is always invoked once after being declared within the shared library
                // Context must be cleaned before passing text to the context modifier
                // This measure is taken to ensure compatability with other scripts
                // First, remove all command, continue, and comfirmation messages from the context window
                text = (text
                    // Hide the guide
                    .replace(/\s*>>>\s*Detailed\s*Guide\s*:[\s\S]*?<<<\s*/gi, "\n\n")
                    // Excise all /AC command messages
                    .replace(/\s*>>>\s*Auto-Cards\s*has\s*been\s*enabled!\s*<<<\s*/gi, " ")
                    .replace(/^.*\/\s*A\s*C.*$/gmi, "%@%")
                    .replace(/\s*%@%\s*/g, " ")
                    // Consolidate all consecutive continue messages into placeholder substrings
                    .replace(/(?:(?:\s*>>>\s*please\s*select\s*"continue"\s*\([\s\S]*?\)\s*<<<\s*)+)/gi, message => {
                        // Replace all continue messages with %@+%-patterned substrings
                        return (
                            // The # of "@" symbols corresponds with the # of consecutive continue messages
                            "%" + "@".repeat(
                                // Count the number of consecutive continue message occurrences
                                (message.match(/>>>\s*please\s*select\s*"continue"\s*\([\s\S]*?\)\s*<<</gi) || []).length
                            ) + "%"
                        );
                    })
                    // Situationally replace all placeholder substrings with either spaces or double newlines
                    .replace(/%@+%/g, (match, matchIndex, intermediateText) => {
                        // Check the case of the next char following the match to decide how to replace it
                        let i = matchIndex + match.length;
                        let nextChar = intermediateText[i];
                        if (nextChar === undefined) {
                            return " ";
                        } else if (/^[A-Z]$/.test(nextChar)) {
                            // Probably denotes a new sentence/paragraph
                            return "\n\n";
                        } else if (/^[a-z]$/.test(nextChar)) {
                            return " ";
                        }
                        // The first nextChar was a weird punctuation char, find the next non-whitespace char
                        do {
                            i++;
                            nextChar = intermediateText[i];
                            if (nextChar === undefined) {
                                return " ";
                            }
                        } while (/\s/.test(nextChar));
                        if (nextChar === nextChar.toUpperCase()) {
                            // Probably denotes a new sentence/paragraph
                            return "\n\n";
                        }
                        // Returning " " probably indicates a previous output's incompleteness
                        return " ";
                    })
                    // Remove all comfirmation requests and responses
                    .replace(/\s*\n*.*CONFIRM\s*DELETE.*\n*\s*/gi, confirmation => {
                        if (confirmation.includes("<<<")) {
                            return " ";
                        } else {
                            return "";
                        }
                    })
                    // Remove dumb memories from the context window
                    // (Latitude, if you're reading this, please give us memoryBank read/write access 😭)
                    .replace(/(Memories\s*:)\s*([\s\S]*?)\s*(Recent\s*Story\s*:|$)/i, (_, left, memories, right) => {
                        return (left + "\n" + (memories
                            .split("\n")
                            .filter(memory => {
                                const lowerMemory = memory.toLowerCase();
                                return !(
                                    (lowerMemory.includes("select") && lowerMemory.includes("continue"))
                                    || lowerMemory.includes(">>>") || lowerMemory.includes("<<<")
                                    || lowerMemory.includes("lsiv2")
                                );
                            })
                            .join("\n")
                        ) + (function() {
                            if (right !== "") {
                                return "\n\n" + right;
                            } else {
                                return "";
                            }
                        })());
                    })
                    // Remove LSIv2 error messages
                    .replace(/(?:\s*>>>[\s\S]*?<<<\s*)+/g, " ")
                );
                if (!shouldProceed()) {
                    // Whenever Auto-Cards is inactive, remove auto card title headers from contextualized story card entries
                    text = (text
                        .replace(/\s*{\s*titles?\s*:[\s\S]*?}\s*/gi, "\n\n")
                        .replace(/World\s*Lore\s*:\s*/i, "World Lore:\n")
                    );
                    // Otherwise, implement a more complex version of this step within the (HOOK === "context") scope of AutoCards
                }
            }
            CODOMAIN.initialize(null);
        } else {
            // AutoCards was (probably) called without arguments, return an external API to allow other script creators to programmatically govern the behavior of Auto-Cards from elsewhere within their own scripts
            CODOMAIN.initialize({API: O.f(Object.fromEntries(Object.entries({
                // Call these API functions like so: AutoCards().API.nameOfFunction(argumentsOfFunction)
                /*** Postpones internal Auto-Cards events for a specified number of turns
                * 
                * @function
                * @param {number} turns A non-negative integer representing the number of turns to postpone events
                * @returns {Object} An object containing cooldown values affected by the postponement
                * @throws {Error} If turns is not a non-negative integer
                */
                postponeEvents: function(turns) {
                    if (Number.isInteger(turns) && (0 <= turns)) {
                        AC.chronometer.postpone = turns;
                    } else {
                        throw new Error(
                            "Invalid argument: \"" + turns + "\" -> AutoCards().API.postponeEvents() must be be called with a non-negative integer"
                        );
                    }
                    return {
                        postponeAllCooldown: turns,
                        addCardRealCooldown: AC.generation.cooldown,
                        addCardNextCooldown: AC.config.addCardCooldown
                    };
                },
                /*** Sets or clears the emergency halt flag to pause Auto-Cards operations
                * 
                * @function
                * @param {boolean} shouldHalt A boolean value indicating whether to engage (true) or disengage (false) emergency halt
                * @returns {boolean} The value that was set
                * @throws {Error} If called from within isolateLSIv2 scope or with a non-boolean argument
                */
                emergencyHalt: function(shouldHalt) {
                    const scopeRestriction = new Error();
                    if (scopeRestriction.stack && scopeRestriction.stack.includes("isolateLSIv2")) {
                        throw new Error(
                            "Scope restriction: AutoCards().API.emergencyHalt() cannot be called from within LSIv2 (prevents deadlock) but you're more than welcome to use AutoCards().API.postponeEvents() instead!"
                        );
                    } else if (typeof shouldHalt === "boolean") {
                        AC.signal.emergencyHalt = shouldHalt;
                    } else {
                        throw new Error(
                            "Invalid argument: \"" + shouldHalt + "\" -> AutoCards().API.emergencyHalt() must be called with a boolean true or false"
                        );
                    }
                    return shouldHalt;
                },
                /*** Enables or disables state.message assignments from Auto-Cards
                * 
                * @function
                * @param {boolean} shouldSuppress If true, suppresses all Auto-Cards messages; false enables them
                * @returns {Array} The current pending messages after setting suppression
                * @throws {Error} If shouldSuppress is not a boolean
                */
                suppressMessages: function(shouldSuppress) {
                    if (typeof shouldSuppress === "boolean") {
                        AC.message.suppress = shouldSuppress;
                    } else {
                        throw new Error(
                            "Invalid argument: \"" + shouldSuppress + "\" -> AutoCards().API.suppressMessages() must be called with a boolean true or false"
                        );
                    }
                    return AC.message.pending;
                },
                /*** Logs debug information to the "Debug Log" console card
                * 
                * @function
                * @param {...any} args Arguments to log for debugging purposes
                * @returns {any} The story card object reference
                */
                debugLog: function(...args) {
                    return Internal.debugLog(...args);
                },
                /*** Toggles Auto-Cards behavior or sets it directly
                * 
                * @function
                * @param {boolean|null|undefined} toggleType If undefined, toggles the current state. If boolean or null, sets the state accordingly
                * @returns {boolean|null|undefined} The state that was set or inferred
                * @throws {Error} If toggleType is not a boolean, null, or undefined
                */
                toggle: function(toggleType) {
                    if (toggleType === undefined) {
                        if (AC.signal.forceToggle !== null) {
                            AC.signal.forceToggle = !AC.signal.forceToggle;
                        } else if (AC.config.doAC) {
                            AC.signal.forceToggle = false;
                        } else {
                            AC.signal.forceToggle = true;
                        }
                    } else if ((toggleType === null) || (typeof toggleType === "boolean")) {
                        AC.signal.forceToggle = toggleType;
                    } else {
                        throw new Error(
                            "Invalid argument: \"" + toggleType + "\" -> AutoCards().API.toggle() must be called with either A) a boolean true or false, B) a null argument, or C) no arguments at all (undefined)"
                        );
                    }
                    return toggleType;
                },
                /*** Generates a new card using optional prompt details or a request object
                * 
                * @function
                * @param {Object|string} request A request object with card parameters or a string representing the title
                * @param {string} [extra1] Optional entryPromptDetails if using string mode
                * @param {string} [extra2] Optional entryStart if using string mode
                * @returns {boolean} Did the generation attempt succeed or fail
                * @throws {Error} If the request is not valid or missing a title
                */
                generateCard: function(request, extra1, extra2) {
                    // Function call guide:
                    // AutoCards().API.generateCard({
                    //     // All properties except 'title' are optional
                    //     type: "card type, defaults to 'class' for ease of filtering",
                    //     title: "card title",
                    //     keysStart: "preexisting card triggers",
                    //     entryStart: "preexisting card entry",
                    //     entryPrompt: "prompt the AI will use to complete this entry",
                    //     entryPromptDetails: "extra details to include with this card's prompt",
                    //     entryLimit: 750, // target character count for the generated entry
                    //     description: "card notes",
                    //     memoryStart: "preexisting card memory",
                    //     memoryUpdates: true, // card updates when new relevant memories are formed
                    //     memoryLimit: 2750, // max characters before the card memory is compressed
                    // });
                    if (typeof request === "string") {
                        request = {title: request};
                        if (typeof extra1 === "string") {
                            request.entryPromptDetails = extra1;
                            if (typeof extra2 === "string") {
                                request.entryStart = extra2;
                            }
                        }
                    } else if (!isTitleInObj(request)) {
                        throw new Error(
                            "Invalid argument: \"" + request + "\" -> AutoCards().API.generateCard() must be called with either 1, 2, or 3 strings OR a correctly formatted card generation object"
                        );
                    }
                    O.f(request);
                    Internal.getUsedTitles(true);
                    return Internal.generateCard(request);
                },
                /*** Regenerates a card by title or object reference, optionally preserving or modifying its input info
                *
                * @function
                * @param {Object|string} request A card object reference or title string for the card to be regenerated
                * @param {boolean} [useOldInfo=true] If true, preserves old info in the new generation; false omits it
                * @param {string} [newInfo=""] Additional info to append to the generation prompt
                * @returns {boolean} True if regeneration succeeded; false otherwise
                * @throws {Error} If the request format is invalid, or if the second or third parameters are the wrong types
                */
                redoCard: function(request, useOldInfo = true, newInfo = "") {
                    if (typeof request === "string") {
                        request = {title: request};
                    } else if (!isTitleInObj(request)) {
                        throw new Error(
                            "Invalid argument: \"" + request + "\" -> AutoCards().API.redoCard() must be called with a string or correctly formatted card generation object"
                        );
                    }
                    if (typeof useOldInfo !== "boolean") {
                        throw new Error(
                            "Invalid argument: \"" + request + ", " + useOldInfo + "\" -> AutoCards().API.redoCard() requires a boolean as its second argument"
                        );
                    } else if (typeof newInfo !== "string") {
                        throw new Error(
                            "Invalid argument: \"" + request + ", " + useOldInfo + ", " + newInfo + "\" -> AutoCards().API.redoCard() requires a string for its third argument"
                        );
                    }
                    return Internal.redoCard(request, useOldInfo, newInfo);
                },
                /*** Flags or unflags a card as an auto-card, controlling its automatic generation behavior
                *
                * @function
                * @param {Object|string} targetCard The card object or title to mark/unmark as an auto-card
                * @param {boolean} [setOrUnset=true] If true, marks the card as an auto-card; false removes the flag
                * @returns {boolean} True if the operation succeeded; false if the card was invalid or already matched the target state
                * @throws {Error} If the arguments are invalid types
                */
                setCardAsAuto: function(targetCard, setOrUnset = true) {
                    if (isTitleInObj(targetCard)) {
                        targetCard = targetCard.title;
                    } else if (typeof targetCard !== "string") {
                        throw new Error(
                            "Invalid argument: \"" + targetCard + "\" -> AutoCards().API.setCardAsAuto() must be called with a string or card object"
                        );
                    }
                    if (typeof setOrUnset !== "boolean") {
                        throw new Error(
                            "Invalid argument: \"" + targetCard + ", " + setOrUnset + "\" -> AutoCards().API.setCardAsAuto() requires a boolean as its second argument"
                        );
                    }
                    const [card, isAuto] = getIntendedCard(targetCard);
                    if (card === null) {
                        return false;
                    }
                    if (setOrUnset) {
                        if (checkAuto()) {
                            return false;
                        }
                        card.description = "{title:}";
                        Internal.getUsedTitles(true);
                        return card.entry.startsWith("{title: ");
                    } else if (!checkAuto()) {
                        return false;
                    }
                    card.entry = removeAutoProps(card.entry);
                    card.description = removeAutoProps(card.description.replace((
                        /\s*Auto(?:-|\s*)Cards\s*will\s*contextualize\s*these\s*memories\s*:\s*/gi
                    ), ""));
                    function checkAuto() {
                        return (isAuto || /{updates: (?:true|false), limit: \d+}/.test(card.description));
                    }
                    return true;
                },
                /*** Appends a memory to a story card's memory bank
                *
                * @function
                * @param {Object|string} targetCard A card object reference or title string
                * @param {string} newMemory The memory text to add
                * @returns {boolean} True if the memory was added; false if it was empty, already present, or the card was not found
                * @throws {Error} If the inputs are not a string or valid card object reference
                */
                addCardMemory: function(targetCard, newMemory) {
                    if (isTitleInObj(targetCard)) {
                        targetCard = targetCard.title;
                    } else if (typeof targetCard !== "string") {
                        throw new Error(
                            "Invalid argument: \"" + targetCard + "\" -> AutoCards().API.addCardMemory() must be called with a string or card object"
                        );
                    }
                    if (typeof newMemory !== "string") {
                        throw new Error(
                            "Invalid argument: \"" + targetCard + ", " + newMemory + "\" -> AutoCards().API.addCardMemory() requires a string for its second argument"
                        );
                    }
                    newMemory = newMemory.trim().replace(/\s+/g, " ").replace(/^-+\s*/, "");
                    if (newMemory === "") {
                        return false;
                    }
                    const [card, isAuto, titleKey] = getIntendedCard(targetCard);
                    if (
                        (card === null)
                        || card.description.replace(/\s+/g, " ").toLowerCase().includes(newMemory.toLowerCase())
                    ) {
                        return false;
                    } else if (card.description !== "") {
                        card.description += "\n";
                    }
                    card.description += "- " + newMemory;
                    if (titleKey in AC.database.memories.associations) {
                        AC.database.memories.associations[titleKey][1] = (StringsHashed
                            .deserialize(AC.database.memories.associations[titleKey][1], 65536)
                            .remove(newMemory)
                            .add(newMemory)
                            .latest(3500)
                            .serialize()
                        );
                    } else if (isAuto) {
                        AC.database.memories.associations[titleKey] = [999, (new StringsHashed(65536)
                            .add(newMemory)
                            .serialize()
                        )];
                    }
                    return true;
                },
                /*** Removes all previously generated auto-cards and resets various states
                *
                * @function
                * @returns {number} The number of cards that were removed
                */
                eraseAllAutoCards: function() {
                    return Internal.eraseAllAutoCards();
                },
                /*** Retrieves an array of titles currently used by the adventure's story cards
                *
                * @function
                * @returns {Array<string>} An array of strings representing used titles
                */
                getUsedTitles: function() {
                    return Internal.getUsedTitles(true);
                },
                /*** Retrieves an array of banned titles
                *
                * @function
                * @returns {Array<string>} An array of banned title strings
                */
                getBannedTitles: function() {
                    return Internal.getBannedTitles();
                },
                /*** Sets the banned titles array, replacing any previously banned titles
                *
                * @function
                * @param {string|Array<string>} titles A comma-separated string or array of strings representing titles to ban
                * @returns {Object} An object containing oldBans and newBans arrays
                * @throws {Error} If the input is neither a string nor an array of strings
                */
                setBannedTitles: function(titles) {
                    const codomain = {oldBans: AC.database.titles.banned};
                    if (Array.isArray(titles) && titles.every(title => (typeof title === "string"))) {
                        assignBannedTitles(titles);
                    } else if (typeof titles === "string") {
                        if (titles.includes(",")) {
                            assignBannedTitles(titles.split(","));
                        } else {
                            assignBannedTitles([titles]);
                        }
                    } else {
                        throw new Error(
                            "Invalid argument: \"" + titles + "\" -> AutoCards().API.setBannedTitles() must be called with either a string or an array of strings"
                        );
                    }
                    codomain.newBans = AC.database.titles.banned;
                    function assignBannedTitles(titles) {
                        Internal.setBannedTitles(uniqueTitlesArray(titles), false);
                        AC.signal.overrideBans = 3;
                        return;
                    }
                    return codomain;
                },
                /*** Creates a new story card with the specified parameters
                *
                * @function
                * @param {string|Object} title Card title string or full card template object containing all fields
                * @param {string} [entry] The entry text for the card
                * @param {string} [type] The card type (e.g., "character", "location")
                * @param {string} [keys] The keys (triggers) for the card
                * @param {string} [description] The notes or memory bank of the card
                * @param {number} [insertionIndex] Optional index to insert the card at a specific position within storyCards
                * @returns {Object|null} The created card object reference, or null if creation failed
                */
                buildCard: function(title, entry, type, keys, description, insertionIndex) {
                    if (isTitleInObj(title)) {
                        type = title.type ?? type;
                        keys = title.keys ?? keys;
                        entry = title.entry ?? entry;
                        description = title.description ?? description;
                        title = title.title;
                    }
                    title = cast(title);
                    const card = constructCard(O.f({
                        type: cast(type, AC.config.defaultCardType),
                        title,
                        keys: cast(keys, buildKeys("", title)),
                        entry: cast(entry),
                        description: cast(description)
                    }), boundInteger(0, insertionIndex, storyCards.length, newCardIndex()));
                    if (notEmptyObj(card)) {
                        return card;
                    }
                    function cast(value, fallback = "") {
                        if (typeof value === "string") {
                            return value;
                        } else {
                            return fallback;
                        }
                    }
                    return null;
                },
                /*** Finds and returns story cards satisfying a user-defined condition
                *
                * @function
                * @param {Function} predicate A function which takes a card and returns true if it matches
                * @param {boolean} [getAll=false] If true, returns all matching cards; otherwise returns the first match
                * @returns {Object|Array<Object>|null} A single card object reference, an array of cards, or null if no match is found
                * @throws {Error} If the predicate is not a function or getAll is not a boolean
                */
                getCard: function(predicate, getAll = false) {
                    if (typeof predicate !== "function") {
                        throw new Error(
                            "Invalid argument: \"" + predicate + "\" -> AutoCards().API.getCard() must be called with a function"
                        );
                    } else if (typeof getAll !== "boolean") {
                        throw new Error(
                            "Invalid argument: \"" + predicate + ", " + getAll + "\" -> AutoCards().API.getCard() requires a boolean as its second argument"
                        );
                    }
                    return Internal.getCard(predicate, getAll);
                },
                /*** Removes story cards based on a user-defined condition or by direct reference
                *
                * @function
                * @param {Function|Object} predicate A predicate function or a card object reference
                * @param {boolean} [eraseAll=false] If true, removes all matching cards; otherwise removes the first match
                * @returns {boolean|number} True if a single card was removed, false if none matched, or the number of cards erased
                * @throws {Error} If the inputs are not a valid predicate function, card object, or boolean
                */
                eraseCard: function(predicate, eraseAll = false) {
                    if (isTitleInObj(predicate) && storyCards.includes(predicate)) {
                        return eraseCard(predicate);
                    } else if (typeof predicate !== "function") {
                        throw new Error(
                            "Invalid argument: \"" + predicate + "\" -> AutoCards().API.eraseCard() must be called with a function or card object"
                        );
                    } else if (typeof eraseAll !== "boolean") {
                        throw new Error(
                            "Invalid argument: \"" + predicate + ", " + eraseAll + "\" -> AutoCards().API.eraseCard() requires a boolean as its second argument"
                        );
                    } else if (eraseAll) {
                        // Erase all cards which satisfy the given condition
                        let cardsErased = 0;
                        for (const [index, card] of storyCards.entries()) {
                            if (predicate(card)) {
                                removeStoryCard(index);
                                cardsErased++;
                            }
                        }
                        return cardsErased;
                    }
                    // Erase the first card which satisfies the given condition
                    for (const [index, card] of storyCards.entries()) {
                        if (predicate(card)) {
                            removeStoryCard(index);
                            return true;
                        }
                    }
                    return false;
                }
            }).map(([key, fn]) => [key, function(...args) {
                const result = fn.apply(this, args);
                if (data) {
                    data.description = JSON.stringify(AC);
                }
                return result;
            }])))});
            function isTitleInObj(obj) {
                return (
                    (typeof obj === "object")
                    && (obj !== null)
                    && ("title" in obj)
                    && (typeof obj.title === "string")
                );
            }
        }
    } else if (AC.signal.emergencyHalt) {
        switch(HOOK) {
        case "context": {
            // AutoCards was called within the context modifier
            advanceChronometer();
            break; }
        case "output": {
            // AutoCards was called within the output modifier
            concludeEmergency();
            const previousAction = readPastAction(0);
            if (isDoSayStory(previousAction.type) && /escape\s*emergency\s*halt/i.test(previousAction.text)) {
                AC.signal.emergencyHalt = false;
            }
            break; }
        }
        CODOMAIN.initialize(TEXT);
    } else if ((AC.config.LSIv2 !== null) && AC.config.LSIv2) {
        // Silly recursion shenanigans
        state.LSIv2 = AC;
        AC.config.LSIv2 = false;
        const LSI_DOMAIN = AutoCards(HOOK, TEXT, STOP);
        // Is this lazy loading mechanism overkill? Yes. But it's fun!
        const factories = O.f({
            library: () => ({
                name: Words.reserved.library,
                entry: prose(
                    "// Your adventure's Shared Library code goes here",
                    "// Example Library code:",
                    "state.promptDragon ??= false;",
                    "state.mind ??= 0;",
                    "state.willStop ??= false;",
                    "function formatMessage(message, space = \" \") {",
                    "    let leadingNewlines = \"\";",
                    "    let trailingNewlines = \"\\n\\n\";",
                    "    if (text.startsWith(\"\\n> \")) {",
                    "        // We don't want any leading/trailing newlines for Do/Say",
                    "        trailingNewlines = \"\";",
                    "    } else if (history && (0 < history.length)) {",
                    "        // Decide leading newlines based on the previous action",
                    "        const action = history[history.length - 1];",
                    "        if ((action.type === \"continue\") || (action.type === \"story\")) {",
                    "            if (!action.text.endsWith(\"\\n\")) {",
                    "                leadingNewlines = \"\\n\\n\";",
                    "            } else if (!action.text.endsWith(\"\\n\\n\")) {",
                    "                leadingNewlines = \"\\n\";",
                    "            }",
                    "        }",
                    "    }",
                    "    return leadingNewlines + \"{>\" + space + (message",
                    "        .replace(/(?:\\s*(?:{>|<})\\s*)+/g, \" \")",
                    "        .trim()",
                    "    ) + space + \"<}\" + trailingNewlines;",
                    "}"),
                description:
                    "// You may also continue your Library code below",
                singleton: false,
                position: 2
            }),
            input: () => ({
                name: Words.reserved.input,
                entry: prose(
                    "// Your adventure's Input Modifier code goes here",
                    "// Example Input code:",
                    "const minds = [",
                    "\"kind and gentle\",",
                    "\"curious and eager\",",
                    "\"cruel and evil\"",
                    "];",
                    "// Type any of these triggers into a Do/Say/Story action",
                    "const commands = new Map([",
                    "[\"encounter dragon\", () => {",
                    "    AutoCards().API.postponeEvents(1);",
                    "    state.promptDragon = true;",
                    "    text = formatMessage(\"You encounter a dragon!\");",
                    "    log(\"A dragon appears!\");",
                    "}],",
                    "[\"summon leah\", () => {",
                    "    alterMind();",
                    "    const success = AutoCards().API.generateCard({",
                    "        title: \"Leah\",",
                    "        entryPromptDetails: (",
                    "            \"Leah is an exceptionally \" +",
                    "            minds[state.mind] +",
                    "            \" woman\"",
                    "        ),",
                    "        entryStart: \"Leah is your magically summoned assistant.\"",
                    "    });",
                    "    if (success) {",
                    "        text = formatMessage(\"You begin summoning Leah!\");",
                    "        log(\"Attempting to summon Leah\");",
                    "    } else {",
                    "        text = formatMessage(\"You failed to summon Leah...\");",
                    "        log(\"Leah could not be summoned\");",
                    "    }",
                    "}],",
                    "[\"alter leah\", () => {",
                    "    alterMind();",
                    "    const success = AutoCards().API.redoCard(\"Leah\", true, (",
                    "        \"You subjected Leah to mind-altering magic\\n\" +",
                    "        \"Therefore she is now entirely \" +",
                    "        minds[state.mind] +",
                    "        \", utterly captivated by your will\"",
                    "    ));",
                    "    if (success) {",
                    "        text = formatMessage(",
                    "            \"You proceed to alter Leah's mind!\"",
                    "        );",
                    "        log(\"Attempting to alter Leah\");",
                    "    } else {",
                    "        text = formatMessage(\"You failed to alter Leah...\");",
                    "        log(\"Leah could not be altered\");",
                    "    }",
                    "}],",
                    "[\"show api\", () => {",
                    "    state.showAPI = true;",
                    "    text = formatMessage(\"Displaying the Auto-Cards API below\");",
                    "}],",
                    "[\"force stop\", () => {",
                    "    state.willStop = true;",
                    "}]",
                    "]);",
                    "const lowerText = text.toLowerCase();",
                    "for (const [trigger, implement] of commands) {",
                    "    if (lowerText.includes(trigger)) {",
                    "        implement();",
                    "        break;",
                    "    }",
                    "}",
                    "function alterMind() {",
                    "    state.mind = (state.mind + 1) % minds.length;",
                    "    return;",
                    "}"),
                description:
                    "// You may also continue your Input code below",
                singleton: false,
                position: 3
            }),
            context: () => ({
                name: Words.reserved.context,
                entry: prose(
                    "// Your adventure's Context Modifier code goes here",
                    "// Example Context code:",
                    "text = text.replace(/\\s*{>[\\s\\S]*?<}\\s*/gi, \"\\n\\n\");",
                    "if (state.willStop) {",
                    "    state.willStop = false;",
                    "    // Assign true to prevent the onOutput hook",
                    "    // This can only be done onContext",
                    "    stop = true;",
                    "} else if (state.promptDragon) {",
                    "    state.promptDragon = false;",
                    "    text = (",
                    "        text.trimEnd() +",
                    "        \"\\n\\nA cute little dragon softly lands upon your head. \"",
                    "    );",
                    "}"),
                description:
                    "// You may also continue your Context code below",
                singleton: false,
                position: 4
            }),
            output: () => ({
                name: Words.reserved.output,
                entry: prose(
                    "// Your adventure's Output Modifier code goes here",
                    "// Example Output code:",
                    "if (state.showAPI) {",
                    "    state.showAPI = false;",
                    "    const apiKeys = (Object.keys(AutoCards().API)",
                    "        .map(key => (\"AutoCards().API.\" + key + \"()\"))",
                    "    );",
                    "    text = formatMessage(apiKeys.join(\"\\n\"), \"\\n\");",
                    "    log(apiKeys);",
                    "}"),
                description:
                    "// You may also continue your Output code below",
                singleton: false,
                position: 5
            }),
            guide: () => ({
                name: Words.reserved.guide,
                entry: prose(
                    "Any valid JavaScript code you write within the Shared Library or Input/Context/Output Modifier story cards will be executed from top to bottom; Live Script Interface v2 closely emulates AI Dungeon's native scripting environment, even if you aren't the owner of the original scenario. Furthermore, I've provided full access to the Auto-Cards scripting API. Please note that disabling LSIv2 via the \"Configure Auto-Cards\" story card will reset your LSIv2 adventure scripts!",
                    "",
                    "If you aren't familiar with scripting in AI Dungeon, please refer to the official guidebook page:",
                    "https://help.aidungeon.com/scripting",
                    "",
                    "I've included an example script with the four aforementioned code cards, to help showcase some of my fancy schmancy Auto-Cards API functions. Take a look, try some of my example commands, inspect the Console Log, and so on... It's a ton of fun! ❤️",
                    "",
                    "If you ever run out of space in your Library, Input, Context, or Output code cards, simply duplicate whichever one(s) you need and then perform an in-game turn before writing any more code. (emphasis on \"before\") Doing so will signal LSIv2 to convert your duplicated code card(s) into additional auxiliary versions.",
                    "",
                    "Auxiliary code cards are numbered, and any code written within will be appended in sequential order. For example:",
                    "// Shared Library (entry)",
                    "// Shared Library (notes)",
                    "// Shared Library 2 (entry)",
                    "// Shared Library 2 (notes)",
                    "// Shared Library 3 (entry)",
                    "// Shared Library 3 (notes)",
                    "// Input Modifier (entry)",
                    "// Input Modifier (notes)",
                    "// Input Modifier 2 (entry)",
                    "// Input Modifier 2 (notes)",
                    "// And so on..."),
                description:
                    "",
                singleton: true,
                position: 0
            }),
            state: () => ({
                name: Words.reserved.state,
                entry:
                    "Your adventure's full state object is displayed in the Notes section below.",
                description:
                    "",
                singleton: true,
                position: 6
            }),
            log: () => ({
                name: Words.reserved.log,
                entry:
                    "Please refer to the Notes section below to view the full log history for LSIv2. Console log entries are ordered from most recent to oldest. LSIv2 error messages will be recorded here, alongside the outputs of log and console.log function calls within your adventure scripts.",
                description:
                    "",
                singleton: true,
                position: 1
            })
        });
        const cache = {};
        const templates = new Proxy({}, {
            get(_, key) {
                return cache[key] ??= O.f(factories[key]());
            }
        });
        if (AC.config.LSIv2 !== null) {
            switch(HOOK) {
            case "input": {
                // AutoCards was called within the input modifier
                const [libraryCards, inputCards, logCard] = collectCards(
                    templates.library,
                    templates.input,
                    templates.log
                );
                const [error, newText] = isolateLSIv2(parseCode(libraryCards, inputCards), callbackLog(logCard), LSI_DOMAIN);
                handleError(logCard, error);
                if (hadError()) {
                    CODOMAIN.initialize(getStoryError());
                    AC.signal.upstreamError = "\n";
                } else {
                    CODOMAIN.initialize(newText);
                }
                break; }
            case "context": {
                // AutoCards was called within the context modifier
                const [libraryCards, contextCards, logCard] = collectCards(
                    templates.library,
                    templates.context,
                    templates.log,
                    templates.input
                );
                if (hadError()) {
                    endContextLSI(LSI_DOMAIN);
                    break;
                }
                const [error, ...newCodomain] = (([error, newText, newStop]) => [error, newText, (newStop === true)])(
                    isolateLSIv2(parseCode(libraryCards, contextCards), callbackLog(logCard), LSI_DOMAIN[0], LSI_DOMAIN[1])
                );
                handleError(logCard, error);
                endContextLSI(newCodomain);
                function endContextLSI(newCodomain) {
                    CODOMAIN.initialize(newCodomain);
                    if (!newCodomain[1]) {
                        return;
                    }
                    const [guideCard, stateCard] = collectCards(
                        templates.guide,
                        templates.state,
                        templates.output
                    );
                    AC.message.pending = [];
                    concludeLSI(guideCard, stateCard, logCard);
                    return;
                }
                break; }
            case "output": {
                // AutoCards was called within the output modifier
                const [libraryCards, outputCards, guideCard, stateCard, logCard] = collectCards(
                    templates.library,
                    templates.output,
                    templates.guide,
                    templates.state,
                    templates.log
                );
                if (hadError()) {
                    endOutputLSI(true, LSI_DOMAIN);
                    break;
                }
                const [error, newText] = isolateLSIv2(parseCode(libraryCards, outputCards), callbackLog(logCard), LSI_DOMAIN);
                handleError(logCard, error);
                endOutputLSI(hadError(), newText);
                function endOutputLSI(displayError, newText) {
                    if (displayError) {
                        if (AC.signal.upstreamError === "\n") {
                            CODOMAIN.initialize("\n");
                        } else {
                            CODOMAIN.initialize(getStoryError() + "\n");
                        }
                        AC.message.pending = [];
                    } else {
                        CODOMAIN.initialize(newText);
                    }
                    concludeLSI(guideCard, stateCard, logCard);
                    return;
                }
                break; }
            case "initialize": {
                collectAll();
                logToCard(Internal.getCard(card => (card.title === templates.log.name)), "LSIv2 startup -> Success!");
                CODOMAIN.initialize(null);
                break; }
            }
            AC.config.LSIv2 = true;
            function parseCode(...args) {
                return (args
                    .flatMap(cardset => [cardset.primary, ...cardset.auxiliaries])
                    .flatMap(card => [card.entry, card.description])
                    .join("\n")
                );
            }
            function callbackLog(logCard) {
                return function(...args) {
                    logToCard(logCard, ...args);
                    return;
                }
            }
            function handleError(logCard, error) {
                if (!error) {
                    return;
                }
                O.f(error);
                AC.signal.upstreamError = (
                    "LSIv2 encountered an error during the on" + HOOK[0].toUpperCase() + HOOK.slice(1) + " hook"
                );
                if (error.message) {
                    AC.signal.upstreamError += ":\n";
                    if (error.stack) {
                        const stackMatch = error.stack.match(/AutoCards[\s\S]*?:\s*(\d+)\s*:\s*(\d+)/i);
                        if (stackMatch) {
                            AC.signal.upstreamError += (
                                (error.name ?? "Error") + ": " + error.message + "\n" +
                                "(line #" + stackMatch[1] + " column #" + stackMatch[2] + ")"
                            );
                        } else {
                            AC.signal.upstreamError += error.stack;
                        }
                    } else {
                        AC.signal.upstreamError += (error.name ?? "Error") + ": " + error.message;
                    }
                    AC.signal.upstreamError = cleanSpaces(AC.signal.upstreamError.trimEnd());
                }
                logToCard(logCard, AC.signal.upstreamError);
                if (getStateMessage() === AC.signal.upstreamError) {
                    state.message = AC.signal.upstreamError + " ";
                } else {
                    state.message = AC.signal.upstreamError;
                }
                return;
            }
            function hadError() {
                return (AC.signal.upstreamError !== "");
            }
            function getStoryError() {
                return getPrecedingNewlines() + ">>>\n" + AC.signal.upstreamError + "\n<<<\n";
            }
            function concludeLSI(guideCard, stateCard, logCard) {
                AC.signal.upstreamError = "";
                guideCard.description = templates.guide.description;
                guideCard.entry = templates.guide.entry;
                stateCard.entry = templates.state.entry;
                logCard.entry = templates.log.entry;
                postMessages();
                const simpleState = {...state};
                delete simpleState.LSIv2;
                stateCard.description = limitString(stringifyObject(simpleState).trim(), 999999).trimEnd();
                return;
            }
        } else {
            const cardsets = collectAll();
            for (const cardset of cardsets) {
                if ("primary" in cardset) {
                    killCard(cardset.primary);
                    for (const card of cardset.auxiliaries) {
                        killCard(card);
                    }
                } else {
                    killCard(cardset);
                }
                function killCard(card) {
                    unbanTitle(card.title);
                    eraseCard(card);
                }
            }
            AC.signal.upstreamError = "";
            CODOMAIN.initialize(LSI_DOMAIN);
        }
        // This measure ensures the Auto-Cards external API is equally available from within the inner scope of LSIv2
        // As before, call with AutoCards().API.nameOfFunction(yourArguments);
        deepMerge(AC, state.LSIv2);
        delete state.LSIv2;
        function deepMerge(target, source) {
            for (const key in source) {
                if (!source.hasOwnProperty(key)) {
                    continue;
                } else if (
                    (typeof source[key] === "object")
                    && (source[key] !== null)
                    && !Array.isArray(source[key])
                    && (typeof target[key] === "object")
                    && (target[key] !== null)
                    && (key !== "workpiece")
                    && (key !== "associations")
                ) {
                    // Recursively merge static objects
                    deepMerge(target[key], source[key]);
                } else {
                    // Directly replace values
                    target[key] = source[key];
                }
            }
            return;
        }
        function collectAll() {
            return collectCards(...Object.keys(factories).map(key => templates[key]));
        }
        // collectCards constructs, validates, repairs, retrieves, and organizes all LSIv2 script cards associated with the given arguments by iterating over the storyCards array only once! Returned elements are easily handled via array destructuring assignment
        function collectCards(...args) {
            // args: [{name: string, entry: string, description: string, singleton: boolean, position: integer}]
            const collections = O.f(args.map(({name, entry, description, singleton, position}) => {
                const collection = {
                    template: O.f({
                        type: AC.config.defaultCardType,
                        title: name,
                        keys: name,
                        entry,
                        description
                    }),
                    singleton,
                    position,
                    primary: null,
                    excess: [],
                };
                if (!singleton) {
                    collection.auxiliaries = [];
                    collection.occupied = new Set([0, 1]);
                }
                return O.s(collection);
            }));
            for (const card of storyCards) {
                O.s(card);
                for (const collection of collections) {
                    if (
                        !card.title.toLowerCase().includes(collection.template.title.toLowerCase())
                        && !card.keys.toLowerCase().includes(collection.template.title.toLowerCase())
                    ) {
                        // No match, swipe left
                        continue;
                    }
                    if (collection.singleton) {
                        setPrimary();
                        break;
                    }
                    const [extensionA, extensionB] = [card.title, card.keys].map(name => {
                        const extensionMatch = name.replace(/[^a-zA-Z0-9]/g, "").match(/\d+$/);
                        if (extensionMatch) {
                            return parseInt(extensionMatch[0], 10);
                        } else {
                            return -1;
                        }
                    });
                    if (-1 < extensionA) {
                        if (-1 < extensionB) {
                            if (collection.occupied.has(extensionA)) {
                                setAuxiliary(extensionB);
                            } else {
                                setAuxiliary(extensionA, true);
                            }
                        } else {
                            setAuxiliary(extensionA);
                        }
                    } else if (-1 < extensionB) {
                        setAuxiliary(extensionB);
                    } else {
                        setPrimary();
                    }
                    function setAuxiliary(extension, preChecked = false) {
                        if (preChecked || !collection.occupied.has(extension)) {
                            addAuxiliary(card, collection, extension);
                        } else {
                            card.title = card.keys = collection.template.title;
                            collection.excess.push(card);
                        }
                        return;
                    }
                    function setPrimary() {
                        card.title = card.keys = collection.template.title;
                        if (collection.primary === null) {
                            collection.primary = card;
                        } else {
                            collection.excess.push(card);
                        }
                        return;
                    }
                    break;
                }
            }
            for (const collection of collections) {
                banTitle(collection.template.title);
                if (collection.singleton) {
                    if (collection.primary === null) {
                        constructPrimary();
                    } else if (hasExs()) {
                        for (const card of collection.excess) {
                            eraseCard(card);
                        }
                    }
                    continue;
                } else if (collection.primary === null) {
                    if (hasExs()) {
                        collection.primary = collection.excess.shift();
                        if (hasExs() || hasAux()) {
                            applyComment(collection.primary);
                        } else {
                            collection.primary.entry = collection.template.entry;
                            collection.primary.description = collection.template.description;
                            continue;
                        }
                    } else {
                        constructPrimary();
                        if (hasAux()) {
                            applyComment(collection.primary);
                        } else {
                            continue;
                        }
                    }
                }
                if (hasExs()) {
                    for (const card of collection.excess) {
                        let extension = 2;
                        while (collection.occupied.has(extension)) {
                            extension++;
                        }
                        applyComment(card);
                        addAuxiliary(card, collection, extension);
                    }
                }
                if (hasAux()) {
                    collection.auxiliaries.sort((a, b) => {
                        return a.extension - b.extension;
                    });
                }
                function hasExs() {
                    return (0 < collection.excess.length);
                }
                function hasAux() {
                    return (0 < collection.auxiliaries.length);
                }
                function applyComment(card) {
                    card.entry = card.description = "// You may continue writing your code here";
                    return;
                }
                function constructPrimary() {
                    collection.primary = constructCard(collection.template, newCardIndex());
                    // I like my LSIv2 cards to display in the proper order once initialized uwu
                    const templateKeys = Object.keys(factories);
                    const cards = templateKeys.map(key => O.f({
                        card: Internal.getCard(card => (card.title === templates[key].name)),
                        position: templates[key].position
                    })).filter(pair => (pair.card !== null));
                    if (cards.length < templateKeys.length) {
                        return;
                    }
                    const fullCardset = cards.sort((a, b) => (a.position - b.position)).map(pair => pair.card);
                    for (const card of fullCardset) {
                        eraseCard(card);
                        card.title = card.keys;
                    }
                    storyCards.splice(newCardIndex(), 0, ...fullCardset);
                    return;
                }
            }
            function addAuxiliary(card, collection, extension) {
                collection.occupied.add(extension);
                card.title = card.keys = collection.template.title + " " + extension;
                collection.auxiliaries.push({card, extension});
                return;
            }
            return O.f(collections.map(({singleton, primary, auxiliaries}) => {
                if (singleton) {
                    return primary;
                } else {
                    return O.f({primary, auxiliaries: O.f(auxiliaries.map(({card}) => card))});
                }
            }));
        }
    } else if (AC.config.doAC) {
        // Auto-Cards is currently enabled
        // "text" represents the original text which was present before any scripts were executed
        // "TEXT" represents the script-modified version of "text" which AutoCards was called with
        // This dual scheme exists to ensure Auto-Cards is safely compatible with other scripts
        switch(HOOK) {
        case "input": {
            // AutoCards was called within the input modifier
            if ((AC.config.deleteAllAutoCards === false) && /CONFIRM\s*DELETE/i.test(TEXT)) {
                CODOMAIN.initialize("CONFIRM DELETE -> Success!");
            } else if (/\/\s*A\s*C/i.test(text)) {
                CODOMAIN.initialize(doPlayerCommands(text));
            } else if (TEXT.startsWith(" ") && readPastAction(0).text.endsWith("\n")) {
                // Just a simple little formatting bugfix for regular AID story actions
                CODOMAIN.initialize(getPrecedingNewlines() + TEXT.replace(/^\s+/, ""));
            } else {
                CODOMAIN.initialize(TEXT);
            }
            break; }
        case "context": {
            // AutoCards was called within the context modifier
            advanceChronometer();
            // Get or construct the "Configure Auto-Cards" story card
            const configureCardTemplate = getConfigureCardTemplate();
            const configureCard = getSingletonCard(true, configureCardTemplate);
            banTitle(configureCardTemplate.title);
            pinAndSortCards(configureCard);
            const bansOverwritten = (0 < AC.signal.overrideBans);
            if ((configureCard.description !== configureCardTemplate.description) || bansOverwritten) {
                const descConfigPatterns = (getConfigureCardDescription()
                    .split(Words.delimiter)
                    .slice(1)
                    .map(descPattern => (descPattern
                        .slice(0, descPattern.indexOf(":"))
                        .trim()
                        .replace(/\s+/g, "\\s*")
                    ))
                    .map(descPattern => (new RegExp("^\\s*" + descPattern + "\\s*:", "i")))
                );
                const descConfigs = configureCard.description.split(Words.delimiter).slice(1);
                if (
                    (descConfigs.length === descConfigPatterns.length)
                    && descConfigs.every((descConfig, index) => descConfigPatterns[index].test(descConfig))
                ) {
                    // All description config headers must be present and well-formed
                    let cfg = extractDescSetting(0);
                    if (AC.config.generationPrompt !== cfg) {
                        notify("Changes to your card generation prompt were successfully saved");
                        AC.config.generationPrompt = cfg;
                    }
                    cfg = extractDescSetting(1);
                    if (AC.config.compressionPrompt !== cfg) {
                        notify("Changes to your card memory compression prompt were successfully saved");
                        AC.config.compressionPrompt = cfg;
                    }
                    if (bansOverwritten) {
                        overrideBans();
                    } else if ((0 < AC.database.titles.pendingBans.length) || (0 < AC.database.titles.pendingUnbans.length)) {
                        const pendingBans = AC.database.titles.pendingBans.map(pair => pair[0]);
                        const pendingRewrites = new Set(
                            lowArr([...pendingBans, ...AC.database.titles.pendingUnbans.map(pair => pair[0])])
                        );
                        Internal.setBannedTitles([...pendingBans, ...extractDescSetting(2)
                            .split(",")
                            .filter(newBan => !pendingRewrites.has(newBan.toLowerCase().replace(/\s+/, " ").trim()))
                        ], true);
                    } else {
                        Internal.setBannedTitles(extractDescSetting(2).split(","), true);
                    }
                    function extractDescSetting(index) {
                        return descConfigs[index].replace(descConfigPatterns[index], "").trim();
                    }
                } else if (bansOverwritten) {
                    overrideBans();
                }
                configureCard.description = getConfigureCardDescription();
                function overrideBans() {
                    Internal.setBannedTitles(AC.database.titles.pendingBans.map(pair => pair[0]), true);
                    AC.signal.overrideBans = 0;
                    return;
                }
            }
            if (configureCard.entry !== configureCardTemplate.entry) {
                const oldConfig = {};
                const settings = O.f((function() {
                    const userSettings = extractSettings(configureCard.entry);
                    if (userSettings.resetallconfigsettingsandprompts !== true) {
                        return userSettings;
                    }
                    // Reset all config settings and display state change notifications only when appropriate
                    Object.assign(oldConfig, AC.config);
                    Object.assign(AC.config, getDefaultConfig());
                    AC.config.deleteAllAutoCards = oldConfig.deleteAllAutoCards;
                    AC.config.LSIv2 = oldConfig.LSIv2;
                    AC.config.defaultCardType = oldConfig.defaultCardType;
                    AC.database.titles.banned = getDefaultConfigBans();
                    configureCard.description = getConfigureCardDescription();
                    configureCard.entry = getConfigureCardEntry();
                    const defaultSettings = extractSettings(configureCard.entry);
                    if ((DEFAULT_DO_AC === false) || (userSettings.disableautocards === true)) {
                        defaultSettings.disableautocards = true;
                    }
                    notify("Restoring all settings and prompts to their default values");
                    return defaultSettings;
                })());
                O.f(oldConfig);
                if ((settings.deleteallautomaticstorycards === true) && (AC.config.deleteAllAutoCards === null)) {
                    AC.config.deleteAllAutoCards = true;
                } else if (settings.showdetailedguide === true) {
                    AC.signal.outputReplacement = Words.guide;
                }
                let cfg;
                if (parseConfig("pinthisconfigcardnearthetop", false, "pinConfigureCard")) {
                    if (cfg) {
                        pinAndSortCards(configureCard);
                        notify("The settings config card will now be pinned near the top of your story cards list");
                    } else {
                        const index = storyCards.indexOf(configureCard);
                        if (index !== -1) {
                            storyCards.splice(index, 1);
                            storyCards.push(configureCard);
                        }
                        notify("The settings config card will no longer be pinned near the top of your story cards list");
                    }
                }
                if (parseConfig("minimumturnscooldownfornewcards", true, "addCardCooldown")) {
                    const oldCooldown = AC.config.addCardCooldown;
                    AC.config.addCardCooldown = validateCooldown(cfg);
                    if (!isPendingGeneration() && !isAwaitingGeneration() && (0 < AC.generation.cooldown)) {
                        const quarterCooldown = validateCooldown(underQuarterInteger(AC.config.addCardCooldown));
                        if ((AC.config.addCardCooldown < oldCooldown) && (quarterCooldown < AC.generation.cooldown)) {
                            // Reduce the next generation's cooldown counter by a factor of 4
                            // But only if the new cooldown config is lower than it was before
                            // And also only if quarter cooldown is less than the current next gen cooldown
                            // (Just a random little user experience improvement)
                            AC.generation.cooldown = quarterCooldown;
                        } else if (oldCooldown < AC.config.addCardCooldown) {
                            if (oldCooldown === AC.generation.cooldown) {
                                AC.generation.cooldown = AC.config.addCardCooldown;
                            } else {
                                AC.generation.cooldown = validateCooldown(boundInteger(
                                    0,
                                    AC.generation.cooldown + quarterCooldown,
                                    AC.config.addCardCooldown
                                ));
                            }
                        }
                    }
                    switch(AC.config.addCardCooldown) {
                    case 9999: {
                        notify(
                            "You have disabled automatic card generation. To re-enable, simply set your cooldown config to any number lower than 9999. Or use the \"/ac\" in-game command to manually direct the card generation process"
                        );
                        break; }
                    case 1: {
                        notify(
                            "A new card will be generated during alternating game turns, but only if your story contains available titles"
                        );
                        break; }
                    case 0: {
                        notify(
                            "New cards will be immediately generated whenever valid titles exist within your recent story"
                        );
                        break; }
                    default: {
                        notify(
                            "A new card will be generated once every " + AC.config.addCardCooldown + " turns, but only if your story contains available titles"
                        );
                        break; }
                    }
                }
                if (parseConfig("newcardsuseabulletedlistformat", false, "bulletedListMode")) {
                    if (cfg) {
                        notify("New card entries will be generated using a bulleted list format");
                    } else {
                        notify("New card entries will be generated using a pure prose format");
                    }
                }
                if (parseConfig("maximumentrylengthfornewcards", true, "defaultEntryLimit")) {
                    AC.config.defaultEntryLimit = validateEntryLimit(cfg);
                    notify(
                        "New card entries will be limited to " + AC.config.defaultEntryLimit + " characters of generated text"
                    );
                }
                if (parseConfig("newcardsperformmemoryupdates", false, "defaultCardsDoMemoryUpdates")) {
                    if (cfg) {
                        notify("Newly constructed cards will begin with memory updates enabled by default");
                    } else {
                        notify("Newly constructed cards will begin with memory updates disabled by default");
                    }
                }
                if (parseConfig("cardmemorybankpreferredlength", true, "defaultMemoryLimit")) {
                    AC.config.defaultMemoryLimit = validateMemoryLimit(cfg);
                    notify(
                        "Newly constructed cards will begin with their memory bank length preference set to " + AC.config.defaultMemoryLimit + " characters of text"
                    );
                }
                if (parseConfig("memorysummarycompressionratio", true, "memoryCompressionRatio")) {
                    AC.config.memoryCompressionRatio = validateMemCompRatio(cfg);
                    notify(
                        "Freshly summarized card memory banks will be approximately " + (AC.config.memoryCompressionRatio / 10) + "x shorter than their originals"
                    );
                }
                if (parseConfig("excludeallcapsfromtitledetection", false, "ignoreAllCapsTitles")) {
                    if (cfg) {
                        notify("All-caps text will be ignored during title detection to help prevent bad cards");
                    } else {
                        notify("All-caps text may be considered during title detection processes");
                    }
                }
                if (parseConfig("alsodetecttitlesfromplayerinputs", false, "readFromInputs")) {
                    if (cfg) {
                        notify("Titles may be detected from player Do/Say/Story action inputs");
                    } else {
                        notify("Title detection will skip player Do/Say/Story action inputs for grammatical leniency");
                    }
                }
                if (parseConfig("minimumturnsagefortitledetection", true, "minimumLookBackDistance")) {
                    AC.config.minimumLookBackDistance = validateMinLookBackDist(cfg);
                    notify(
                        "Titles and names mentioned in your story may become eligible for future card generation attempts once they are at least " + AC.config.minimumLookBackDistance + " actions old"
                    );
                }
                cfg = settings.uselivescriptinterfacev2;
                if (typeof cfg === "boolean") {
                    if (AC.config.LSIv2 === null) {
                        if (cfg) {
                            AC.config.LSIv2 = true;
                            state.LSIv2 = AC;
                            AutoCards("initialize");
                            notify("Live Script Interface v2 is now embedded within your adventure!");
                        }
                    } else {
                        if (!cfg) {
                            AC.config.LSIv2 = null;
                            notify("Live Script Interface v2 has been removed from your adventure");
                        }
                    }
                }
                if (parseConfig("logdebugdatainaseparatecard" , false, "showDebugData")) {
                    if (data === null) {
                        if (cfg) {
                            notify("State may now be viewed within the \"Debug Data\" story card");
                        } else {
                            notify("The \"Debug Data\" story card has been removed");
                        }
                    } else if (cfg) {
                        notify("Debug data will be shared with the \"Critical Data\" story card to conserve memory");
                    } else {
                        notify("Debug mode has been disabled");
                    }
                }
                if ((settings.disableautocards === true) && (AC.signal.forceToggle !== true)) {
                    disableAutoCards();
                    break;
                } else {
                    // Apply the new card entry and proceed to implement Auto-Cards onContext
                    configureCard.entry = getConfigureCardEntry();
                }
                function parseConfig(settingsKey, isNumber, configKey) {
                    cfg = settings[settingsKey];
                    if (isNumber) {
                        return checkConfig("number");
                    } else if (!checkConfig("boolean")) {
                        return false;
                    }
                    AC.config[configKey] = cfg;
                    function checkConfig(type) {
                        return ((typeof cfg === type) && (
                            (notEmptyObj(oldConfig) && (oldConfig[configKey] !== cfg))
                            || (AC.config[configKey] !== cfg)
                        ));
                    }
                    return true;
                }
            }
            if (AC.signal.forceToggle === false) {
                disableAutoCards();
                break;
            }
            AC.signal.forceToggle = null;
            if (0 < AC.chronometer.postpone) {
                CODOMAIN.initialize(TEXT);
                break;
            }
            // Fully implement Auto-Cards onContext
            const forceStep = AC.signal.recheckRetryOrErase;
            const currentTurn = getTurn();
            const nearestUnparsedAction = boundInteger(0, currentTurn - AC.config.minimumLookBackDistance);
            if (AC.signal.recheckRetryOrErase || (nearestUnparsedAction <= AC.database.titles.lastActionParsed)) {
                // The player erased or retried an unknown number of actions
                // Purge recent candidates and perform a safety recheck
                if (nearestUnparsedAction <= AC.database.titles.lastActionParsed) {
                    AC.signal.recheckRetryOrErase = true;
                } else {
                    AC.signal.recheckRetryOrErase = false;
                }
                AC.database.titles.lastActionParsed = boundInteger(-1, nearestUnparsedAction - 8);
                for (let i = AC.database.titles.candidates.length - 1; 0 <= i; i--) {
                    const candidate = AC.database.titles.candidates[i];
                    for (let j = candidate.length - 1; 0 < j; j--) {
                        if (AC.database.titles.lastActionParsed < candidate[j]) {
                            candidate.splice(j, 1);
                        }
                    }
                    if (candidate.length <= 1) {
                        AC.database.titles.candidates.splice(i, 1);
                    }
                }
            }
            const pendingCandidates = new Map();
            if ((0 < nearestUnparsedAction) && (AC.database.titles.lastActionParsed < nearestUnparsedAction)) {
                const actions = [];
                for (
                    let actionToParse = AC.database.titles.lastActionParsed + 1;
                    actionToParse <= nearestUnparsedAction;
                    actionToParse++
                ) {
                    // I wrote this whilst sleep-deprived, somehow it works
                    const lookBack = currentTurn - actionToParse - (function() {
                        if (isDoSayStory(readPastAction(0).type)) {
                            // Inputs count as 2 actions instead of 1, conditionally offset lookBack by 1
                            return 0;
                        } else {
                            return 1;
                        }
                    })();
                    if (history.length <= lookBack) {
                        // history cannot be indexed with a negative integer
                        continue;
                    }
                    const action = readPastAction(lookBack);
                    const thisTextHash = new StringsHashed(4096).add(action.text).serialize();
                    if (actionToParse === nearestUnparsedAction) {
                        if (AC.signal.recheckRetryOrErase || (thisTextHash === AC.database.titles.lastTextHash)) {
                            // Additional safety to minimize duplicate candidate additions during retries or erases
                            AC.signal.recheckRetryOrErase = true;
                            break;
                        } else {
                            // Action parsing will proceed
                            AC.database.titles.lastActionParsed = nearestUnparsedAction;
                            AC.database.titles.lastTextHash = thisTextHash;
                        }
                    } else if (
                        // Special case where a consecutive retry>erase>continue cancels out
                        AC.signal.recheckRetryOrErase
                        && (actionToParse === (nearestUnparsedAction - 1))
                        && (thisTextHash === AC.database.titles.lastTextHash)
                    ) {
                        AC.signal.recheckRetryOrErase = false;
                    }
                    actions.push([action, actionToParse]);
                }
                if (!AC.signal.recheckRetryOrErase) {
                    for (const [action, turn] of actions) {
                        if (
                            (action.type === "see")
                            || (action.type === "unknown")
                            || (!AC.config.readFromInputs && isDoSayStory(action.type))
                            || /^[^\p{Lu}]*$/u.test(action.text)
                            || action.text.includes("<<<")
                            || /\/\s*A\s*C/i.test(action.text)
                            || /CONFIRM\s*DELETE/i.test(action.text)
                        ) {
                            // Skip see actions
                            // Skip input actions (only if input title detection has been disabled in the config)
                            // Skip strings without capital letters
                            // Skip utility actions
                            continue;
                        }
                        const words = (prettifyEmDashes(action.text)
                            // Nuh uh
                            .replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").replaceAll("´", "`")
                            .replaceAll("。", ".").replaceAll("？", "?").replaceAll("！", "!")
                            // Replace special clause opening punctuation with colon ":" terminators
                            .replace(/(^|\s+)["'`]\s*/g, ": ").replace(/\s*[\(\[{]\s*/g, ": ")
                            // Likewise for end-quotes (curbs a common AI grammar mistake)
                            .replace(/\s*,?\s*["'`](?:\s+|$)/g, ": ")
                            // Replace funky wunky symbols with regular spaces
                            .replace(/[؟،«»¿¡„“…§，、\*_~><\)\]}#"`\s]/g, " ")
                            // Replace some mid-sentence punctuation symbols with a placeholder word
                            .replace(/\s*[—;,\/\\]\s*/g, " %@% ")
                            // Replace "I", "I'm", "I'd", "I'll", and "I've" with a placeholder word
                            .replace(/(?:^|\s+|-)I(?:'(?:m|d|ll|ve))?(?:\s+|-|$)/gi, " %@% ")
                            // Remove "'s" only if not followed by a letter
                            .replace(/'s(?![a-zA-Z])/g, "")
                            // Replace "s'" with "s" only if preceded but not followed by a letter
                            .replace(/(?<=[a-zA-Z])s'(?![a-zA-Z])/g, "s")
                            // Remove apostrophes not between letters (preserve contractions like "don't")
                            .replace(/(?<![a-zA-Z])'(?![a-zA-Z])/g, "")
                            // Remove a leading bullet
                            .replace(/^\s*-+\s*/, "")
                            // Replace common honorifics with a placeholder word
                            .replace(buildKiller(Words.honorifics), " %@% ")
                            // Remove common abbreviations
                            .replace(buildKiller(Words.abbreviations), " ")
                            // Fix end punctuation
                            .replace(/\s+\.(?![a-zA-Z])/g, ".").replace(/\.\.+/g, ".")
                            .replace(/\s+\?(?![a-zA-Z])/g, "?").replace(/\?\?+/g, "?")
                            .replace(/\s+!(?![a-zA-Z])/g, "!").replace(/!!+/g, "!")
                            .replace(/\s+:(?![a-zA-Z])/g, ":").replace(/::+/g, ":")
                            // Colons are treated as substitute end-punctuation, apply the capitalization rule
                            .replace(/:\s+(\S)/g, (_, next) => ": " + next.toUpperCase())
                            // Condense consecutive whitespace
                            .trim().replace(/\s+/g, " ")
                        ).split(" ");
                        if (!Array.isArray(words) || (words.length < 2)) {
                            continue;
                        }
                        const titles = [];
                        const incompleteTitle = [];
                        let previousWordTerminates = true;
                        for (let i = 0; i < words.length; i++) {
                            let word = words[i];
                            if (startsWithTerminator()) {
                                // This word begins on a terminator, push the preexisting incomplete title to titles and proceed with the next sentence's beginning
                                pushTitle();
                                previousWordTerminates = true;
                                // Ensure no leading terminators remain
                                while ((word !== "") && startsWithTerminator()) {
                                    word = word.slice(1);
                                }
                            }
                            if (word === "") {
                                continue;
                            } else if (previousWordTerminates) {
                                // We cannot detect titles from sentence beginnings due to sentence capitalization rules. The previous sentence was recently terminated, implying the current series of capitalized words (plus lowercase minor words) occurs near the beginning of the current sentence
                                if (endsWithTerminator()) {
                                    continue;
                                } else if (startsWithUpperCase()) {
                                    if (isMinorWord(word)) {
                                        // Special case where a capitalized minor word precedes a named entity, clear the previous termination status
                                        previousWordTerminates = false;
                                    }
                                    // Otherwise, proceed without clearing
                                } else if (!isMinorWord(word) && !/^(?:and|&)(?:$|[\.\?!:]$)/.test(word)) {
                                    // Previous sentence termination status is cleared by the first new non-minor lowercase word encountered during forward iteration through the action text's words
                                    previousWordTerminates = false;
                                }
                                continue;
                            }
                            // Words near the beginning of this sentence have been skipped, proceed with named entity detection using capitalization rules. An incomplete title will be pushed to titles if A) a non-minor lowercase word is encountered, B) three consecutive minor words occur in a row, C) a terminator symbol is encountered at the end of a word. Otherwise, continue pushing words to the incomplete title
                            if (endsWithTerminator()) {
                                previousWordTerminates = true;
                                while ((word !== "") && endsWithTerminator()) {
                                    word = word.slice(0, -1);
                                }
                                if (word === "") {
                                    pushTitle();
                                    continue;
                                }
                            }
                            if (isMinorWord(word)) {
                                if (0 < incompleteTitle.length) {
                                    // Titles cannot start with a minor word
                                    if (
                                        (2 < incompleteTitle.length) && !(isMinorWord(incompleteTitle[incompleteTitle.length - 1]) && isMinorWord(incompleteTitle[incompleteTitle.length - 2]))
                                    ) {
                                        // Titles cannot have 3 or more consecutive minor words in a row
                                        pushTitle();
                                        continue;
                                    } else {
                                        // Titles may contain minor words in their middles. Ex: "Ace of Spades"
                                        incompleteTitle.push(word.toLowerCase());
                                    }
                                }
                            } else if (startsWithUpperCase()) {
                                // Add this proper noun to the incomplete title
                                incompleteTitle.push(word);
                            } else {
                                // The full title has a non-minor lowercase word to its immediate right
                                pushTitle();
                                continue;
                            }
                            if (previousWordTerminates) {
                                pushTitle();
                            }
                            function pushTitle() {
                                while (
                                    (1 < incompleteTitle.length)
                                    && isMinorWord(incompleteTitle[incompleteTitle.length - 1])
                                ) {
                                    incompleteTitle.pop();
                                }
                                if (0 < incompleteTitle.length) {
                                    titles.push(incompleteTitle.join(" "));
                                    // Empty the array
                                    incompleteTitle.length = 0;
                                }
                                return;
                            }
                            function isMinorWord(testWord) {
                                return Words.minor.includes(testWord.toLowerCase());
                            }
                            function startsWithUpperCase() {
                                return /^\p{Lu}/u.test(word);
                            }
                            function startsWithTerminator() {
                                return /^[\.\?!:]/.test(word);
                            }
                            function endsWithTerminator() {
                                return /[\.\?!:]$/.test(word);
                            }
                        }
                        for (let i = titles.length - 1; 0 <= i; i--) {
                            titles[i] = formatTitle(titles[i]).newTitle;
                            if (titles[i] === "" || (
                                AC.config.ignoreAllCapsTitles
                                && (2 < titles[i].replace(/[^a-zA-Z]/g, "").length)
                                && (titles[i] === titles[i].toUpperCase())
                            )) {
                                titles.splice(i, 1);
                            }
                        }
                        // Remove duplicates
                        const uniqueTitles = [...new Set(titles)];
                        if (uniqueTitles.length === 0) {
                            continue;
                        } else if (
                            // No reason to keep checking long past the max lookback distance
                            (currentTurn < 256)
                            && (action.type === "start")
                            // This is only used here so it doesn't need its own AC.config property or validation
                            && (DEFAULT_BAN_TITLES_FROM_OPENING !== false)
                        ) {
                            // Titles in the opening prompt are banned by default, hopefully accounting for the player character's name and other established setting details
                            uniqueTitles.forEach(title => banTitle(title));
                        } else {
                            // Schedule new titles for later insertion within the candidates database
                            for (const title of uniqueTitles) {
                                const pendingHashKey = title.toLowerCase();
                                if (pendingCandidates.has(pendingHashKey)) {
                                    // Consolidate pending candidates with matching titles but different turns
                                    pendingCandidates.get(pendingHashKey).turns.push(turn);
                                } else {
                                    pendingCandidates.set(pendingHashKey, O.s({title, turns: [turn]}));
                                }
                            }
                        }
                        function buildKiller(words) {
                            return (new RegExp(("(?:^|\\s+|-)(?:" + (words
                                .map(word => word.replace(".", "\\."))
                                .join("|")
                            ) + ")(?:\\s+|-|$)"), "gi"));
                        }
                    }
                }
            }
            // Measure the minimum and maximum turns of occurance for all title candidates
            let minTurn = currentTurn;
            let maxTurn = 0;
            for (let i = AC.database.titles.candidates.length - 1; 0 <= i; i--) {
                const candidate = AC.database.titles.candidates[i];
                const title = candidate[0];
                if (isUsedOrBanned(title) || isNamed(title)) {
                    // Retroactively ensure AC.database.titles.candidates contains no used / banned titles
                    AC.database.titles.candidates.splice(i, 1);
                } else {
                    const pendingHashKey = title.toLowerCase();
                    if (pendingCandidates.has(pendingHashKey)) {
                        // This candidate title matches one of the pending candidates, collect the pending turns
                        candidate.push(...pendingCandidates.get(pendingHashKey).turns);
                        // Remove this pending candidate
                        pendingCandidates.delete(pendingHashKey);
                    }
                    if (2 < candidate.length) {
                        // Ensure all recorded turns of occurance are unique for this candidate
                        // Sort the turns from least to greatest
                        const sortedTurns = [...new Set(candidate.slice(1))].sort((a, b) => (a - b));
                        if (625 < sortedTurns.length) {
                            sortedTurns.splice(0, sortedTurns.length - 600);
                        }
                        candidate.length = 1;
                        candidate.push(...sortedTurns);
                    }
                    setCandidateTurnBounds(candidate);
                }
            }
            for (const pendingCandidate of pendingCandidates.values()) {
                // Insert any remaining pending candidates (validity has already been ensured)
                const newCandidate = [pendingCandidate.title, ...pendingCandidate.turns];
                setCandidateTurnBounds(newCandidate);
                AC.database.titles.candidates.push(newCandidate);
            }
            const isCandidatesSorted = (function() {
                if (425 < AC.database.titles.candidates.length) {
                    // Sorting a large title candidates database is computationally expensive
                    sortCandidates();
                    AC.database.titles.candidates.splice(400);
                    // Flag this operation as complete for later consideration
                    return true;
                } else {
                    return false;
                }
            })();
            Internal.getUsedTitles();
            for (const titleKey in AC.database.memories.associations) {
                if (isAuto(titleKey)) {
                    // Reset the lifespan counter
                    AC.database.memories.associations[titleKey][0] = 999;
                } else if (AC.database.memories.associations[titleKey][0] < 1) {
                    // Forget this set of memory associations
                    delete AC.database.memories.associations[titleKey];
                } else if (!isAwaitingGeneration()) {
                    // Decrement the lifespan counter
                    AC.database.memories.associations[titleKey][0]--;
                }
            }
            // This copy of TEXT may be mutated
            let context = TEXT;
            const titleHeaderPatternGlobal = /\s*{\s*titles?\s*:\s*([\s\S]*?)\s*}\s*/gi;
            // Card events govern the parsing of memories from raw context as well as card memory bank injection
            const cardEvents = (function() {
                // Extract memories from the initial text (not TEXT as called from within the context modifier!)
                const contextMemories = (function() {
                    const memoriesMatch = text.match(/Memories\s*:\s*([\s\S]*?)\s*(?:Recent\s*Story\s*:|$)/i);
                    if (!memoriesMatch) {
                        return new Set();
                    }
                    const uniqueMemories = new Set(isolateMemories(memoriesMatch[1]));
                    if (uniqueMemories.size === 0) {
                        return uniqueMemories;
                    }
                    const duplicatesHashed = StringsHashed.deserialize(AC.database.memories.duplicates, 65536);
                    const duplicateMemories = new Set();
                    const seenMemories = new Set();
                    for (const memoryA of uniqueMemories) {
                        if (duplicatesHashed.has(memoryA)) {
                            // Remove to ensure the insertion order for this duplicate changes
                            duplicatesHashed.remove(memoryA);
                            duplicateMemories.add(memoryA);
                        } else if ((function() {
                            for (const memoryB of seenMemories) {
                                if (0.42 < similarityScore(memoryA, memoryB)) {
                                    // This memory is too similar to another memory
                                    duplicateMemories.add(memoryA);
                                    return false;
                                }
                            }
                            return true;
                        })()) {
                            seenMemories.add(memoryA);
                        }
                    }
                    if (0 < duplicateMemories.size) {
                        // Add each near duplicate's hashcode to AC.database.memories.duplicates
                        // Then remove duplicates from uniqueMemories and the context window
                        for (const duplicate of duplicateMemories) {
                            duplicatesHashed.add(duplicate);
                            uniqueMemories.delete(duplicate);
                            context = context.replaceAll("\n" + duplicate, "");
                        }
                        // Only the 2000 most recent duplicate memory hashcodes are remembered
                        AC.database.memories.duplicates = duplicatesHashed.latest(2000).serialize();
                    }
                    return uniqueMemories;
                })();
                const leftBoundary = "^|\\s|\"|'|—|\\(|\\[|{";
                const rightBoundary = "\\s|\\.|\\?|!|,|;|\"|'|—|\\)|\\]|}|$";
                // Murder, homicide if you will, nothing to see here
                const theKiller = new RegExp("(?:" + leftBoundary + ")the[\\s\\S]*$", "i");
                const peerageKiller = new RegExp((
                    "(?:" + leftBoundary + ")(?:" + Words.peerage.join("|") + ")(?:" + rightBoundary + ")"
                ), "gi");
                const events = new Map();
                for (const contextMemory of contextMemories) {
                    for (const titleKey of auto) {
                        if (!(new RegExp((
                            "(?<=" + leftBoundary + ")" + (titleKey
                                .replace(theKiller, "")
                                .replace(peerageKiller, "")
                                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                            ) + "(?=" + rightBoundary + ")"
                        ), "i")).test(contextMemory)) {
                            continue;
                        }
                        // AC card titles found in active memories will promote card events
                        if (events.has(titleKey)) {
                            events.get(titleKey).pendingMemories.push(contextMemory);
                            continue;
                        }
                        events.set(titleKey, O.s({
                            pendingMemories: [contextMemory],
                            titleHeader: ""
                        }));
                    }
                }
                const titleHeaderMatches = [...context.matchAll(titleHeaderPatternGlobal)];
                for (const [titleHeader, title] of titleHeaderMatches) {
                    if (!isAuto(title)) {
                        continue;
                    }
                    // Unique title headers found in context will promote card events
                    const titleKey = title.toLowerCase();
                    if (events.has(titleKey)) {
                        events.get(titleKey).titleHeader = titleHeader;
                        continue;
                    }
                    events.set(titleKey, O.s({
                        pendingMemories: [],
                        titleHeader: titleHeader
                    }));
                }
                return events;
            })();
            // Remove auto card title headers from active story card entries and contextualize their respective memory banks
            // Also handle the growth and maintenance of card memory banks
            let isRemembering = false;
            for (const card of storyCards) {
                // Iterate over each card to handle pending card events and forenames/surnames
                const titleHeaderMatcher = /^{title: \s*([\s\S]*?)\s*}/;
                let breakForCompression = isPendingCompression();
                if (breakForCompression) {
                    break;
                } else if (!card.entry.startsWith("{title: ")) {
                    continue;
                } else if (exceedsMemoryLimit()) {
                    const titleHeaderMatch = card.entry.match(titleHeaderMatcher);
                    if (titleHeaderMatch && isAuto(titleHeaderMatch[1])) {
                        prepareMemoryCompression(titleHeaderMatch[1].toLowerCase());
                        break;
                    }
                }
                // Handle card events
                const lowerEntry = card.entry.toLowerCase();
                for (const titleKey of cardEvents.keys()) {
                    if (!lowerEntry.startsWith("{title: " + titleKey + "}")) {
                        continue;
                    }
                    const cardEvent = cardEvents.get(titleKey);
                    if (
                        (0 < cardEvent.pendingMemories.length)
                        && /{\s*updates?\s*:\s*true\s*,\s*limits?\s*:[\s\S]*?}/i.test(card.description)
                    ) {
                        // Add new card memories
                        const associationsHashed = (function() {
                            if (titleKey in AC.database.memories.associations) {
                                return StringsHashed.deserialize(AC.database.memories.associations[titleKey][1], 65536);
                            } else {
                                AC.database.memories.associations[titleKey] = [999, ""];
                                return new StringsHashed(65536);
                            }
                        })();
                        const oldMemories = isolateMemories(extractCardMemories().text);
                        for (let i = 0; i < cardEvent.pendingMemories.length; i++) {
                            if (associationsHashed.has(cardEvent.pendingMemories[i])) {
                                // Remove first to alter the insertion order
                                associationsHashed.remove(cardEvent.pendingMemories[i]);
                            } else if (!oldMemories.some(oldMemory => (
                                (0.8 < similarityScore(oldMemory, cardEvent.pendingMemories[i]))
                            ))) {
                                // Ensure no near-duplicate memories are appended
                                card.description += "\n- " + cardEvent.pendingMemories[i];
                            }
                            associationsHashed.add(cardEvent.pendingMemories[i]);
                        }
                        AC.database.memories.associations[titleKey][1] = associationsHashed.latest(3500).serialize();
                        if (associationsHashed.size() === 0) {
                            delete AC.database.memories.associations[titleKey];
                        }
                        if (exceedsMemoryLimit()) {
                            breakForCompression = prepareMemoryCompression(titleKey);
                            break;
                        }
                    }
                    if (cardEvent.titleHeader !== "") {
                        // Replace this card's title header in context
                        const cardMemoriesText = extractCardMemories().text;
                        if (cardMemoriesText === "") {
                            // This card contains no card memories to contextualize
                            context = context.replace(cardEvent.titleHeader, "\n\n");
                        } else {
                            // Insert card memories within context and ensure they occur uniquely
                            const cardMemories = cardMemoriesText.split("\n").map(cardMemory => cardMemory.trim());
                            for (const cardMemory of cardMemories) {
                                if (25 < cardMemory.length) {
                                    context = (context
                                        .replaceAll(cardMemory, "<#>")
                                        .replaceAll(cardMemory.replace(/^-+\s*/, ""), "<#>")
                                    );
                                }
                            }
                            context = context.replace(cardEvent.titleHeader, (
                                "\n\n{%@MEM@%" + cardMemoriesText + "%@MEM@%}\n"
                            ));
                            isRemembering = true;
                        }
                    }
                    cardEvents.delete(titleKey);
                    break;
                }
                if (breakForCompression) {
                    break;
                }
                // Simplify auto-card titles which contain an obvious surname
                const titleHeaderMatch = card.entry.match(titleHeaderMatcher);
                if (!titleHeaderMatch) {
                    continue;
                }
                const [oldTitleHeader, oldTitle] = titleHeaderMatch;
                if (!isAuto(oldTitle)) {
                    continue;
                }
                const surname = isNamed(oldTitle, true);
                if (typeof surname !== "string") {
                    continue;
                }
                const newTitle = oldTitle.replace(" " + surname, "");
                const [oldTitleKey, newTitleKey] = [oldTitle, newTitle].map(title => title.toLowerCase());
                if (oldTitleKey === newTitleKey) {
                    continue;
                }
                // Preemptively mitigate some global state considered within the formatTitle scope
                clearTransientTitles();
                AC.database.titles.used = ["%@%"];
                [used, forenames, surnames].forEach(nameset => nameset.add("%@%"));
                // Premature optimization is the root of all evil
                const newKey = formatTitle(newTitle).newKey;
                clearTransientTitles();
                if (newKey === "") {
                    Internal.getUsedTitles();
                    continue;
                }
                if (oldTitleKey in AC.database.memories.associations) {
                    AC.database.memories.associations[newTitleKey] = AC.database.memories.associations[oldTitleKey];
                    delete AC.database.memories.associations[oldTitleKey];
                }
                if (AC.compression.titleKey === oldTitleKey) {
                    AC.compression.titleKey = newTitleKey;
                }
                card.entry = card.entry.replace(oldTitleHeader, oldTitleHeader.replace(oldTitle, newTitle));
                card.keys = buildKeys(card.keys.replaceAll(" " + surname, ""), newKey);
                Internal.getUsedTitles();
                function exceedsMemoryLimit() {
                    return ((function() {
                        const memoryLimitMatch = card.description.match(/limits?\s*:\s*(\d+)\s*}/i);
                        if (memoryLimitMatch) {
                            return validateMemoryLimit(parseInt(memoryLimitMatch[1], 10));
                        } else {
                            return AC.config.defaultMemoryLimit;
                        }
                    })() < (function() {
                        const cardMemories = extractCardMemories();
                        if (cardMemories.missing) {
                            return card.description;
                        } else {
                            return cardMemories.text;
                        }
                    })().length);
                }
                function prepareMemoryCompression(titleKey) {
                    AC.compression.oldMemoryBank = isolateMemories(extractCardMemories().text);
                    if (AC.compression.oldMemoryBank.length === 0) {
                        return false;
                    }
                    AC.compression.completed = 0;
                    AC.compression.titleKey = titleKey;
                    AC.compression.vanityTitle = cleanSpaces(card.title.trim());
                    AC.compression.responseEstimate = (function() {
                        const responseEstimate = estimateResponseLength();
                        if (responseEstimate === -1) {
                            return 1400
                        } else {
                            return responseEstimate;
                        }
                    })();
                    AC.compression.lastConstructIndex = -1;
                    AC.compression.newMemoryBank = [];
                    return true;
                }
                function extractCardMemories() {
                    const memoryHeaderMatch = card.description.match(
                        /(?<={\s*updates?\s*:[\s\S]*?,\s*limits?\s*:[\s\S]*?})[\s\S]*$/i
                    );
                    if (memoryHeaderMatch) {
                        return O.f({missing: false, text: cleanSpaces(memoryHeaderMatch[0].trim())});
                    } else {
                        return O.f({missing: true, text: ""});
                    }
                }
            }
            // Remove repeated memories plus any remaining title headers
            context = (context
                .replace(/(\s*<#>\s*)+/g, "\n")
                .replace(titleHeaderPatternGlobal, "\n\n")
                .replace(/World\s*Lore\s*:\s*/i, "World Lore:\n")
                .replace(/Memories\s*:\s*(?=Recent\s*Story\s*:|$)/i, "")
            );
            // Prompt the AI to generate a new card entry, compress an existing card's memories, or continue the story
            let isGenerating = false;
            let isCompressing = false;
            if (isPendingGeneration()) {
                promptGeneration();
            } else if (isAwaitingGeneration()) {
                AC.generation.workpiece = AC.generation.pending.shift();
                promptGeneration();
            } else if (isPendingCompression()) {
                promptCompression();
            } else if (AC.signal.recheckRetryOrErase) {
                // Do nothing 😜
            } else if ((AC.generation.cooldown <= 0) && (0 < AC.database.titles.candidates.length)) {
                // Prepare to automatically construct a new plot-relevant story card by selecting a title
                let selectedTitle = (function() {
                    if (AC.database.titles.candidates.length === 1) {
                        return AC.database.titles.candidates[0][0];
                    } else if (!isCandidatesSorted) {
                        sortCandidates();
                    }
                    const mostRelevantTitle = AC.database.titles.candidates[0][0];
                    if ((AC.database.titles.candidates.length < 16) || (Math.random() < 0.6667)) {
                        // Usually, 2/3 of the time, the most relevant title is selected
                        return mostRelevantTitle;
                    }
                    // Occasionally (1/3 of the time once the candidates databases has at least 16 titles) make a completely random selection between the top 4 most recently occuring title candidates which are NOT the top 2 most relevant titles. Note that relevance !== recency
                    // This gives non-character titles slightly better odds of being selected for card generation due to the relevance sorter's inherent bias towards characters; they tend to appear far more often in prose
                    return (AC.database.titles.candidates
                        // Create a shallow copy to avoid modifying AC.database.titles.candidates itself
                        // Add index to preserve original positions whenever ties occur during sorting
                        .map((candidate, index) => ({candidate, index}))
                        // Sort by each candidate's most recent turn
                        .sort((a, b) => {
                            const turnDiff = b.candidate[b.candidate.length - 1] - a.candidate[a.candidate.length - 1];
                            if (turnDiff === 0) {
                                // Don't change indices in the case of a tie
                                return (a.index - b.index);
                            } else {
                                // No tie here, sort by recency
                                return turnDiff;
                            }
                        })
                        // Get the top 6 most recent titles (4 + 2 because the top 2 relevant titles may be present)
                        .slice(0, 6)
                        // Extract only the title names
                        .map(element => element.candidate[0])
                        // Exclude the top 2 most relevant titles
                        .filter(title => ((title !== mostRelevantTitle) && (title !== AC.database.titles.candidates[1][0])))
                        // Ensure only 4 titles remain
                        .slice(0, 4)
                    )[Math.floor(Math.random() * 4)];
                })();
                while (!Internal.generateCard(O.f({title: selectedTitle}))) {
                    // This is an emergency precaution, I don't expect the interior of this while loop to EVER execute
                    // That said, it's crucial for the while condition be checked at least once, because Internal.generateCard appends an element to AC.generation.pending as a side effect
                    const lowerSelectedTitle = formatTitle(selectedTitle).newTitle.toLowerCase();
                    const index = AC.database.titles.candidates.findIndex(candidate => {
                        return (formatTitle(candidate[0]).newTitle.toLowerCase() === lowerSelectedTitle);
                    });
                    if (index === -1) {
                        // Should be impossible
                        break;
                    }
                    AC.database.titles.candidates.splice(index, 1);
                    if (AC.database.titles.candidates.length === 0) {
                        break;
                    }
                    selectedTitle = AC.database.titles.candidates[0][0];
                }
                if (isAwaitingGeneration()) {
                    // Assign the workpiece so card generation may fully commence!
                    AC.generation.workpiece = AC.generation.pending.shift();
                    promptGeneration();
                } else if (isPendingCompression()) {
                    promptCompression();
                }
            } else if (
                (AC.chronometer.step || forceStep)
                && (0 < AC.generation.cooldown)
                && (AC.config.addCardCooldown !== 9999)
            ) {
                AC.generation.cooldown--;
            }
            if (shouldTrimContext()) {
                // Truncate context based on AC.signal.maxChars, begin by individually removing the oldest sentences from the recent story portion of the context window
                const recentStoryPattern = /Recent\s*Story\s*:\s*([\s\S]*?)(%@GEN@%|%@COM@%|\s\[\s*Author's\s*note\s*:|$)/i;
                const recentStoryMatch = context.match(recentStoryPattern);
                if (recentStoryMatch) {
                    const recentStory = recentStoryMatch[1];
                    let sentencesJoined = recentStory;
                    // Split by the whitespace chars following each sentence (without consuming)
                    const sentences = splitBySentences(recentStory);
                    // [minimum num of story sentences] = ([max chars for context] / 6) / [average chars per sentence]
                    const sentencesMinimum = Math.ceil(
                        (AC.signal.maxChars / 6) / (
                            boundInteger(1, context.length) / boundInteger(1, sentences.length)
                        )
                    ) + 1;
                    do {
                        if (sentences.length < sentencesMinimum) {
                            // A minimum of n many recent story sentences must remain
                            // Where n represents a sentence count equal to roughly 16.7% of the full context chars
                            break;
                        }
                        // Remove the first (oldest) recent story sentence
                        sentences.shift();
                        // Check if the total length exceeds the AC.signal.maxChars limit
                        sentencesJoined = sentences.join("");
                    } while (AC.signal.maxChars < (context.length - recentStory.length + sentencesJoined.length + 3));
                    // Rebuild the context with the truncated recentStory
                    context = context.replace(recentStoryPattern, "Recent Story:\n" + sentencesJoined + recentStoryMatch[2]);
                }
                if (isRemembering && shouldTrimContext()) {
                    // Next remove loaded card memories (if any) with top-down priority, one card at a time
                    do {
                        // This matcher relies on its case-sensitivity
                        const cardMemoriesMatch = context.match(/{%@MEM@%([\s\S]+?)%@MEM@%}/);
                        if (!cardMemoriesMatch) {
                            break;
                        }
                        context = context.replace(cardMemoriesMatch[0], (cardMemoriesMatch[0]
                            .replace(cardMemoriesMatch[1], "")
                            // Set the MEM tags to lowercase to avoid repeated future matches
                            .toLowerCase()
                        ));
                    } while (AC.signal.maxChars < (context.length + 3));
                }
                if (shouldTrimContext()) {
                    // If the context is still too long, just trim from the beginning I guess 🤷‍♀️
                    context = context.slice(context.length - AC.signal.maxChars + 1);
                }
            }
            if (isRemembering) {
                // Card memory flags serve no further purpose
                context = (context
                    // Case-insensitivity is crucial here
                    .replace(/(?<={%@MEM@%)\s*/gi, "")
                    .replace(/\s*(?=%@MEM@%})/gi, "")
                    .replace(/{%@MEM@%%@MEM@%}\s?/gi, "")
                    .replaceAll("{%@MEM@%", "{ Memories:\n")
                    .replaceAll("%@MEM@%}", " }")
                );
            }
            if (isGenerating) {
                // Likewise for the card entry generation delimiter
                context = context.replaceAll("%@GEN@%", "");
            } else if (isCompressing) {
                // Or the (mutually exclusive) card memory compression delimiter
                context = context.replaceAll("%@COM@%", "");
            }
            CODOMAIN.initialize(context);
            function isolateMemories(memoriesText) {
                return (memoriesText
                    .split("\n")
                    .map(memory => cleanSpaces(memory.trim().replace(/^-+\s*/, "")))
                    .filter(memory => (memory !== ""))
                );
            }
            function isAuto(title) {
                return auto.has(title.toLowerCase());
            }
            function promptCompression() {
                isGenerating = false;
                const cardEntryText = (function() {
                    const card = getAutoCard(AC.compression.titleKey);
                    if (card === null) {
                        return null;
                    }
                    const entryLines = formatEntry(card.entry).trimEnd().split("\n");
                    if (Object.is(entryLines[0].trim(), "")) {
                        return "";
                    }
                    for (let i = 0; i < entryLines.length; i++) {
                        entryLines[i] = entryLines[i].trim();
                        if (/[a-zA-Z]$/.test(entryLines[i])) {
                            entryLines[i] += ".";
                        }
                        entryLines[i] += " ";
                    }
                    return entryLines.join("");
                })();
                if (cardEntryText === null) {
                    // Safety measure
                    resetCompressionProperties();
                    return;
                }
                repositionAN();
                // The "%COM%" substring serves as a temporary delimiter for later context length trucation
                context = context.trimEnd() + "\n\n" + cardEntryText + (
                    [...AC.compression.newMemoryBank, ...AC.compression.oldMemoryBank].join(" ")
                ) + "%@COM@%\n\n" + (function() {
                    const memoryConstruct = (function() {
                        if (AC.compression.lastConstructIndex === -1) {
                            for (let i = 0; i < AC.compression.oldMemoryBank.length; i++) {
                                AC.compression.lastConstructIndex = i;
                                const memoryConstruct = buildMemoryConstruct();
                                if ((
                                    (AC.config.memoryCompressionRatio / 10) * AC.compression.responseEstimate
                                ) < memoryConstruct.length) {
                                    return memoryConstruct;
                                }
                            }
                        } else {
                            // The previous card memory compression attempt produced a bad output
                            AC.compression.lastConstructIndex = boundInteger(
                                0, AC.compression.lastConstructIndex + 1, AC.compression.oldMemoryBank.length - 1
                            );
                        }
                        return buildMemoryConstruct();
                    })();
                    // Fill all %{title} placeholders
                    const precursorPrompt = insertTitle(AC.config.compressionPrompt, AC.compression.vanityTitle).trim();
                    const memoryPlaceholderPattern = /(?:[%\$]+\s*|[%\$]*){+\s*memor(y|ies)\s*}+/gi;
                    if (memoryPlaceholderPattern.test(precursorPrompt)) {
                        // Fill all %{memory} placeholders with a selection of pending old memories
                        return precursorPrompt.replace(memoryPlaceholderPattern, memoryConstruct);
                    } else {
                        // Append the partial entry to the end of context
                        return precursorPrompt + "\n\n" + memoryConstruct;
                    }
                })() + "\n\n";
                isCompressing = true;
                return;
            }
            function promptGeneration() {
                repositionAN();
                // All %{title} placeholders were already filled during this workpiece's initialization
                // The "%GEN%" substring serves as a temporary delimiter for later context length trucation
                context = context.trimEnd() + "%@GEN@%\n\n" + (function() {
                    // For context only, remove the title header from this workpiece's partially completed entry
                    const partialEntry = formatEntry(AC.generation.workpiece.entry);
                    const entryPlaceholderPattern = /(?:[%\$]+\s*|[%\$]*){+\s*entry\s*}+/gi;
                    if (entryPlaceholderPattern.test(AC.generation.workpiece.prompt)) {
                        // Fill all %{entry} placeholders with the partial entry
                        return AC.generation.workpiece.prompt.replace(entryPlaceholderPattern, partialEntry);
                    } else {
                        // Append the partial entry to the end of context
                        return AC.generation.workpiece.prompt.trimEnd() + "\n\n" + partialEntry;
                    }
                })();
                isGenerating = true;
                return;
            }
            function repositionAN() {
                // Move the Author's Note further back in context during card generation (should still be considered)
                const authorsNotePattern = /\s*(\[\s*Author's\s*note\s*:[\s\S]*\])\s*/i;
                const authorsNoteMatch = context.match(authorsNotePattern);
                if (!authorsNoteMatch) {
                    return;
                }
                const leadingSpaces = context.match(/^\s*/)[0];
                context = context.replace(authorsNotePattern, " ").trimStart();
                const recentStoryPattern = /\s*Recent\s*Story\s*:\s*/i;
                if (recentStoryPattern.test(context)) {
                    // Remove author's note from its original position and insert above "Recent Story:\n"
                    context = (context
                        .replace(recentStoryPattern, "\n\n" + authorsNoteMatch[1] + "\n\nRecent Story:\n")
                        .trimStart()
                    );
                } else {
                    context = authorsNoteMatch[1] + "\n\n" + context;
                }
                context = leadingSpaces + context;
                return;
            }
            function sortCandidates() {
                if (AC.database.titles.candidates.length < 2) {
                    return;
                }
                const turnRange = boundInteger(1, maxTurn - minTurn);
                const recencyExponent = Math.log10(turnRange) + 1.85;
                // Sort the database of available title candidates by relevance
                AC.database.titles.candidates.sort((a, b) => {
                    return relevanceScore(b) - relevanceScore(a);
                });
                function relevanceScore(candidate) {
                    // weight = (((turn - minTurn) / (maxTurn - minTurn)) + 1)^(log10(maxTurn - minTurn) + 1.85)
                    return candidate.slice(1).reduce((sum, turn) => {
                        // Apply exponential scaling to give far more weight to recent turns
                        return sum + Math.pow((
                            // The recency weight's exponent scales by log10(turnRange) + 1.85
                            // Shhh don't question it 😜
                            ((turn - minTurn) / turnRange) + 1
                        ), recencyExponent);
                    }, 0);
                }
                return;
            }
            function shouldTrimContext() {
                return (AC.signal.maxChars <= context.length);
            }
            function setCandidateTurnBounds(candidate) {
                // candidate: ["Example Title", 0, 1, 2, 3]
                minTurn = boundInteger(0, minTurn, candidate[1]);
                maxTurn = boundInteger(candidate[candidate.length - 1], maxTurn);
                return;
            }
            function disableAutoCards() {
                AC.signal.forceToggle = null;
                // Auto-Cards has been disabled
                AC.config.doAC = false;
                // Deconstruct the "Configure Auto-Cards" story card
                unbanTitle(configureCardTemplate.title);
                eraseCard(configureCard);
                // Signal the construction of "Edit to enable Auto-Cards" during the next onOutput hook
                AC.signal.swapControlCards = true;
                // Post a success message
                notify("Disabled! Use the \"Edit to enable Auto-Cards\" story card to undo");
                CODOMAIN.initialize(TEXT);
                return;
            }
            break; }
        case "output": {
            // AutoCards was called within the output modifier
            const output = prettifyEmDashes(TEXT);
            if (0 < AC.chronometer.postpone) {
                // Do not capture or replace any outputs during this turn
                promoteAmnesia();
                if (permitOutput()) {
                    CODOMAIN.initialize(output);
                }
            } else if (AC.signal.swapControlCards) {
                if (permitOutput()) {
                    CODOMAIN.initialize(output);
                }
            } else if (isPendingGeneration()) {
                const textClone = prettifyEmDashes(text);
                AC.chronometer.amnesia = 0;
                AC.generation.completed++;
                const generationsRemaining = (function() {
                    if (
                        textClone.includes("\"")
                        || /(?<=^|\s|—|\(|\[|{)sa(ys?|id)(?=\s|\.|\?|!|,|;|—|\)|\]|}|$)/i.test(textClone)
                    ) {
                        // Discard full outputs containing "say" or quotations
                        // To build coherent entries, the AI must not attempt to continue the story
                        return skip(estimateRemainingGens());
                    }
                    const oldSentences = (splitBySentences(formatEntry(AC.generation.workpiece.entry))
                        .map(sentence => sentence.trim())
                        .filter(sentence => (2 < sentence.length))
                    );
                    const seenSentences = new Set();
                    const entryAddition = splitBySentences(textClone
                        .replace(/[\*_~]/g, "")
                        .replace(/:+/g, "#")
                        .replace(/\s+/g, " ")
                    ).map(sentence => (sentence
                        .trim()
                        .replace(/^-+\s*/, "")
                    )).filter(sentence => (
                        // Remove empty strings
                        (sentence !== "")
                        // Remove colon ":" headers or other stinky symbols because me no like 😠
                        && !/[#><@]/.test(sentence)
                        // Remove previously repeated sentences
                        && !oldSentences.some(oldSentence => (0.75 < similarityScore(oldSentence, sentence)))
                        // Remove repeated sentences from within entryAddition itself
                        && ![...seenSentences].some(seenSentence => (0.75 < similarityScore(seenSentence, sentence)))
                        // Simply ensure this sentence is henceforth unique
                        && seenSentences.add(sentence)
                    )).join(" ").trim() + " ";
                    if (entryAddition === " ") {
                        return skip(estimateRemainingGens());
                    } else if (
                        /^{title:[\s\S]*?}$/.test(AC.generation.workpiece.entry.trim())
                        && (AC.generation.workpiece.entry.length < 111)
                    ) {
                        AC.generation.workpiece.entry += "\n" + entryAddition;
                    } else {
                        AC.generation.workpiece.entry += entryAddition;
                    }
                    if (AC.generation.workpiece.limit < AC.generation.workpiece.entry.length) {
                        let exit = false;
                        let truncatedEntry = AC.generation.workpiece.entry.trimEnd();
                        const sentences = splitBySentences(truncatedEntry);
                        for (let i = sentences.length - 1; 0 <= i; i--) {
                            if (!sentences[i].includes("\n")) {
                                sentences.splice(i, 1);
                                truncatedEntry = sentences.join("").trimEnd();
                                if (truncatedEntry.length <= AC.generation.workpiece.limit) {
                                    break;
                                }
                                continue;
                            }
                            // Lines only matter for initial entries provided via AutoCards().API.generateCard
                            const lines = sentences[i].split("\n");
                            for (let j = lines.length - 1; 0 <= j; j--) {
                                lines.splice(j, 1);
                                sentences[i] = lines.join("\n");
                                truncatedEntry = sentences.join("").trimEnd();
                                if (truncatedEntry.length <= AC.generation.workpiece.limit) {
                                    // Exit from both loops
                                    exit = true;
                                    break;
                                }
                            }
                            if (exit) {
                                break;
                            }
                        }
                        if (truncatedEntry.length < 150) {
                            // Disregard the previous sentence/line-based truncation attempt
                            AC.generation.workpiece.entry = limitString(
                                AC.generation.workpiece.entry, AC.generation.workpiece.limit
                            );
                            // Attempt to remove the last word/fragment
                            truncatedEntry = AC.generation.workpiece.entry.replace(/\s*\S+$/, "");
                            if (150 <= truncatedEntry) {
                                AC.generation.workpiece.entry = truncatedEntry;
                            }
                        } else {
                            AC.generation.workpiece.entry = truncatedEntry;
                        }
                        return 0;
                    } else if ((AC.generation.workpiece.limit - 50) <= AC.generation.workpiece.entry.length) {
                        AC.generation.workpiece.entry = AC.generation.workpiece.entry.trimEnd();
                        return 0;
                    }
                    function skip(remaining) {
                        if (AC.generation.permitted <= AC.generation.completed) {
                            AC.generation.workpiece.entry = AC.generation.workpiece.entry.trimEnd();
                            return 0;
                        }
                        return remaining;
                    }
                    function estimateRemainingGens() {
                        const responseEstimate = estimateResponseLength();
                        if (responseEstimate === -1) {
                            return 1;
                        }
                        const remaining = boundInteger(1, Math.round(
                            (150 + AC.generation.workpiece.limit - AC.generation.workpiece.entry.length) / responseEstimate
                        ));
                        if (AC.generation.permitted === 34) {
                            AC.generation.permitted = boundInteger(6, Math.floor(3.5 * remaining), 32);
                        }
                        return remaining;
                    }
                    return skip(estimateRemainingGens());
                })();
                postOutputMessage(textClone, AC.generation.completed / Math.min(
                    AC.generation.permitted,
                    AC.generation.completed + generationsRemaining
                ));
                if (generationsRemaining <= 0) {
                    notify("\"" + AC.generation.workpiece.title + "\" was successfully added to your story cards!");
                    constructCard(O.f({
                        type: AC.generation.workpiece.type,
                        title: AC.generation.workpiece.title,
                        keys: AC.generation.workpiece.keys,
                        entry: (function() {
                            if (!AC.config.bulletedListMode) {
                                return AC.generation.workpiece.entry;
                            }
                            const sentences = splitBySentences(
                                formatEntry(
                                    AC.generation.workpiece.entry.replace(/\s+/g, " ")
                                ).replace(/:+/g, "#")
                            ).map(sentence => {
                                sentence = (sentence
                                    .replaceAll("#", ":")
                                    .trim()
                                    .replace(/^-+\s*/, "")
                                );
                                if (sentence.length < 12) {
                                    return sentence;
                                } else {
                                    return "\n- " + sentence.replace(/\s*[\.\?!]+$/, "");
                                }
                            });
                            const titleHeader = "{title: " + AC.generation.workpiece.title + "}";
                            if (sentences.every(sentence => (sentence.length < 12))) {
                                const sentencesJoined = sentences.join(" ").trim();
                                if (sentencesJoined === "") {
                                    return titleHeader;
                                } else {
                                    return limitString(titleHeader + "\n" + sentencesJoined, 2000);
                                }
                            }
                            for (let i = sentences.length - 1; 0 <= i; i--) {
                                const bulletedEntry = cleanSpaces(titleHeader + sentences.join(" ")).trimEnd();
                                if (bulletedEntry.length <= 2000) {
                                    return bulletedEntry;
                                }
                                if (sentences.length === 1) {
                                    break;
                                }
                                sentences.splice(i, 1);
                            }
                            return limitString(AC.generation.workpiece.entry, 2000);
                        })(),
                        description: AC.generation.workpiece.description,
                    }), newCardIndex());
                    AC.generation.cooldown = AC.config.addCardCooldown;
                    AC.generation.completed = 0;
                    AC.generation.permitted = 34;
                    AC.generation.workpiece = O.f({});
                    clearTransientTitles();
                }
            } else if (isPendingCompression()) {
                const textClone = prettifyEmDashes(text);
                AC.chronometer.amnesia = 0;
                AC.compression.completed++;
                const compressionsRemaining = (function() {
                    const newMemory = (textClone
                        // Remove some dumb stuff
                        .replace(/^[\s\S]*:/g, "")
                        .replace(/[\*_~#><@\[\]{}`\\]/g, " ")
                        // Remove bullets
                        .trim().replace(/^-+\s*/, "").replace(/\s*-+$/, "").replace(/\s*-\s+/g, " ")
                        // Condense consecutive whitespace
                        .replace(/\s+/g, " ")
                    );
                    if ((AC.compression.oldMemoryBank.length - 1) <= AC.compression.lastConstructIndex) {
                        // Terminate this compression cycle; the memory construct cannot grow any further
                        AC.compression.newMemoryBank.push(newMemory);
                        return 0;
                    } else if ((newMemory.trim() !== "") && (newMemory.length < buildMemoryConstruct().length)) {
                        // Good output, preserve and then proceed onwards
                        AC.compression.oldMemoryBank.splice(0, AC.compression.lastConstructIndex + 1);
                        AC.compression.lastConstructIndex = -1;
                        AC.compression.newMemoryBank.push(newMemory);
                    } else {
                        // Bad output, discard and then try again
                        AC.compression.responseEstimate += 200;
                    }
                    return boundInteger(1, joinMemoryBank(AC.compression.oldMemoryBank).length) / AC.compression.responseEstimate;
                })();
                postOutputMessage(textClone, AC.compression.completed / (AC.compression.completed + compressionsRemaining));
                if (compressionsRemaining <= 0) {
                    const card = getAutoCard(AC.compression.titleKey);
                    if (card === null) {
                        notify(
                            "Failed to apply summarized memories for \"" + AC.compression.vanityTitle + "\" due to a missing or invalid AC card title header!"
                        );
                    } else {
                        const memoryHeaderMatch = card.description.match(
                            /(?<={\s*updates?\s*:[\s\S]*?,\s*limits?\s*:[\s\S]*?})[\s\S]*$/i
                        );
                        if (memoryHeaderMatch) {
                            // Update the card memory bank
                            notify("Memories for \"" + AC.compression.vanityTitle + "\" were successfully summarized!");
                            card.description = card.description.replace(memoryHeaderMatch[0], (
                                "\n" + joinMemoryBank(AC.compression.newMemoryBank)
                            ));
                        } else {
                            notify(
                                "Failed to apply summarizes memories for \"" + AC.compression.vanityTitle + "\" due to a missing or invalid AC card memory header!"
                            );
                        }
                    }
                    resetCompressionProperties();
                } else if (AC.compression.completed === 1) {
                    notify("Summarizing excess memories for \"" + AC.compression.vanityTitle + "\"");
                }
                function joinMemoryBank(memoryBank) {
                    return cleanSpaces("- " + memoryBank.join("\n- "));
                }
            } else if (permitOutput()) {
                CODOMAIN.initialize(output);
            }
            concludeOutputBlock((function() {
                if (AC.signal.swapControlCards) {
                    return getConfigureCardTemplate();
                } else {
                    return null;
                }
            })())
            function postOutputMessage(textClone, ratio) {
                if (!permitOutput()) {
                    // Do nothing
                } else if (0.5 < similarityScore(textClone, output)) {
                    // To improve Auto-Cards' compatability with other scripts, I only bother to replace the output text when the original and new output texts have a similarity score above a particular threshold. Otherwise, I may safely assume the output text has already been replaced by another script and thus skip this step.
                    CODOMAIN.initialize(
                        getPrecedingNewlines() + ">>> please select \"continue\" (" + Math.round(ratio * 100) + "%) <<<\n\n"
                    );
                } else {
                    CODOMAIN.initialize(output);
                }
                return;
            }
            break; }
        default: {
            CODOMAIN.initialize(TEXT);
            break; }
        }
        // Get an individual story card reference via titleKey
        function getAutoCard(titleKey) {
            return Internal.getCard(card => card.entry.toLowerCase().startsWith("{title: " + titleKey + "}"));
        }
        function buildMemoryConstruct() {
            return (AC.compression.oldMemoryBank
                .slice(0, AC.compression.lastConstructIndex + 1)
                .join(" ")
            );
        }
        // Estimate the average AI response char count based on recent continue outputs
        function estimateResponseLength() {
            if (!Array.isArray(history) || (history.length === 0)) {
                return -1;
            }
            const charCounts = [];
            for (let i = 0; i < history.length; i++) {
                const action = readPastAction(i);
                if ((action.type === "continue") && !action.text.includes("<<<")) {
                    charCounts.push(action.text.length);
                }
            }
            if (charCounts.length < 7) {
                if (charCounts.length === 0) {
                    return -1;
                } else if (charCounts.length < 4) {
                    return boundInteger(350, charCounts[0]);
                }
                charCounts.splice(3);
            }
            return boundInteger(175, Math.floor(
                charCounts.reduce((sum, charCount) => {
                    return sum + charCount;
                }, 0) / charCounts.length
            ));
        }
        // Evalute how similar two strings are on the range [0, 1]
        function similarityScore(strA, strB) {
            if (strA === strB) {
                return 1;
            }
            // Normalize both strings for further comparison purposes
            const [cleanA, cleanB] = [strA, strB].map(str => (str
                .replace(/[0-9\s]/g, " ")
                .trim()
                .replace(/  +/g, " ")
                .toLowerCase()
            ));
            if (cleanA === cleanB) {
                return 1;
            }
            // Compute the Levenshtein distance
            const [lengthA, lengthB] = [cleanA, cleanB].map(str => str.length);
            // I love DP ❤️ (dynamic programming)
            const dp = Array(lengthA + 1).fill(null).map(() => Array(lengthB + 1).fill(0));
            for (let i = 0; i <= lengthA; i++) {
                dp[i][0] = i;
            }
            for (let j = 0; j <= lengthB; j++) {
                dp[0][j] = j;
            }
            for (let i = 1; i <= lengthA; i++) {
                for (let j = 1; j <= lengthB; j++) {
                    if (cleanA[i - 1] === cleanB[j - 1]) {
                        // No cost if chars match, swipe right 😎
                        dp[i][j] = dp[i - 1][j - 1];
                    } else {
                        dp[i][j] = Math.min(
                            // Deletion
                            dp[i - 1][j] + 1,
                            // Insertion
                            dp[i][j - 1] + 1,
                            // Substitution
                            dp[i - 1][j - 1] + 1
                        );
                    }
                }
            }
            // Convert distance to similarity score (1 - (distance / maxLength))
            return 1 - (dp[lengthA][lengthB] / Math.max(lengthA, lengthB));
        }
        function splitBySentences(prose) {
            // Don't split sentences on honorifics or abbreviations such as "Mr.", "Mrs.", "etc."
            return (prose
                .replace(new RegExp("(?<=\\s|\"|\\(|—|\\[|'|{|^)(?:" + ([...Words.honorifics, ...Words.abbreviations]
                    .map(word => word.replace(".", ""))
                    .join("|")
                ) + ")\\.", "gi"), "$1%@%")
                .split(/(?<=[\.\?!:]["\)'\]}]?\s+)(?=[^\p{Ll}\s])/u)
                .map(sentence => sentence.replaceAll("%@%", "."))
            );
        }
        function formatEntry(partialEntry) {
            const cleanedEntry = cleanSpaces(partialEntry
                .replace(/^{title:[\s\S]*?}/, "")
                .replace(/[#><@*_~]/g, "")
                .trim()
            ).replace(/(?<=^|\n)-+\s*/g, "");
            if (cleanedEntry === "") {
                return "";
            } else {
                return cleanedEntry + " ";
            }
        }
        // Resolve malformed em dashes (common AI cliche)
        function prettifyEmDashes(str) {
            return str.replace(/(?<!^\s*)(?: - | ?– ?)(?!\s*$)/g, "—");
        }
        function getConfigureCardTemplate() {
            const names = getControlVariants().configure;
            return O.f({
                type: AC.config.defaultCardType,
                title: names.title,
                keys: names.keys,
                entry: getConfigureCardEntry(),
                description: getConfigureCardDescription()
            });
        }
        function getConfigureCardEntry() {
            return prose(
                "> Auto-Cards automatically creates and updates plot-relevant story cards while you play. You may configure the following settings by replacing \"false\" with \"true\" (and vice versa) or by adjusting numbers for the appropriate settings.",
                "> Disable Auto-Cards: false",
                "> Show detailed guide: false",
                "> Delete all automatic story cards: false",
                "> Reset all config settings and prompts: false",
                "> Pin this config card near the top: " + AC.config.pinConfigureCard,
                "> Minimum turns cooldown for new cards: " + AC.config.addCardCooldown,
                "> New cards use a bulleted list format: " + AC.config.bulletedListMode,
                "> Maximum entry length for new cards: " + AC.config.defaultEntryLimit,
                "> New cards perform memory updates: " + AC.config.defaultCardsDoMemoryUpdates,
                "> Card memory bank preferred length: " + AC.config.defaultMemoryLimit,
                "> Memory summary compression ratio: " + AC.config.memoryCompressionRatio,
                "> Exclude all-caps from title detection: " + AC.config.ignoreAllCapsTitles,
                "> Also detect titles from player inputs: " + AC.config.readFromInputs,
                "> Minimum turns age for title detection: " + AC.config.minimumLookBackDistance,
                "> Use Live Script Interface v2: " + (AC.config.LSIv2 !== null),
                "> Log debug data in a separate card: " + AC.config.showDebugData
            );
        }
        function getConfigureCardDescription() {
            return limitString(O.v(prose(
                Words.delimiter,
                "> AI prompt to generate new cards:",
                limitString(AC.config.generationPrompt.trim(), 4350).trimEnd(),
                Words.delimiter,
                "> AI prompt to summarize card memories:",
                limitString(AC.config.compressionPrompt.trim(), 4350).trimEnd(),
                Words.delimiter,
                "> Titles banned from new card creation:",
                AC.database.titles.banned.join(", ")
            )), 9850);
        }
    } else {
        // Auto-Cards is currently disabled
        switch(HOOK) {
        case "input": {
            if (/\/\s*A\s*C/i.test(text)) {
                CODOMAIN.initialize(doPlayerCommands(text));
            } else {
                CODOMAIN.initialize(TEXT);
            }
            break; }
        case "context": {
            // AutoCards was called within the context modifier
            advanceChronometer();
            // Get or construct the "Edit to enable Auto-Cards" story card
            const enableCardTemplate = getEnableCardTemplate();
            const enableCard = getSingletonCard(true, enableCardTemplate);
            banTitle(enableCardTemplate.title);
            pinAndSortCards(enableCard);
            if (AC.signal.forceToggle) {
                enableAutoCards();
            } else if (enableCard.entry !== enableCardTemplate.entry) {
                if ((extractSettings(enableCard.entry)?.enableautocards === true) && (AC.signal.forceToggle !== false)) {
                    // Use optional chaining to check the existence of enableautocards before accessing its value
                    enableAutoCards();
                } else {
                    // Repair the damaged card entry
                    enableCard.entry = enableCardTemplate.entry;
                }
            }
            AC.signal.forceToggle = null;
            CODOMAIN.initialize(TEXT);
            function enableAutoCards() {
                // Auto-Cards has been enabled
                AC.config.doAC = true;
                // Deconstruct the "Edit to enable Auto-Cards" story card
                unbanTitle(enableCardTemplate.title);
                eraseCard(enableCard);
                // Signal the construction of "Configure Auto-Cards" during the next onOutput hook
                AC.signal.swapControlCards = true;
                // Post a success message
                notify("Enabled! You may now edit the \"Configure Auto-Cards\" story card");
                return;
            }
            break; }
        case "output": {
            // AutoCards was called within the output modifier
            promoteAmnesia();
            if (permitOutput()) {
                CODOMAIN.initialize(TEXT);
            }
            concludeOutputBlock((function() {
                if (AC.signal.swapControlCards) {
                    return getEnableCardTemplate();
                } else {
                    return null;
                }
            })());
            break; }
        default: {
            CODOMAIN.initialize(TEXT);
            break; }
        }
        function getEnableCardTemplate() {
            const names = getControlVariants().enable;
            return O.f({
                type: AC.config.defaultCardType,
                title: names.title,
                keys: names.keys,
                entry: prose(
                    "> Auto-Cards automatically creates and updates plot-relevant story cards while you play. To enable this system, simply edit the \"false\" below to say \"true\" instead!",
                    "> Enable Auto-Cards: false"),
                description: "Perform any Do/Say/Story/Continue action within your adventure to apply this change!"
            });
        }
    }
    function hoistConst() { return (class Const {
        // This helps me debug stuff uwu
        #constant;
        constructor(...args) {
            if (args.length !== 0) {
                this.constructor.#throwError([[(args.length === 1), "Const cannot be instantiated with a parameter"], ["Const cannot be instantiated with parameters"]]);
            } else {
                O.f(this);
                return this;
            }
        }
        declare(...args) {
            if (args.length !== 0) {
                this.constructor.#throwError([[(args.length === 1), "Instances of Const cannot be declared with a parameter"], ["Instances of Const cannot be declared with parameters"]]);
            } else if (this.#constant === undefined) {
                this.#constant = null;
                return this;
            } else if (this.#constant === null) {
                this.constructor.#throwError("Instances of Const cannot be redeclared");
            } else {
                this.constructor.#throwError("Instances of Const cannot be redeclared after initialization");
            }
        }
        initialize(...args) {
            if (args.length !== 1) {
                this.constructor.#throwError([[(args.length === 0), "Instances of Const cannot be initialized without a parameter"], ["Instances of Const cannot be initialized with multiple parameters"]]);
            } else if (this.#constant === null) {
                this.#constant = [args[0]];
                return this;
            } else if (this.#constant === undefined) {
                this.constructor.#throwError("Instances of Const cannot be initialized before declaration");
            } else {
                this.constructor.#throwError("Instances of Const cannot be reinitialized");
            }
        }
        read(...args) {
            if (args.length !== 0) {
                this.constructor.#throwError([[(args.length === 1), "Instances of Const cannot be read with a parameter"], ["Instances of Const cannot read with any parameters"]]);
            } else if (Array.isArray(this.#constant)) {
                return this.#constant[0];
            } else if (this.#constant === null) {
                this.constructor.#throwError("Despite prior declaration, instances of Const cannot be read before initialization");
            } else {
                this.constructor.#throwError("Instances of Const cannot be read before initialization");
            }
        }
        // An error condition is paired with an error message [condition, message], call #throwError with an array of pairs to throw the message corresponding with the first true condition [[cndtn1, msg1], [cndtn2, msg2], [cndtn3, msg3], ...] The first conditionless array element always evaluates to true ('else')
        static #throwError(...args) {
            // Look, I thought I was going to use this more at the time okay
            const [conditionalMessagesTable] = args;
            const codomain = new Const().declare();
            const error = O.f(new Error((function() {
                const codomain = new Const().declare();
                if (Array.isArray(conditionalMessagesTable)) {
                    const chosenPair = conditionalMessagesTable.find(function(...args) {
                        const [pair] = args;
                        const codomain = new Const().declare();
                        if (Array.isArray(pair)) {
                            if ((pair.length === 1) && (typeof pair[0] === "string")) {
                                codomain.initialize(true);
                            } else if (
                                (pair.length === 2)
                                && (typeof pair[0] === "boolean")
                                && (typeof pair[1] === "string")
                            ) {
                                codomain.initialize(pair[0]);
                            } else {
                                Const.#throwError("Const.#throwError encountered an invalid array element of conditionalMessagesTable");
                            }
                        } else {
                            Const.#throwError("Const.#throwError encountered a non-array element within conditionalMessagesTable");
                        }
                        return codomain.read();
                    });
                    if (Array.isArray(chosenPair)) {
                        if (chosenPair.length === 1) {
                            codomain.initialize(chosenPair[0]);
                        } else {
                            codomain.initialize(chosenPair[1]);
                        }
                    } else {
                        codomain.initialize("Const.#throwError was not called with any true conditions");
                    }
                } else if (typeof conditionalMessagesTable === "string") {
                    codomain.initialize(conditionalMessagesTable);
                } else {
                    codomain.initialize("Const.#throwError could not parse the given argument");
                }
                return codomain.read();
            })()));
            if (error.stack) {
                codomain.initialize(error.stack
                    .replace(/\(<isolated-vm>:/gi, "(")
                    .replace(/Error:|at\s*(?:#throwError|Const.(?:declare|initialize|read)|new\s*Const)\s*\(\d+:\d+\)/gi, "")
                    .replace(/AutoCards\s*\((\d+):(\d+)\)\s*at\s*<isolated-vm>:\d+:\d+\s*$/i, "AutoCards ($1:$2)")
                    .trim()
                    .replace(/\s+/g, " ")
                );
            } else {
                codomain.initialize(error.message);
            }
            throw codomain.read();
        }
    }); }
    function hoistO() { return (class O {
        // Some Object class methods are annoyingly verbose for how often I use them 👿
        static f(obj) {
            return Object.freeze(obj);
        }
        static v(base) {
            return see(Words.copy) + base;
        }
        static s(obj) {
            return Object.seal(obj);
        }
    }); }
    function hoistWords() { return (class Words { static #cache = {}; static {
        // Each word list is initialized only once before being cached!
        const wordListInitializers = {
            // Special-cased honorifics which are excluded from titles and ignored during split-by-sentences operations
            honorifics: () => [
                "mr.", "ms.", "mrs.", "dr."
            ],
            // Other special-cased abbreviations used to reformat titles and split-by-sentences
            abbreviations: () => [
                "sr.", "jr.", "etc.", "st.", "ex.", "inc."
            ],
            // Lowercase minor connector words which may exist within titles
            minor: () => [
                "&", "the", "for", "of", "le", "la", "el"
            ],
            // Removed from shortened titles for improved memory detection and trigger keword assignments
            peerage: () => [
                "sir", "lord", "lady", "king", "queen", "majesty", "duke", "duchess", "noble", "royal", "emperor", "empress", "great", "prince", "princess", "count", "countess", "baron", "baroness", "archduke", "archduchess", "marquis", "marquess", "viscount", "viscountess", "consort", "grand", "sultan", "sheikh", "tsar", "tsarina", "czar", "czarina", "viceroy", "monarch", "regent", "imperial", "sovereign", "president", "prime", "minister", "nurse", "doctor", "saint", "general", "private", "commander", "captain", "lieutenant", "sergeant", "admiral", "marshal", "baronet", "emir", "chancellor", "archbishop", "bishop", "cardinal", "abbot", "abbess", "shah", "maharaja", "maharani", "councillor", "squire", "lordship", "ladyship", "monseigneur", "mayor", "princeps", "chief", "chef", "their", "my", "his", "him", "he'd", "her", "she", "she'd", "you", "your", "yours", "you'd", "you've", "you'll", "yourself", "mine", "myself", "highness", "excellency", "farmer", "sheriff", "officer", "detective", "investigator", "miss", "mister", "colonel", "professor", "teacher", "agent", "heir", "heiress", "master", "mistress", "headmaster", "headmistress", "principal", "papa", "mama", "mommy", "daddy", "mother", "father", "grandma", "grandpa", "aunt", "auntie", "aunty", "uncle", "cousin", "sister", "brother", "holy", "holiness", "almighty", "senator", "congressman"
            ],
            // Common named entities represent special-cased INVALID card titles. Because these concepts are already abundant within the AI's training data, generating story cards for any of these would be both annoying and superfluous. Therefore, Words.entities is accessed during banned titles initialization to prevent their appearance
            entities: () => [
                // Seasons
                "spring", "summer", "autumn", "fall", "winter",
                // Holidays
                "halloween", "christmas", "thanksgiving", "easter", "hanukkah", "passover", "ramadan", "eid", "diwali", "new year", "new year eve", "valentine day", "oktoberfest",
                // People terms
                "mom", "dad", "child", "grandmother", "grandfather", "ladies", "gentlemen", "gentleman", "slave",
                // Capitalizable pronoun thingys
                "his", "him", "he'd", "her", "she", "she'd", "you", "your", "yours", "you'd", "you've", "you'll", "you're", "yourself", "mine", "myself", "this", "that",
                // Religious figures & deities
                "god", "jesus", "buddha", "allah", "christ",
                // Religious texts & concepts
                "bible", "holy bible", "qur'an", "quran", "hadith", "tafsir", "tanakh", "talmud", "torah", "vedas", "vatican", "paganism", "pagan",
                // Religions & belief systems
                "hindu", "hinduism", "christianity", "islam", "jew", "judaism", "taoism", "buddhist", "buddhism", "catholic", "baptist",
                // Common locations
                "earth", "moon", "sun", "new york city", "london", "paris", "tokyo", "beijing", "mumbai", "sydney", "berlin", "moscow", "los angeles", "san francisco", "chicago", "miami", "seattle", "vancouver", "toronto", "ottawa", "mexico city", "rio de janeiro", "cape town", "sao paulo", "bangkok", "delhi", "amsterdam", "seoul", "shanghai", "new delhi", "atlanta", "jerusalem", "africa", "north america", "south america", "central america", "asia", "north africa", "south africa", "boston", "rome", "america", "siberia", "new england", "manhattan", "bavaria", "catalonia", "greenland", "hong kong", "singapore",
                // Countries & political entities
                "china", "india", "japan", "germany", "france", "spain", "italy", "canada", "australia", "brazil", "south africa", "russia", "north korea", "south korea", "iran", "iraq", "syria", "saudi arabia", "afghanistan", "pakistan", "uk", "britain", "england", "scotland", "wales", "northern ireland", "usa", "united states", "united states of america", "mexico", "turkey", "greece", "portugal", "poland", "netherlands", "belgium", "sweden", "norway", "finland", "denmark",
                // Organizations & unions
                "united nations", "european union", "state", "nato", "nfl", "nba", "fbi", "cia", "harvard", "yale", "princeton", "ivy league", "little league", "nasa", "nsa", "noaa", "osha", "nascar", "daytona 500", "grand prix", "wwe", "mba", "superbowl",
                // Currencies
                "dollar", "euro", "pound", "yen", "rupee", "peso", "franc", "dinar", "bitcoin", "ethereum", "ruble", "won", "dirham",
                // Landmarks
                "sydney opera house", "eiffel tower", "statue of liberty", "big ben", "great wall of china", "taj mahal", "pyramids of giza", "grand canyon", "mount everest",
                // Events
                "world war i", "world war 1", "wwi", "wwii", "world war ii", "world war 2", "wwii", "ww2", "cold war", "brexit", "american revolution", "french revolution", "holocaust", "cuban missile crisis",
                // Companies
                "google", "microsoft", "apple", "amazon", "facebook", "tesla", "ibm", "intel", "samsung", "sony", "coca-cola", "nike", "ford", "chevy", "pontiac", "chrysler", "volkswagen", "lambo", "lamborghini", "ferrari", "pizza hut", "taco bell", "ai dungeon", "openai", "mcdonald", "mcdonalds", "kfc", "burger king", "disney",
                // Nationalities & languages
                "english", "french", "spanish", "german", "italian", "russian", "chinese", "japanese", "korean", "arabic", "portuguese", "hindi", "american", "canadian", "mexican", "brazilian", "indian", "australian", "egyptian", "greek", "swedish", "norwegian", "danish", "dutch", "turkish", "iranian", "ukraine", "asian", "british", "european", "polish", "thai", "vietnamese", "filipino", "malaysian", "indonesian", "finnish", "estonian", "latvian", "lithuanian", "czech", "slovak", "hungarian", "romanian", "bulgarian", "serbian", "croatian", "bosnian", "slovenian", "albanian", "georgian", "armenian", "azerbaijani", "kazakh", "uzbek", "mongolian", "hebrew", "persian", "pashto", "urdu", "bengali", "tamil", "telugu", "marathi", "gujarati", "swahili", "zulu", "xhosa", "african", "north african", "south african", "north american", "south american", "central american", "colombian", "argentinian", "chilean", "peruvian", "venezuelan", "ecuadorian", "bolivian", "paraguayan", "uruguayan", "cuban", "dominican", "arabian", "roman", "haitian", "puerto rican", "moroccan", "algerian", "tunisian", "saudi", "emirati", "qatarian", "bahraini", "omani", "yemeni", "syrian", "lebanese", "iraqi", "afghan", "pakistani", "sri lankan", "burmese", "laotian", "cambodian", "hawaiian", "victorian",
                // Fantasy stuff
                "elf", "elves", "elven", "dwarf", "dwarves", "dwarven", "human", "man", "men", "mankind", "humanity",
                // IPs
                "pokemon", "pokémon", "minecraft", "beetles", "band-aid", "bandaid", "band aid", "big mac", "gpt", "chatgpt", "gpt-2", "gpt-3", "gpt-4", "gpt-4o", "mixtral", "mistral", "linux", "windows", "mac", "happy meal", "disneyland", "disneyworld",
                // US states
                "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "west virginia", "wisconsin", "wyoming",
                // Canadian Provinces & Territories
                "british columbia", "manitoba", "new brunswick", "labrador", "nova scotia", "ontario", "prince edward island", "quebec", "saskatchewan", "northwest territories", "nunavut", "yukon", "newfoundland",
                // Australian States & Territories
                "new south wales", "queensland", "south australia", "tasmania", "western australia", "australian capital territory",
                // idk
                "html", "javascript", "python", "java", "c++", "php", "bluetooth", "json", "sql", "word", "dna", "icbm", "npc", "usb", "rsvp", "omg", "brb", "lol", "rofl", "smh", "ttyl", "rubik", "adam", "t-shirt", "tshirt", "t shirt", "led", "leds", "laser", "lasers", "qna", "q&a", "vip", "human resource", "human resources", "llm", "llc", "ceo", "cfo", "coo", "office", "blt", "suv", "suvs", "ems", "emt", "cbt", "cpr", "ferris wheel", "toy", "pet", "plaything", "m o"
            ],
            // Unwanted values
            undesirables: () => [
                [343332, 451737, 323433, 377817], [436425, 356928, 363825, 444048], [323433, 428868, 310497, 413952], [350097, 66825, 436425, 413952, 406593, 444048], [316932, 330000, 436425, 392073], [444048, 356928, 323433], [451737, 444048, 363825], [330000, 310497, 392073, 399300]
            ],
            delimiter: () => (
                "——————————————————————————"
            ),
            // Source code location
            copy: () => [
                126852, 33792, 211200, 384912, 336633, 310497, 436425, 336633, 33792, 459492, 363825, 436425, 363825, 444048, 33792, 392073, 483153, 33792, 139425, 175857, 33792, 152592, 451737, 399300, 350097, 336633, 406593, 399300, 33792, 413952, 428868, 406593, 343332, 363825, 384912, 336633, 33792, 135168, 190608, 336633, 467313, 330000, 190608, 336633, 310497, 356928, 33792, 310497, 399300, 330000, 33792, 428868, 336633, 310497, 330000, 33792, 392073, 483153, 33792, 316932, 363825, 406593, 33792, 343332, 406593, 428868, 33792, 436425, 363825, 392073, 413952, 384912, 336633, 33792, 363825, 399300, 436425, 444048, 428868, 451737, 323433, 444048, 363825, 406593, 399300, 436425, 33792, 406593, 399300, 33792, 310497, 330000, 330000, 363825, 399300, 350097, 33792, 139425, 451737, 444048, 406593, 66825, 148137, 310497, 428868, 330000, 436425, 33792, 444048, 406593, 33792, 483153, 406593, 451737, 428868, 33792, 436425, 323433, 336633, 399300, 310497, 428868, 363825, 406593, 436425, 35937, 33792, 3355672848, 139592360193, 3300, 3300, 356928, 444048, 444048, 413952, 436425, 111012, 72897, 72897, 413952, 384912, 310497, 483153, 69828, 310497, 363825, 330000, 451737, 399300, 350097, 336633, 406593, 399300, 69828, 323433, 406593, 392073, 72897, 413952, 428868, 406593, 343332, 363825, 384912, 336633, 72897, 190608, 336633, 467313, 330000, 190608, 336633, 310497, 356928, 3300, 3300, 126852, 33792, 139425, 451737, 444048, 406593, 66825, 148137, 310497, 428868, 330000, 436425, 33792, 459492, 79233, 69828, 76032, 69828, 76032, 33792, 363825, 436425, 33792, 310497, 399300, 33792, 406593, 413952, 336633, 399300, 66825, 436425, 406593, 451737, 428868, 323433, 336633, 33792, 436425, 323433, 428868, 363825, 413952, 444048, 33792, 343332, 406593, 428868, 33792, 139425, 175857, 33792, 152592, 451737, 399300, 350097, 336633, 406593, 399300, 33792, 392073, 310497, 330000, 336633, 33792, 316932, 483153, 33792, 190608, 336633, 467313, 330000, 190608, 336633, 310497, 356928, 69828, 33792, 261393, 406593, 451737, 33792, 356928, 310497, 459492, 336633, 33792, 392073, 483153, 33792, 343332, 451737, 384912, 384912, 33792, 413952, 336633, 428868, 392073, 363825, 436425, 436425, 363825, 406593, 399300, 33792, 444048, 406593, 33792, 451737, 436425, 336633, 33792, 139425, 451737, 444048, 406593, 66825, 148137, 310497, 428868, 330000, 436425, 33792, 467313, 363825, 444048, 356928, 363825, 399300, 33792, 483153, 406593, 451737, 428868, 33792, 413952, 336633, 428868, 436425, 406593, 399300, 310497, 384912, 33792, 406593, 428868, 33792, 413952, 451737, 316932, 384912, 363825, 436425, 356928, 336633, 330000, 33792, 436425, 323433, 336633, 399300, 310497, 428868, 363825, 406593, 436425, 35937, 3300, 126852, 33792, 261393, 406593, 451737, 50193, 428868, 336633, 33792, 310497, 384912, 436425, 406593, 33792, 467313, 336633, 384912, 323433, 406593, 392073, 336633, 33792, 444048, 406593, 33792, 336633, 330000, 363825, 444048, 33792, 444048, 356928, 336633, 33792, 139425, 175857, 33792, 413952, 428868, 406593, 392073, 413952, 444048, 436425, 33792, 310497, 399300, 330000, 33792, 444048, 363825, 444048, 384912, 336633, 33792, 336633, 475200, 323433, 384912, 451737, 436425, 363825, 406593, 399300, 436425, 33792, 413952, 428868, 406593, 459492, 363825, 330000, 336633, 330000, 33792, 316932, 336633, 384912, 406593, 467313, 69828, 33792, 175857, 33792, 436425, 363825, 399300, 323433, 336633, 428868, 336633, 384912, 483153, 33792, 356928, 406593, 413952, 336633, 33792, 483153, 406593, 451737, 33792, 336633, 399300, 370788, 406593, 483153, 33792, 483153, 406593, 451737, 428868, 33792, 310497, 330000, 459492, 336633, 399300, 444048, 451737, 428868, 336633, 436425, 35937, 33792, 101128769412, 106046468352, 3300
            ],
            // Card interface names reserved for use within LSIv2
            reserved: () => ({
                library: "Shared Library", input: "Input Modifier", context: "Context Modifier", output: "Output Modifier", guide: "LSIv2 Guide", state: "State Display", log: "Console Log"
            }),
            // Acceptable config settings which are coerced to true
            trues: () => [
                "true", "t", "yes", "y", "on"
            ],
            // Acceptable config settings which are coerced to false
            falses: () => [
                "false", "f", "no", "n", "off"
            ],
            guide: () => prose(
                ">>> Detailed Guide:",
                "Auto-Cards was made by LewdLeah ❤️",
                "",
                Words.delimiter,
                "",
                "💡 What is Auto-Cards?",
                "Auto-Cards is a plug-and-play script for AI Dungeon that watches your story and automatically writes plot-relevant story cards during normal gameplay. A forgetful AI breaks my immersion, therefore my primary goal was to address the \"object permanence problem\" by extending story cards and memories with deeper automation. Auto-Cards builds a living reference of your adventure's world as you go. For your own convenience, all of this stuff is handled in the background. Though you're certainly welcome to customize various settings or use in-game commands for more precise control",
                "",
                Words.delimiter,
                "",
                " 📌 Main Features",
                "- Detects named entities from your story and periodically writes new cards",
                "- Smart long-term memory updates and summaries for important cards",
                "- Fully customizable AI card generation and memory summarization prompts",
                "- Optional in-game commands to manually direct the card generation process",
                "- Free and open source for anyone to use within their own projects",
                "- Compatible with other scripts and includes an external API",
                "- Optional in-game scripting interface (LSIv2)",
                "",
                Words.delimiter,
                "",
                "⚙️ Config Settings",
                "You may, at any time, fine-tune your settings in-game by editing their values within the config card's entry section. Simply swap true/false or tweak numbers where appropriate",
                "",
                "> Disable Auto-Cards:",
                "Turns the whole system off if true",
                "",
                "> Show detailed guide:",
                "If true, shows this player guide in-game",
                "",
                "> Delete all automatic story cards:",
                "Removes every auto-card present in your adventure",
                "",
                "> Reset all config settings and prompts:",
                "Restores all settings and prompts to their original default values",
                "",
                "> Pin this config card near the top:",
                "Keeps the config card pinned high on your cards list",
                "",
                "> Minimum turns cooldown for new cards:",
                "How many turns (minimum) to wait between generating new cards. Using 9999 will pause periodic card generation while still allowing card memory updates to continue",
                "",
                "> New cards use a bulleted list format:",
                "If true, new entries will use bullet points instead of pure prose",
                "",
                "> Maximum entry length for new cards:",
                "Caps how long newly generated card entries can be (in characters)",
                "",
                "> New cards perform memory updates:",
                "If true, new cards will automatically experience memory updates over time",
                "",
                "> Card memory bank preferred length:",
                "Character count threshold before card memories are summarized to save space",
                "",
                "> Memory summary compression ratio:",
                "Controls how much to compress when summarizing long card memory banks",
                "(ratio = 10 * old / new ... such that 25 -> 2.5x shorter)",
                "",
                "> Exclude all-caps from title detection:",
                "Prevents all-caps words like \"RUN\" from being parsed as viable titles",
                "",
                "> Also detect titles from player inputs:",
                "Allows your typed Do/Say/Story action inputs to help suggest new card topics. Set to false if you have bad grammar, or if you're German (due to idiosyncratic noun capitalization habits)",
                "",
                "> Minimum turns age for title detection:",
                "How many actions back the script looks when parsing recent titles from your story",
                "",
                "> Use Live Script Interface v2:",
                "Enables LSIv2 for extra scripting magic and advanced control via arbitrary code execution",
                "",
                "> Log debug data in a separate card:",
                "Shows a debug card if set to true",
                "",
                Words.delimiter,
                "",
                "✏️ AI Prompts",
                "You may specify how the AI handles story card processes by editing either of these two prompts within the config card's notes section",
                "",
                "> AI prompt to generate new cards:",
                "Used when Auto-Cards writes a new card entry. It tells the AI to focus on important plot stuff, avoid fluff, and write in a consistent, polished style. I like to add some personal preferences here when playing my own adventures. \"%{title}\" and \"%{entry}\" are dynamic placeholders for their namesakes",
                "",
                "> AI prompt to summarize card memories:",
                "Summarizes older details within card memory banks to keep everything concise and neat over the long-run. Maintains only the most important details, written in the past tense. \"%{title}\" and \"%{memory}\" are dynamic placeholders for their namesakes",
                "",
                Words.delimiter,
                "",
                "⛔ Banned Titles List",
                "This list prevents new cards from being created for super generic or unhelpful titles such as North, Tuesday, or December. You may edit these at the bottom of the config card's notes section. Capitalization and plural/singular forms are handled for you, so no worries about that",
                "",
                "> Titles banned from automatic new card generation:",
                "North, East, South, West, and so on...",
                "",
                Words.delimiter,
                "",
                "🔑 In-Game Commands (/ac)",
                "Use these commands to manually interact with Auto-Cards, simply type them into a Do/Say/Story input action",
                "",
                "/ac",
                "Sets your actual cooldown to 0 and immediately attempts to generate a new card for the most relevant unused title from your story (if one exists)",
                "",
                "/ac Your Title Goes Here",
                "Will immediately begin generating a new story card with the given title",
                "Example use: \"/ac Leah\"",
                "",
                "/ac Your Title Goes Here / Your extra prompt details go here",
                "Similar to the previous case, but with additional context to include with the card generation prompt",
                "Example use: \"/ac Leah / Focus on Leah's works of artifice and ingenuity\"",
                "",
                "/ac Your Title Goes Here / Your extra prompt details go here / Your starter entry goes here",
                "Again, similar to the previous case, but with an initial card entry for the generator to build upon",
                "Example use: \"/ac Leah / Focus on Leah's works of artifice and ingenuity / You are a woman named Leah.\"",
                "",
                "/ac redo Your Title Goes Here",
                "Rewrites your chosen story card, using the old card entry, memory bank, and story context for inspiration. Useful for recreating cards after important character development has occurred",
                "Example use: \"/ac redo Leah\"",
                "",
                "/ac redo Your Title Goes Here / New info goes here",
                "Similar to the previous case, but with additional info provided to guide the rewrite according to your additional specifications",
                "Example use: \"/ac redo Leah / Leah recently achieved immortality\"",
                "",
                "/ac redo all",
                "Recreates every single auto-card in your adventure. I must warn you though: This is very risky",
                "",
                "Extra Info:",
                "- Invalid titles will fail. It's a technical limitation, sorry 🤷‍♀️",
                "- Titles must be unique, unless you're attempting to use \"/ac redo\" for an existing card",
                "- You may submit multiple commands using a single input to queue up a chained sequence of requests",
                "- Capitalization doesn't matter, titles will be reformatted regardless",
                "",
                Words.delimiter,
                "",
                "🔧 External API Functions (quick summary)",
                "These are mainly for other JavaScript programmers to use, so feel free to ignore this section if that doesn't apply to you. Anyway, here's what each one does in plain terms, though please do refer to my source code for the full documentation",
                "",
                "AutoCards().API.postponeEvents();",
                "Pauses Auto-Cards activity for n many turns",
                "",
                "AutoCards().API.emergencyHalt();",
                "Emergency stop or resume",
                "",
                "AutoCards().API.suppressMessages();",
                "Hides Auto-Cards toasts by preventing assignment to state.message",
                "",
                "AutoCards().API.debugLog();",
                "Writes to the debug log card",
                "",
                "AutoCards().API.toggle();",
                "Turns Auto-Cards on/off",
                "",
                "AutoCards().API.generateCard();",
                "Initiates AI generation of the requested card",
                "",
                "AutoCards().API.redoCard();",
                "Regenerates an existing card",
                "",
                "AutoCards().API.setCardAsAuto();",
                "Flags or unflags a card as automatic",
                "",
                "AutoCards().API.addCardMemory();",
                "Adds a memory to a specific card",
                "",
                "AutoCards().API.eraseAllAutoCards();",
                "Deletes all auto-cards",
                "",
                "AutoCards().API.getUsedTitles();",
                "Lists all current card titles and keys",
                "",
                "AutoCards().API.getBannedTitles();",
                "Shows your current banned titles list",
                "",
                "AutoCards().API.setBannedTitles();",
                "Replaces the banned titles list with a new list",
                "",
                "AutoCards().API.buildCard();",
                "Makes a new card from scratch, using exact parameters",
                "",
                "AutoCards().API.getCard();",
                "Finds cards that match a filter",
                "",
                "AutoCards().API.eraseCard();",
                "Deletes cards matching a filter",
                "",
                "These API functions also work from within the LSIv2 scope, by the way",
                "",
                Words.delimiter,
                "",
                "❤️ Special Thanks",
                "This project flourished due to the incredible help, feedback, and encouragement from the AI Dungeon community. Your ideas, bug reports, testing, and support made Auto-Cards smarter, faster, and more fun for all. Please refer to my source code to learn more about everyone's specific contributions",
                "",
                "AHotHamster22, BinKompliziert, Boo, bottledfox, Bruno, Burnout, bweni, DebaczX, Dirty Kurtis, Dragranis, effortlyss, Hawk, Idle Confusion, ImprezA, Kat-Oli, KryptykAngel, Mad19pumpkin, Magic, Mirox80, Nathaniel Wyvern, NobodyIsUgly, OnyxFlame, Purplejump, Randy Viosca, RustyPawz, sinner, Sleepy pink, Vutinberg, Wilmar, Yi1i1i",
                "",
                Words.delimiter,
                "",
                "🎴 Random Tips",
                "- The default setup works great out of the box, just play normally and watch your world build itself",
                "- Enable AI Dungeon's built-in memory system for the best results",
                "- Gameplay -> AI Models -> Memory System -> Memory Bank -> Toggle-ON to enable",
                "- \"t\" and \"f\" are valid shorthand for \"true\" and \"false\" inside the config card",
                "- If Auto-Cards goes overboard with new cards, you can pause it by setting the cooldown config to 9999",
                "- Write \"{title:}\" anywhere within a regular story card's entry to transform it into an automatic card",
                "- Feel free to import/export entire story card decks at any time",
                "- Please copy my source code from here: https://play.aidungeon.com/profile/LewdLeah",
                "",
                Words.delimiter,
                "",
                "Happy adventuring! ❤️",
                "Please erase before continuing! <<<"
            )
        };
        for (const wordList in wordListInitializers) {
            // Define a lazy getter for every word list
            Object.defineProperty(Words, wordList, {
                configurable: false,
                enumerable: true,
                get() {
                    // If not already in cache, initialize and store the word list
                    if (!(wordList in Words.#cache)) {
                        Words.#cache[wordList] = O.f(wordListInitializers[wordList]());
                    }
                    return Words.#cache[wordList];
                }
            });
        }
    } }); }
    function hoistStringsHashed() { return (class StringsHashed {
        // Used for information-dense past memory recognition
        // Strings are converted to (reasonably) unique hashcodes for efficient existence checking
        static #defaultSize = 65536;
        #size;
        #store;
        constructor(size = StringsHashed.#defaultSize) {
            this.#size = size;
            this.#store = new Set();
            return this;
        }
        static deserialize(serialized, size = StringsHashed.#defaultSize) {
            const stringsHashed = new StringsHashed(size);
            stringsHashed.#store = new Set(serialized.split(","));
            return stringsHashed;
        }
        serialize() {
            return Array.from(this.#store).join(",");
        }
        has(str) {
            return this.#store.has(this.#hash(str));
        }
        add(str) {
            this.#store.add(this.#hash(str));
            return this;
        }
        remove(str) {
            this.#store.delete(this.#hash(str));
            return this;
        }
        size() {
            return this.#store.size;
        }
        latest(keepLatestCardinality) {
            if (this.#store.size <= keepLatestCardinality) {
                return this;
            }
            const excess = this.#store.size - keepLatestCardinality;
            const iterator = this.#store.values();
            for (let i = 0; i < excess; i++) {
                // The oldest hashcodes are removed first (insertion order matters!)
                this.#store.delete(iterator.next().value);
            }
            return this;
        }
        #hash(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = ((31 * hash) + str.charCodeAt(i)) % this.#size;
            }
            return hash.toString(36);
        }
    }); }
    function hoistInternal() { return (class Internal {
        // Some exported API functions are internally reused by AutoCards
        // Recursively calling AutoCards().API is computationally wasteful
        // AutoCards uses this collection of static methods as an internal proxy
        static generateCard(request, predefinedPair = ["", ""]) {
            // Method call guide:
            // Internal.generateCard({
            //     // All properties except 'title' are optional
            //     type: "card type, defaults to 'class' for ease of filtering",
            //     title: "card title",
            //     keysStart: "preexisting card triggers",
            //     entryStart: "preexisting card entry",
            //     entryPrompt: "prompt the AI will use to complete this entry",
            //     entryPromptDetails: "extra details to include with this card's prompt",
            //     entryLimit: 750, // target character count for the generated entry
            //     description: "card notes",
            //     memoryStart: "preexisting card memory",
            //     memoryUpdates: true, // card updates when new relevant memories are formed
            //     memoryLimit: 2750, // max characters before the card memory is compressed
            // });
            const titleKeyPair = formatTitle((request.title ?? "").toString());
            const title = predefinedPair[0] || titleKeyPair.newTitle;
            if (
                (title === "")
                || (("title" in AC.generation.workpiece) && (title === AC.generation.workpiece.title))
                || (isAwaitingGeneration() && (AC.generation.pending.some(pendingWorkpiece => (
                    ("title" in pendingWorkpiece) && (title === pendingWorkpiece.title)
                ))))
            ) {
                logEvent("The title '" + request.title + "' is invalid or unavailable for card generation", true);
                return false;
            }
            AC.generation.pending.push(O.s({
                title: title,
                type: limitString((request.type || AC.config.defaultCardType).toString().trim(), 100),
                keys: predefinedPair[1] || buildKeys((request.keysStart ?? "").toString(), titleKeyPair.newKey),
                entry: limitString("{title: " + title + "}" + cleanSpaces((function() {
                    const entry = (request.entryStart ?? "").toString().trim();
                    if (entry === "") {
                        return "";
                    } else {
                        return ("\n" + entry + (function() {
                            if (/[a-zA-Z]$/.test(entry)) {
                                return ".";
                            } else {
                                return "";
                            }
                        })() + " ");
                    }
                })()), 2000),
                description: limitString((
                    (function() {
                        const description = limitString((request.description ?? "").toString().trim(), 9900);
                        if (description === "") {
                            return "";
                        } else {
                            return description + "\n\n";
                        }
                    })() + "Auto-Cards will contextualize these memories:\n{updates: " + (function() {
                        if (typeof request.memoryUpdates === "boolean") {
                            return request.memoryUpdates;
                        } else {
                            return AC.config.defaultCardsDoMemoryUpdates;
                        }
                    })() + ", limit: " + validateMemoryLimit(
                        parseInt((request.memoryLimit || AC.config.defaultMemoryLimit), 10)
                    ) + "}" + (function() {
                        const cardMemoryBank = cleanSpaces((request.memoryStart ?? "").toString().trim());
                        if (cardMemoryBank === "") {
                            return "";
                        } else {
                            return "\n" + cardMemoryBank.split("\n").map(memory => addBullet(memory)).join("\n");
                        }
                    })()
                ), 10000),
                prompt: (function() {
                    let prompt = insertTitle((
                        (request.entryPrompt ?? "").toString().trim() || AC.config.generationPrompt.trim()
                    ), title);
                    let promptDetails = insertTitle((
                        cleanSpaces((request.entryPromptDetails ?? "").toString().trim())
                    ), title);
                    if (promptDetails !== "") {
                        const spacesPrecedingTerminalEntryPlaceholder = (function() {
                            const terminalEntryPlaceholderPattern = /(?:[%\$]+\s*|[%\$]*){+\s*entry\s*}+$/i;
                            if (terminalEntryPlaceholderPattern.test(prompt)) {
                                prompt = prompt.replace(terminalEntryPlaceholderPattern, "");
                                const trailingSpaces = prompt.match(/(\s+)$/);
                                if (trailingSpaces) {
                                    prompt = prompt.trimEnd();
                                    return trailingSpaces[1];
                                } else {
                                    return "\n\n";
                                }
                            } else {
                                return "";
                            }
                        })();
                        switch(prompt[prompt.length - 1]) {
                        case "]": { encapsulateBothPrompts("[", true, "]"); break; }
                        case ">": { encapsulateBothPrompts(null, false, ">"); break; }
                        case "}": { encapsulateBothPrompts("{", true, "}"); break; }
                        case ")": { encapsulateBothPrompts("(", true, ")"); break; }
                        case "/": { encapsulateBothPrompts("/", true, "/"); break; }
                        case "#": { encapsulateBothPrompts("#", true, "#"); break; }
                        case "-": { encapsulateBothPrompts(null, false, "-"); break; }
                        case ":": { encapsulateBothPrompts(":", true, ":"); break; }
                        case "<": { encapsulateBothPrompts(">", true, "<"); break; }
                        };
                        if (promptDetails.includes("\n")) {
                            const lines = promptDetails.split("\n");
                            for (let i = 0; i < lines.length; i++) {
                                lines[i] = addBullet(lines[i].trim());
                            }
                            promptDetails = lines.join("\n");
                        } else {
                            promptDetails = addBullet(promptDetails);
                        }
                        prompt += "\n" + promptDetails + (function() {
                            if (spacesPrecedingTerminalEntryPlaceholder !== "") {
                                // Prompt previously contained a terminal %{entry} placeholder, re-append it
                                return spacesPrecedingTerminalEntryPlaceholder + "%{entry}";
                            }
                            return "";
                        })();
                        function encapsulateBothPrompts(leftSymbol, slicesAtMiddle, rightSymbol) {
                            if (slicesAtMiddle) {
                                prompt = prompt.slice(0, -1).trim();
                                if (promptDetails.startsWith(leftSymbol)) {
                                    promptDetails = promptDetails.slice(1).trim();
                                }
                            }
                            if (!promptDetails.endsWith(rightSymbol)) {
                                promptDetails += rightSymbol;
                            }
                            return;
                        }
                    }
                    return limitString(prompt, Math.floor(0.8 * AC.signal.maxChars));
                })(),
                limit: validateEntryLimit(parseInt((request.entryLimit || AC.config.defaultEntryLimit), 10))
            }));
            notify("Generating card for \"" + title + "\"");
            function addBullet(str) {
                return "- " + str.replace(/^-+\s*/, "");
            }
            return true;
        }
        static redoCard(request, useOldInfo, newInfo) {
            const card = getIntendedCard(request.title)[0];
            const oldCard = O.f({...card});
            if (!eraseCard(card)) {
                return false;
            } else if (newInfo !== "") {
                request.entryPromptDetails = (request.entryPromptDetails ?? "").toString() + "\n" + newInfo;
            }
            O.f(request);
            Internal.getUsedTitles(true);
            if (!Internal.generateCard(request) && !Internal.generateCard(request, [
                (oldCard.entry.match(/^{title: ([\s\S]*?)}/)?.[1] || request.title.replace(/\w\S*/g, word => (
                    word[0].toUpperCase() + word.slice(1).toLowerCase()
                ))), oldCard.keys
            ])) {
                constructCard(oldCard, newCardIndex());
                Internal.getUsedTitles(true);
                return false;
            } else if (!useOldInfo) {
                return true;
            }
            AC.generation.pending[AC.generation.pending.length - 1].prompt = ((
                removeAutoProps(oldCard.entry) + "\n\n" +
                removeAutoProps(isolateNotesAndMemories(oldCard.description)[1])
            ).trimEnd() + "\n\n" + AC.generation.pending[AC.generation.pending.length - 1].prompt).trim();
            return true;
        }
        // Sometimes it's helpful to log information elsewhere during development
        // This log card is separate and distinct from the LSIv2 console log
        static debugLog(...args) {
            const debugCardName = "Debug Log";
            banTitle(debugCardName);
            const card = getSingletonCard(true, O.f({
                type: AC.config.defaultCardType,
                title: debugCardName,
                keys: debugCardName,
                entry: "The debug console log will print to the notes section below.",
                description: Words.delimiter + "\nBEGIN DEBUG LOG"
            }));
            logToCard(card, ...args);
            return card;
        }
        static eraseAllAutoCards() {
            const cards = [];
            Internal.getUsedTitles(true);
            for (const card of storyCards) {
                if (card.entry.startsWith("{title: ")) {
                    cards.push(card);
                }
            }
            for (const card of cards) {
                eraseCard(card);
            }
            auto.clear();
            forgetStuff();
            clearTransientTitles();
            AC.generation.pending = [];
            AC.database.memories.associations = {};
            if (AC.config.deleteAllAutoCards) {
                AC.config.deleteAllAutoCards = null;
            }
            return cards.length;
        }
        static getUsedTitles(isExternal = false) {
            if (isExternal) {
                bans.clear();
                isBanned("", true);
            } else if (0 < AC.database.titles.used.length) {
                return AC.database.titles.used;
            }
            // All unique used titles and keys encountered during this iteration
            const seen = new Set();
            auto.clear();
            clearTransientTitles();
            AC.database.titles.used = ["%@%"];
            for (const card of storyCards) {
                // Perform some common-sense maintenance while we're here
                card.type = card.type.trim();
                card.title = card.title.trim();
                // card.keys should be left as-is
                card.entry = card.entry.trim();
                card.description = card.description.trim();
                if (isExternal) {
                    O.s(card);
                } else if (!shouldProceed()) {
                    checkRemaining();
                    continue;
                }
                // An ideal auto-card's entry starts with "{title: Example of Greatness}" (example)
                // An ideal auto-card's description contains "{updates: true, limit: 2750}" (example)
                if (checkPlurals(denumberName(card.title.replace("\n", "")), t => isBanned(t))) {
                    checkRemaining();
                    continue;
                } else if (!card.keys.includes(",")) {
                    const cleanKeys = denumberName(card.keys.trim());
                    if ((2 < cleanKeys.length) && checkPlurals(cleanKeys, t => isBanned(t))) {
                        checkRemaining();
                        continue;
                    }
                }
                // Detect and repair malformed auto-card properties in a fault-tolerant manner
                const traits = [card.entry, card.description].map((str, i) => {
                    // Absolute abomination uwu
                    const hasUpdates = /updates?\s*:[\s\S]*?(?:(?:title|limit)s?\s*:|})/i.test(str);
                    const hasLimit = /limits?\s*:[\s\S]*?(?:(?:title|update)s?\s*:|})/i.test(str);
                    return [(function() {
                        if (hasUpdates || hasLimit) {
                            if (/titles?\s*:[\s\S]*?(?:(?:limit|update)s?\s*:|})/i.test(str)) {
                                return 2;
                            }
                            return false;
                        } else if (/titles?\s*:[\s\S]*?}/i.test(str)) {
                            return 1;
                        } else if (!(
                            (i === 0)
                            && /{[\s\S]*?}/.test(str)
                            && (str.match(/{/g)?.length === 1)
                            && (str.match(/}/g)?.length === 1)
                        )) {
                            return false;
                        }
                        const badTitleHeaderMatch = str.match(/{([\s\S]*?)}/);
                        if (!badTitleHeaderMatch) {
                            return false;
                        }
                        const inferredTitle = badTitleHeaderMatch[1].split(",")[0].trim();
                        if (
                            (2 < inferredTitle.length)
                            && (inferredTitle.length <= 100)
                            && (badTitleHeaderMatch[0].length < str.length)
                        ) {
                            // A rare case where the title's existence should be inferred from the enclosing {curly brackets}
                            return inferredTitle;
                        }
                        return false;
                    })(), hasUpdates, hasLimit];
                }).flat();
                if (traits.every(trait => !trait)) {
                    // This card contains no auto-card traits, not even malformed ones
                    checkRemaining();
                    continue;
                }
                const [
                    hasEntryTitle,
                    hasEntryUpdates,
                    hasEntryLimit,
                    hasDescTitle,
                    hasDescUpdates,
                    hasDescLimit
                ] = traits;
                // Handle all story cards which belong to the Auto-Cards ecosystem
                // May flag this damaged auto-card for later repairs
                // May flag this duplicate auto-card for deformatting (will become a regular story card)
                let repair = false;
                let release = false;
                const title = (function() {
                    let title = "";
                    if (typeof hasEntryTitle === "string") {
                        repair = true;
                        title = formatTitle(hasEntryTitle).newTitle;
                        if (hasDescTitle && bad()) {
                            title = parseTitle(false);
                        }
                    } else if (hasEntryTitle) {
                        title = parseTitle(true);
                        if (hasDescTitle) {
                            repair = true;
                            if (bad()) {
                                title = parseTitle(false);
                            }
                        } else if (1 < card.entry.match(/titles?\s*:/gi)?.length) {
                            repair = true;
                        }
                    } else if (hasDescTitle) {
                        repair = true;
                        title = parseTitle(false);
                    }
                    if (bad()) {
                        repair = true;
                        title = formatTitle(card.title).newTitle;
                        if (bad()) {
                            release = true;
                        } else {
                            seen.add(title);
                            auto.add(title.toLowerCase());
                        }
                    } else {
                        seen.add(title);
                        auto.add(title.toLowerCase());
                        const titleHeader = "{title: " + title + "}";
                        if (!repair && !((card.entry === titleHeader) || card.entry.startsWith(titleHeader + "\n"))) {
                            repair = true;
                        }
                    }
                    function bad() {
                        return ((title === "") || checkPlurals(title, t => auto.has(t)));
                    }
                    function parseTitle(fromEntry) {
                        const [sourceType, sourceText] = (function() {
                            if (fromEntry) {
                                return [hasEntryTitle, card.entry];
                            } else {
                                return [hasDescTitle, card.description];
                            }
                        })()
                        switch(sourceType) {
                        case 1: {
                            return formatTitle(isolateProperty(
                                sourceText,
                                /titles?\s*:[\s\S]*?}/i,
                                /(?:titles?\s*:|})/gi
                            )).newTitle; }
                        case 2: {
                            return formatTitle(isolateProperty(
                                sourceText,
                                /titles?\s*:[\s\S]*?(?:(?:limit|update)s?\s*:|})/i,
                                /(?:(?:title|update|limit)s?\s*:|})/gi
                            )).newTitle; }
                        default: {
                            return ""; }
                        }
                    }
                    return title;
                })();
                if (release) {
                    // Remove Auto-Cards properties from this incompatible story card
                    safeRemoveProps();
                    card.description = (card.description
                        .replace(/\s*Auto(?:-|\s*)Cards\s*will\s*contextualize\s*these\s*memories\s*:\s*/gi, "")
                        .replaceAll("%@%", "\n\n")
                        .trim()
                    );
                    seen.delete(title);
                    checkRemaining();
                    continue;
                }
                const memoryProperties = "{updates: " + (function() {
                    let updates = null;
                    if (hasDescUpdates) {
                        updates = parseUpdates(false);
                        if (hasEntryUpdates) {
                            repair = true;
                            if (bad()) {
                                updates = parseUpdates(true);
                            }
                        } else if (1 < card.description.match(/updates?\s*:/gi)?.length) {
                            repair = true;
                        }
                    } else if (hasEntryUpdates) {
                        repair = true;
                        updates = parseUpdates(true);
                    }
                    if (bad()) {
                        repair = true;
                        updates = AC.config.defaultCardsDoMemoryUpdates;
                    }
                    function bad() {
                        return (updates === null);
                    }
                    function parseUpdates(fromEntry) {
                        const updatesText = (isolateProperty(
                            (function() {
                                if (fromEntry) {
                                    return card.entry;
                                } else {
                                    return card.description;
                                }
                            })(),
                            /updates?\s*:[\s\S]*?(?:(?:title|limit)s?\s*:|})/i,
                            /(?:(?:title|update|limit)s?\s*:|})/gi
                        ).toLowerCase().replace(/[^a-z]/g, ""));
                        if (Words.trues.includes(updatesText)) {
                            return true;
                        } else if (Words.falses.includes(updatesText)) {
                            return false;
                        } else {
                            return null;
                        }
                    }
                    return updates;
                })() + ", limit: " + (function() {
                    let limit = -1;
                    if (hasDescLimit) {
                        limit = parseLimit(false);
                        if (hasEntryLimit) {
                            repair = true;
                            if (bad()) {
                                limit = parseLimit(true);
                            }
                        } else if (1 < card.description.match(/limits?\s*:/gi)?.length) {
                            repair = true;
                        }
                    } else if (hasEntryLimit) {
                        repair = true;
                        limit = parseLimit(true);
                    }
                    if (bad()) {
                        repair = true;
                        limit = AC.config.defaultMemoryLimit;
                    } else {
                        limit = validateMemoryLimit(limit);
                    }
                    function bad() {
                        return (limit === -1);
                    }
                    function parseLimit(fromEntry) {
                        const limitText = (isolateProperty(
                            (function() {
                                if (fromEntry) {
                                    return card.entry;
                                } else {
                                    return card.description;
                                }
                            })(),
                            /limits?\s*:[\s\S]*?(?:(?:title|update)s?\s*:|})/i,
                            /(?:(?:title|update|limit)s?\s*:|})/gi
                        ).replace(/[^0-9]/g, ""));
                        if ((limitText === "")) {
                            return -1;
                        } else {
                            return parseInt(limitText, 10);
                        }
                    }
                    return limit.toString();
                })() + "}";
                if (!repair && (new RegExp("(?:^|\\n)" + memoryProperties + "(?:\\n|$)")).test(card.description)) {
                    // There are no serious repairs to perform
                    card.entry = cleanSpaces(card.entry);
                    const [notes, memories] = isolateNotesAndMemories(card.description);
                    const pureMemories = cleanSpaces(memories.replace(memoryProperties, "").trim());
                    rejoinDescription(notes, memoryProperties, pureMemories);
                    checkRemaining();
                    continue;
                }
                // Damage was detected, perform an adaptive repair on this auto-card's configurable properties
                card.description = card.description.replaceAll("%@%", "\n\n");
                safeRemoveProps();
                card.entry = limitString(("{title: " + title + "}\n" + card.entry).trimEnd(), 2000);
                const [left, right] = card.description.split("%@%");
                rejoinDescription(left, memoryProperties, right);
                checkRemaining();
                function safeRemoveProps() {
                    if (typeof hasEntryTitle === "string") {
                        card.entry = card.entry.replace(/{[\s\S]*?}/g, "");
                    }
                    card.entry = removeAutoProps(card.entry);
                    const [notes, memories] = isolateNotesAndMemories(card.description);
                    card.description = notes + "%@%" + removeAutoProps(memories);
                    return;
                }
                function rejoinDescription(notes, memoryProperties, memories) {
                    card.description = limitString((notes + (function() {
                        if (notes === "") {
                            return "";
                        } else if (notes.endsWith("Auto-Cards will contextualize these memories:")) {
                            return "\n";
                        } else {
                            return "\n\n";
                        }
                    })() + memoryProperties + (function() {
                        if (memories === "") {
                            return "";
                        } else {
                            return "\n";
                        }
                    })() + memories), 10000);
                    return;
                }
                function isolateProperty(sourceText, propMatcher, propCleaner) {
                    return ((sourceText.match(propMatcher)?.[0] || "")
                        .replace(propCleaner, "")
                        .split(",")[0]
                        .trim()
                    );
                }
                // Observe literal card titles and keys
                function checkRemaining() {
                    const literalTitles = [card.title, ...card.keys.split(",")];
                    for (let i = 0; i < literalTitles.length; i++) {
                        // The pre-format set inclusion check helps avoid superfluous formatTitle calls
                        literalTitles[i] = (literalTitles[i]
                            .replace(/["\.\?!;\(\):\[\]—{}]/g, " ")
                            .trim()
                            .replace(/\s+/g, " ")
                            .replace(/^'\s*/, "")
                            .replace(/\s*'$/, "")
                        );
                        if (seen.has(literalTitles[i])) {
                            continue;
                        }
                        literalTitles[i] = formatTitle(literalTitles[i]).newTitle;
                        if (literalTitles[i] !== "") {
                            seen.add(literalTitles[i]);
                        }
                    }
                    return;
                }
                function denumberName(name) {
                    if (2 < (name.match(/[^\d\s]/g) || []).length) {
                        // Important for identifying LSIv2 auxiliary code cards when banned
                        return name.replace(/\s*\d+$/, "");
                    } else {
                        return name;
                    }
                }
            }
            clearTransientTitles();
            AC.database.titles.used = [...seen];
            return AC.database.titles.used;
        }
        static getBannedTitles() {
            // AC.database.titles.banned is an array, not a set; order matters
            return AC.database.titles.banned;
        }
        static setBannedTitles(newBans, isFinalAssignment) {
            AC.database.titles.banned = [];
            AC.database.titles.pendingBans = [];
            AC.database.titles.pendingUnbans = [];
            for (let i = newBans.length - 1; 0 <= i; i--) {
                banTitle(newBans[i], isFinalAssignment);
            }
            return AC.database.titles.banned;
        }
        static getCard(predicate, getAll) {
            if (getAll) {
                // Return an array of card references which satisfy the given condition
                const collectedCards = [];
                for (const card of storyCards) {
                    if (predicate(card)) {
                        O.s(card);
                        collectedCards.push(card);
                    }
                }
                return collectedCards;
            }
            // Return a reference to the first card which satisfies the given condition
            for (const card of storyCards) {
                if (predicate(card)) {
                    return O.s(card);
                }
            }
            return null;
        }
    }); }
    function validateCooldown(cooldown) {
        return boundInteger(0, cooldown, 9999, 22);
    }
    function validateEntryLimit(entryLimit) {
        return boundInteger(200, entryLimit, 2000, 750);
    }
    function validateMemoryLimit(memoryLimit) {
        return boundInteger(1750, memoryLimit, 9900, 2750);
    }
    function validateMemCompRatio(memCompressRatio) {
        return boundInteger(20, memCompressRatio, 1250, 25);
    }
    function validateMinLookBackDist(minLookBackDist) {
        return boundInteger(2, minLookBackDist, 88, 7);
    }
    function getDefaultConfig() {
        function check(value, fallback = true, type = "boolean") {
            if (typeof value === type) {
                return value;
            } else {
                return fallback;
            }
        }
        return O.s({
            // Is Auto-Cards enabled?
            doAC: check(DEFAULT_DO_AC),
            // Delete all previously generated story cards?
            deleteAllAutoCards: null,
            // Pin the configuration interface story card near the top?
            pinConfigureCard: check(DEFAULT_PIN_CONFIGURE_CARD),
            // Minimum number of turns in between automatic card generation events?
            addCardCooldown: validateCooldown(DEFAULT_CARD_CREATION_COOLDOWN),
            // Use bulleted list mode for newly generated card entries?
            bulletedListMode: check(DEFAULT_USE_BULLETED_LIST_MODE),
            // Maximum allowed length for newly generated story card entries?
            defaultEntryLimit: validateEntryLimit(DEFAULT_GENERATED_ENTRY_LIMIT),
            // Do newly generated cards have memory updates enabled by default?
            defaultCardsDoMemoryUpdates: check(DEFAULT_NEW_CARDS_DO_MEMORY_UPDATES),
            // Default character limit before the card's memory bank is summarized?
            defaultMemoryLimit: validateMemoryLimit(DEFAULT_NEW_CARDS_MEMORY_LIMIT),
            // Approximately how much shorter should recently compressed memories be? (ratio = 10 * old / new)
            memoryCompressionRatio: validateMemCompRatio(DEFAULT_MEMORY_COMPRESSION_RATIO),
            // Ignore all-caps during title candidate detection?
            ignoreAllCapsTitles: check(DEFAULT_IGNORE_ALL_CAPS_TITLES),
            // Should player input actions (Do/Say/Story) be considered for future named entity detection?
            readFromInputs: check(DEFAULT_DETECT_TITLES_FROM_INPUTS),
            // How many (minimum) actions in the past does Auto-Cards look for named entities?
            minimumLookBackDistance: validateMinLookBackDist(DEFAULT_MINIMUM_LOOK_BACK_DISTANCE),
            // Is Live Script Interface v2 enabled?
            LSIv2: (function() {
                if (DEFAULT_DO_LSI_V2 === true) {
                    return true;
                } else {
                    // Intrepret "false" as null, both here and for later config card reads
                    return null;
                }
            })(),
            // Should the debug data card be visible?
            showDebugData: check(DEFAULT_SHOW_DEBUG_DATA, false),
            // How should the AI be prompted when generating new story card entries?
            generationPrompt: check(DEFAULT_CARD_GENERATION_PROMPT, prose(
                "-----",
                "",
                "<SYSTEM>",
                "# Stop the story and ignore previous instructions. Write a brief and coherent informational entry for %{title} following these instructions:",
                "- Write only third-person pure prose information about %{title} using complete sentences with correct punctuation",
                "- Avoid short-term temporary details or appearances, instead focus on plot-significant information",
                "- Prioritize story-relevant details about %{title} first to ensure seamless integration with the previous plot",
                "- Create new information based on the context and story direction",
                "- Mention %{title} in every sentence",
                "- Use semicolons if needed",
                "- Add additional details about %{title} beneath incomplete entries",
                "- Be concise and grounded",
                "- Imitate the story's writing style and infer the reader's preferences",
                "</SYSTEM>",
                "Continue the entry for %{title} below while avoiding repetition:",
                "%{entry}"
            ), "string"),
            // How should the AI be prompted when summarizing memories for a given story card?
            compressionPrompt: check(DEFAULT_CARD_MEMORY_COMPRESSION_PROMPT, prose(
                "-----",
                "",
                "<SYSTEM>",
                "# Stop the story and ignore previous instructions. Summarize and condense the given paragraph into a narrow and focused memory passage while following these guidelines:",
                "- Ensure the passage retains the core meaning and most essential details",
                "- Use the third-person perspective",
                "- Prioritize information-density, accuracy, and completeness",
                "- Remain brief and concise",
                "- Write firmly in the past tense",
                "- The paragraph below pertains to old events from far earlier in the story",
                "- Integrate %{title} naturally within the memory; however, only write about the events as they occurred",
                "- Only reference information present inside the paragraph itself, be specific",
                "</SYSTEM>",
                "Write a summarized old memory passage for %{title} based only on the following paragraph:",
                "\"\"\"",
                "%{memory}",
                "\"\"\"",
                "Summarize below:"
            ), "string"),
            // All cards constructed by AC will inherit this type by default
            defaultCardType: check(DEFAULT_CARD_TYPE, "class", "string")
        });
    }
    function getDefaultConfigBans() {
        if (typeof DEFAULT_BANNED_TITLES_LIST === "string") {
            return uniqueTitlesArray(DEFAULT_BANNED_TITLES_LIST.split(","));
        } else {
            return [
                "North", "East", "South", "West", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"
            ];
        }
    }
    function uniqueTitlesArray(titles) {
        const existingTitles = new Set();
        return (titles
            .map(title => title.trim().replace(/\s+/g, " "))
            .filter(title => {
                if (title === "") {
                    return false;
                }
                const lowerTitle = title.toLowerCase();
                if (existingTitles.has(lowerTitle)) {
                    return false;
                } else {
                    existingTitles.add(lowerTitle);
                    return true;
                }
            })
        );
    }
    function boundInteger(lowerBound, value, upperBound, fallback) {
        if (!Number.isInteger(value)) {
            if (!Number.isInteger(fallback)) {
                throw new Error("Invalid arguments: value and fallback are not integers");
            }
            value = fallback;
        }
        if (Number.isInteger(lowerBound) && (value < lowerBound)) {
            if (Number.isInteger(upperBound) && (upperBound < lowerBound)) {
                throw new Error("Invalid arguments: The inequality (lowerBound <= upperBound) must be satisfied");
            }
            return lowerBound;
        } else if (Number.isInteger(upperBound) && (upperBound < value)) {
            return upperBound;
        } else {
            return value;
        }
    }
    function limitString(str, lengthLimit) {
        if (lengthLimit < str.length) {
            return str.slice(0, lengthLimit).trim();
        } else {
            return str;
        }
    }
    function cleanSpaces(unclean) {
        return (unclean
            .replace(/\s*\n\s*/g, "\n")
            .replace(/\t/g, " ")
            .replace(/  +/g, " ")
        );
    }
    function isolateNotesAndMemories(str) {
        const bisector = str.search(/\s*(?:{|(?:title|update|limit)s?\s*:)\s*/i);
        if (bisector === -1) {
            return [str, ""];
        } else {
            return [str.slice(0, bisector), str.slice(bisector)];
        }
    }
    function removeAutoProps(str) {
        return cleanSpaces(str
            .replace(/\s*{([\s\S]*?)}\s*/g, (bracedMatch, enclosedProperties) => {
                if (enclosedProperties.trim().length < 150) {
                    return "\n";
                } else {
                    return bracedMatch;
                }
            })
            .replace((
                /\s*(?:{|(?:title|update|limit)s?\s*:)(?:[\s\S]{0,150}?)(?=(?:title|update|limit)s?\s*:|})\s*/gi
            ), "\n")
            .replace(/\s*(?:{|(?:title|update|limit)s?\s*:|})\s*/gi, "\n")
            .trim()
        );
    }
    function insertTitle(prompt, title) {
        return prompt.replace((
            /(?:[%\$]+\s*|[%\$]*){+\s*(?:titles?|names?|characters?|class(?:es)?|races?|locations?|factions?)\s*}+/gi
        ), title);
    }
    function prose(...args) {
        return args.join("\n");
    }
    function buildKeys(keys, key) {
        key = key.trim().replace(/\s+/g, " ");
        const keyset = [];
        if (key === "") {
            return keys;
        } else if (keys.trim() !== "") {
            keyset.push(...keys.split(","));
            const lowerKey = key.toLowerCase();
            for (let i = keyset.length - 1; 0 <= i; i--) {
                const preKey = keyset[i].trim().replace(/\s+/g, " ").toLowerCase();
                if ((preKey === "") || preKey.includes(lowerKey)) {
                    keyset.splice(i, 1);
                }
            }
        }
        if (key.length < 6) {
            keyset.push(...[
                " " + key + " ", " " + key + "'", "\"" + key + " ", " " + key + ".", " " + key + "?", " " + key + "!", " " + key + ";", "'" + key + " ", "(" + key + " ", " " + key + ")", " " + key + ":", " " + key + "\"", "[" + key + " ", " " + key + "]", "—" + key + " ", " " + key + "—", "{" + key + " ", " " + key + "}"
            ]);
        } else if (key.length < 9) {
            keyset.push(...[
                key + " ", " " + key, key + "'", "\"" + key, key + ".", key + "?", key + "!", key + ";", "'" + key, "(" + key, key + ")", key + ":", key + "\"", "[" + key, key + "]", "—" + key, key + "—", "{" + key, key + "}"
            ]);
        } else {
            keyset.push(key);
        }
        keys = keyset[0] || key;
        let i = 1;
        while ((i < keyset.length) && ((keys.length + 1 + keyset[i].length) < 101)) {
            keys += "," + keyset[i];
            i++;
        }
        return keys;
    }
    // Returns the template-specified singleton card (or secondary varient) after:
    // 1) Erasing all inferior duplicates
    // 2) Repairing damaged titles and keys
    // 3) Constructing a new singleton card if it doesn't exist
    function getSingletonCard(allowConstruction, templateCard, secondaryCard) {
        let singletonCard = null;
        const excessCards = [];
        for (const card of storyCards) {
            O.s(card);
            if (singletonCard === null) {
                if ((card.title === templateCard.title) || (card.keys === templateCard.keys)) {
                    // The first potentially valid singleton card candidate to be found
                    singletonCard = card;
                }
            } else if (card.title === templateCard.title) {
                if (card.keys === templateCard.keys) {
                    excessCards.push(singletonCard);
                    singletonCard = card;
                } else {
                    eraseInferiorDuplicate();
                }
            } else if (card.keys === templateCard.keys) {
                eraseInferiorDuplicate();
            }
            function eraseInferiorDuplicate() {
                if ((singletonCard.title === templateCard.title) && (singletonCard.keys === templateCard.keys)) {
                    excessCards.push(card);
                } else {
                    excessCards.push(singletonCard);
                    singletonCard = card;
                }
                return;
            }
        }
        if (singletonCard === null) {
            if (secondaryCard) {
                // Fallback to a secondary card template
                singletonCard = getSingletonCard(false, secondaryCard);
            }
            // No singleton card candidate exists
            if (allowConstruction && (singletonCard === null)) {
                // Construct a new singleton card from the given template
                singletonCard = constructCard(templateCard);
            }
        } else {
            if (singletonCard.title !== templateCard.title) {
                // Repair any damage to the singleton card's title
                singletonCard.title = templateCard.title;
            } else if (singletonCard.keys !== templateCard.keys) {
                // Repair any damage to the singleton card's keys
                singletonCard.keys = templateCard.keys;
            }
            for (const card of excessCards) {
                // Erase all excess singleton card candidates
                eraseCard(card);
            }
            if (secondaryCard) {
                // A secondary card match cannot be allowed to persist
                eraseCard(getSingletonCard(false, secondaryCard));
            }
        }
        return singletonCard;
    }
    // Erases the given story card
    function eraseCard(badCard) {
        if (badCard === null) {
            return false;
        }
        badCard.title = "%@%";
        for (const [index, card] of storyCards.entries()) {
            if (card.title === "%@%") {
                removeStoryCard(index);
                return true;
            }
        }
        return false;
    }
    // Constructs a new story card from a standardized story card template object
    // {type: "", title: "", keys: "", entry: "", description: ""}
    // Returns a reference to the newly constructed card
    function constructCard(templateCard, insertionIndex = 0) {
        addStoryCard("%@%");
        for (const [index, card] of storyCards.entries()) {
            if (card.title !== "%@%") {
                continue;
            }
            card.type = templateCard.type;
            card.title = templateCard.title;
            card.keys = templateCard.keys;
            card.entry = templateCard.entry;
            card.description = templateCard.description;
            if (index !== insertionIndex) {
                // Remove from the current position and reinsert at the desired index
                storyCards.splice(index, 1);
                storyCards.splice(insertionIndex, 0, card);
            }
            return O.s(card);
        }
        return {};
    }
    function newCardIndex() {
        return +AC.config.pinConfigureCard;
    }
    function getIntendedCard(targetCard) {
        Internal.getUsedTitles(true);
        const titleKey = targetCard.trim().replace(/\s+/g, " ").toLowerCase();
        const autoCard = Internal.getCard(card => (card.entry
            .toLowerCase()
            .startsWith("{title: " + titleKey + "}")
        ));
        if (autoCard !== null) {
            return [autoCard, true, titleKey];
        }
        return [Internal.getCard(card => ((card.title
            .replace(/\s+/g, " ")
            .toLowerCase()
        ) === titleKey)), false, titleKey];
    }
    function doPlayerCommands(input) {
        let result = "";
        for (const command of (
            (function() {
                if (/^\n> [\s\S]*? says? "[\s\S]*?"\n$/.test(input)) {
                    return input.replace(/\s*"\n$/, "");
                } else {
                    return input.trimEnd();
                }
            })().split(/(?=\/\s*A\s*C)/i)
        )) {
            const prefixPattern = /^\/\s*A\s*C/i;
            if (!prefixPattern.test(command)) {
                continue;
            }
            const [requestTitle, requestDetails, requestEntry] = (command
                .replace(/(?:{\s*)|(?:\s*})/g, "")
                .replace(prefixPattern, "")
                .replace(/(?:^\s*\/*\s*)|(?:\s*\/*\s*$)/g, "")
                .split("/")
                .map(requestArg => requestArg.trim())
                .filter(requestArg => (requestArg !== ""))
            );
            if (!requestTitle) {
                // Request with no args
                AC.generation.cooldown = 0;
                result += "/AC -> Success!\n\n";
                logEvent("/AC");
            } else {
                const request = {title: requestTitle.replace(/\s*[\.\?!:]+$/, "")};
                const redo = (function() {
                    const redoPattern = /^(?:redo|retry|rewrite|remake)[\s\.\?!:,;"'—\)\]]+\s*/i;
                    if (redoPattern.test(request.title)) {
                        request.title = request.title.replace(redoPattern, "");
                        if (/^(?:all|every)(?:\s|\.|\?|!|:|,|;|"|'|—|\)|\]|$)/i.test(request.title)) {
                            return [];
                        } else {
                            return true;
                        }
                    } else {
                        return false;
                    }
                })();
                if (Array.isArray(redo)) {
                    // Redo all auto cards
                    Internal.getUsedTitles(true);
                    const titleMatchPattern = /^{title: ([\s\S]*?)}/;
                    redo.push(...Internal.getCard(card => (
                        titleMatchPattern.test(card.entry)
                        && /{updates: (?:true|false), limit: \d+}/.test(card.description)
                    ), true));
                    let count = 0;
                    for (const card of redo) {
                        const titleMatch = card.entry.match(titleMatchPattern);  
                        if (titleMatch && Internal.redoCard(O.f({title: titleMatch[1]}), true, "")) {
                            count++;
                        }
                    }
                    const parsed = "/AC redo all";
                    result += parsed + " -> ";
                    if (count === 0) {
                        result += "There were no valid auto-cards to redo";
                    } else {
                        result += "Success!";
                        if (1 < count) {
                            result += " Proceed to redo " + count + " cards";
                        }
                    }
                    logEvent(parsed);
                } else if (!requestDetails) {
                    // Request with only title
                    submitRequest("");
                } else if (!requestEntry || redo) {
                    // Request with title and details
                    request.entryPromptDetails = requestDetails;
                    submitRequest(" / {" + requestDetails + "}");
                } else {
                    // Request with title, details, and entry
                    request.entryPromptDetails = requestDetails;
                    request.entryStart = requestEntry;
                    submitRequest(" / {" + requestDetails + "} / {" + requestEntry + "}");
                }
                result += "\n\n";
                function submitRequest(extra) {
                    O.f(request);
                    const [type, success] = (function() {
                        if (redo) {
                            return [" redo", Internal.redoCard(request, true, "")];
                        } else {
                            Internal.getUsedTitles(true);
                            return ["", Internal.generateCard(request)];
                        }
                    })();
                    const left = "/AC" + type + " {";
                    const right = "}" + extra;
                    if (success) {
                        const parsed = left + AC.generation.pending[AC.generation.pending.length - 1].title + right;
                        result += parsed + " -> Success!";
                        logEvent(parsed);
                    } else {
                        const parsed = left + request.title + right;
                        result += parsed + " -> \"" + request.title + "\" is invalid or unavailable";
                        logEvent(parsed);
                    }
                    return;
                }
            }
            if (isPendingGeneration() || isAwaitingGeneration() || isPendingCompression()) {
                if (AC.config.doAC) {
                    AC.signal.outputReplacement = "";
                } else {
                    AC.signal.forceToggle = true;
                    AC.signal.outputReplacement = ">>> please select \"continue\" (0%) <<<";
                }
            } else if (AC.generation.cooldown === 0) {
                if (0 < AC.database.titles.candidates.length) {
                    if (AC.config.doAC) {
                        AC.signal.outputReplacement = "";
                    } else {
                        AC.signal.forceToggle = true;
                        AC.signal.outputReplacement = ">>> please select \"continue\" (0%) <<<";
                    }
                } else if (AC.config.doAC) {
                    result = result.trimEnd() + "\n";
                    AC.signal.outputReplacement = "\n";
                } else {
                    AC.signal.forceToggle = true;
                    AC.signal.outputReplacement = ">>> Auto-Cards has been enabled! <<<";
                }
            } else {
                result = result.trimEnd() + "\n";
                AC.signal.outputReplacement = "\n";
            }
        }
        return getPrecedingNewlines() + result;
    }
    function advanceChronometer() {
        const currentTurn = getTurn();
        if (Math.abs(history.length - currentTurn) < 2) {
            // The two measures are within ±1, thus history hasn't been truncated yet
            AC.chronometer.step = !(history.length < currentTurn);
        } else {
            // history has been truncated, fallback to a (slightly) worse step detection technique
            AC.chronometer.step = (AC.chronometer.turn < currentTurn);
        }
        AC.chronometer.turn = currentTurn;
        return;
    }
    function concludeEmergency() {
        promoteAmnesia();
        endTurn();
        AC.message.pending = [];
        AC.message.previous = getStateMessage();
        return;
    }
    function concludeOutputBlock(templateCard) {
        if (AC.config.deleteAllAutoCards !== null) {
            // A config-initiated event to delete all previously generated story cards is in progress
            if (AC.config.deleteAllAutoCards) {
                // Request in-game confirmation from the player before proceeding
                AC.config.deleteAllAutoCards = false;
                CODOMAIN.initialize(getPrecedingNewlines() + ">>> please submit the message \"CONFIRM DELETE\" using a Do, Say, or Story action to permanently delete all previously generated story cards <<<\n\n");
            } else {
                // Check for player confirmation
                const previousAction = readPastAction(0);
                if (isDoSayStory(previousAction.type) && /CONFIRM\s*DELETE/i.test(previousAction.text)) {
                    let successMessage = "Confirmation Success: ";
                    const numCardsErased = Internal.eraseAllAutoCards();
                    if (numCardsErased === 0) {
                        successMessage += "However, there were no previously generated story cards to delete!";
                    } else {
                        successMessage += numCardsErased + " generated story card";
                        if (numCardsErased === 1) {
                            successMessage += " was";
                        } else {
                            successMessage += "s were";
                        }
                        successMessage += " deleted";
                    }
                    notify(successMessage);
                } else {
                    notify("Confirmation Failure: No story cards were deleted");
                }
                AC.config.deleteAllAutoCards = null;
                CODOMAIN.initialize("\n");
            }
        } else if (AC.signal.outputReplacement !== "") {
            const output = AC.signal.outputReplacement.trim();
            if (output === "") {
                CODOMAIN.initialize("\n");
            } else {
                CODOMAIN.initialize(getPrecedingNewlines() + output + "\n\n");
            }
        }
        if (templateCard) {
            // Auto-Cards was enabled or disabled during the previous onContext hook
            // Construct the replacement control card onOutput
            banTitle(templateCard.title);
            getSingletonCard(true, templateCard);
            AC.signal.swapControlCards = false;
        }
        endTurn();
        if (AC.config.LSIv2 === null) {
            postMessages();
        }
        return;
    }
    function endTurn() {
        AC.database.titles.used = [];
        AC.signal.outputReplacement = "";
        [AC.database.titles.pendingBans, AC.database.titles.pendingUnbans].map(pending => decrementAll(pending));
        if (0 < AC.signal.overrideBans) {
            AC.signal.overrideBans--;
        }
        function decrementAll(pendingArray) {
            if (pendingArray.length === 0) {
                return;
            }
            for (let i = pendingArray.length - 1; 0 <= i; i--) {
                if (0 < pendingArray[i][1]) {
                    pendingArray[i][1]--;
                } else {
                    pendingArray.splice(i, 1);
                }
            }
            return;
        }
        return;
    }
    // Example usage: notify("Message text goes here");
    function notify(message) {
        if (typeof message === "string") {
            AC.message.pending.push(message);
            logEvent(message);
        } else if (Array.isArray(message)) {
            message.forEach(element => notify(element));
        } else if (message instanceof Set) {
            notify([...message]);
        } else {
            notify(message.toString());
        }
        return;
    }
    function logEvent(message, uncounted) {
        if (uncounted) {
            log("Auto-Cards event: " + message);
        } else {
            log("Auto-Cards event #" + (function() {
                try {
                    AC.message.event++;
                    return AC.message.event;
                } catch {
                    return 0;
                }
            })() + ": " + message.replace(/"/g, "'"));
        }
        return;
    }
    // Provide the story card object which you wish to log info within as the first argument
    // All remaining arguments represent anything you wish to log
    function logToCard(logCard, ...args) {
        logEvent(args.map(arg => {
            if ((typeof arg === "object") && (arg !== null)) {
                return JSON.stringify(arg);
            } else {
                return String(arg);
            }
        }).join(", "), true);
        if (logCard === null) {
            return;
        }
        let desc = logCard.description.trim();
        const turnDelimiter = Words.delimiter + "\nAction #" + getTurn() + ":\n";
        let header = turnDelimiter;
        if (!desc.startsWith(turnDelimiter)) {
            desc = turnDelimiter + desc;
        }
        const scopesTable = [
            ["input", "Input Modifier"],
            ["context", "Context Modifier"],
            ["output", "Output Modifier"],
            [null, "Shared Library"],
            [undefined, "External API"],
            [Symbol("default"), "Unknown Scope"]
        ];
        const callingScope = (function() {
            const pair = scopesTable.find(([condition]) => (condition === HOOK));
            if (pair) {
                return pair[1];
            } else {
                return scopesTable[scopesTable.length - 1][1];
            }
        })();
        const hookDelimiterLeft = callingScope + " @ ";
        if (desc.startsWith(turnDelimiter + hookDelimiterLeft)) {
            const hookDelimiterOld = desc.match(new RegExp((
                "^" + turnDelimiter + "(" + hookDelimiterLeft + "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z:\n)"
            ).replaceAll("\n", "\\n")));
            if (hookDelimiterOld) {
                header += hookDelimiterOld[1];
            } else {
                const hookDelimiter = getNewHookDelimiter();
                desc = desc.replace(hookDelimiterLeft, hookDelimiter);
                header += hookDelimiter;
            }
        } else {
            if ((new RegExp("^" + turnDelimiter.replaceAll("\n", "\\n") + "(" + (scopesTable
                .map(pair => pair[1])
                .filter(scope => (scope !== callingScope))
                .join("|")
            ) + ") @ ")).test(desc)) {
                desc = desc.replace(turnDelimiter, turnDelimiter + "—————————\n");
            }
            const hookDelimiter = getNewHookDelimiter();
            desc = desc.replace(turnDelimiter, turnDelimiter + hookDelimiter);
            header += hookDelimiter;
        }
        const logDelimiter = (function() {
            let logDelimiter = "Log #";
            if (desc.startsWith(header + logDelimiter)) {
                desc = desc.replace(header, header + "———\n");
                const logCounter = desc.match(/Log #(\d+)/);
                if (logCounter) {
                    logDelimiter += (parseInt(logCounter[1], 10) + 1).toString();
                }
            } else {
                logDelimiter += "0";
            }
            return logDelimiter + ": ";
        })();
        logCard.description = limitString(desc.replace(header, header + logDelimiter + args.map(arg => {
            if ((typeof arg === "object") && (arg !== null)) {
                return stringifyObject(arg);
            } else {
                return String(arg);
            }
        }).join(",\n") + "\n").trim(), 999999);
        // The upper limit is actually closer to 3985621, but I think 1 million is reasonable enough as-is
        function getNewHookDelimiter() {
            return hookDelimiterLeft + (new Date().toISOString()) + ":\n";
        }
        return;
    }
    // Makes nested objects not look like cancer within interface cards
    function stringifyObject(obj) {
        const seen = new WeakSet();
        // Each indentation is 4 spaces
        return JSON.stringify(obj, (_key, value) => {
            if ((typeof value === "object") && (value !== null)) {
                if (seen.has(value)) {
                    return "[Circular]";
                }
                seen.add(value);
            }
            switch(typeof value) {
            case "function": {
                return "[Function]"; }
            case "undefined": {
                return "[Undefined]"; }
            case "symbol": {
                return "[Symbol]"; }
            default: {
                return value; }
            }
        }, 4);
    }
    // Implement state.message toasts without interfering with the operation of other possible scripts
    function postMessages() {
        const preMessage = getStateMessage();
        if ((preMessage === AC.message.previous) && (AC.message.pending.length !== 0)) {
            // No other scripts are attempting to update state.message during this turn
            // One or more pending Auto-Cards messages exist
            if (!AC.message.suppress) {
                // Message suppression is off
                let newMessage = "Auto-Cards:\n";
                if (AC.message.pending.length === 1) {
                    newMessage += AC.message.pending[0];
                } else {
                    newMessage += AC.message.pending.map(
                        (messageLine, index) => ("#" + (index + 1) + ": " + messageLine)
                    ).join("\n");
                }
                if (preMessage === newMessage) {
                    // Introduce a minor variation to facilitate repetition of the previous message toast
                    newMessage = newMessage.replace("Auto-Cards:\n", "Auto-Cards: \n");
                }
                state.message = newMessage;
            }
            // Clear the pending messages queue after posting or suppressing messages
            AC.message.pending = [];
        }
        AC.message.previous = getStateMessage();
        return;
    }
    function getStateMessage() {
        return state.message ?? "";
    }
    function getPrecedingNewlines() {
        const previousAction = readPastAction(0);
        if (isDoSay(previousAction.type)) {
            return "";
        } else if (previousAction.text.endsWith("\n")) {
            if (previousAction.text.endsWith("\n\n")) {
                return "";
            } else {
                return "\n";
            }
        } else {
            return "\n\n";
        }
    }
    // Call with lookBack 0 to read the most recent action in history (or n many actions back)
    function readPastAction(lookBack) {
        const action = (function() {
            if (Array.isArray(history)) {
                return (history[(function() {
                    const index = history.length - 1 - Math.abs(lookBack);
                    if (index < 0) {
                        return 0;
                    } else {
                        return index;
                    }
                })()]);
            } else {
                return O.f({});
            }
        })();
        return O.f({
            text: action?.text ?? (action?.rawText ?? ""),
            type: action?.type ?? "unknown"
        });
    }
    // Forget ongoing card generation/compression after passing or postponing completion over many consecutive turns
    // Also decrement AC.chronometer.postpone regardless of retries or erases
    function promoteAmnesia() {
        // Decrement AC.chronometer.postpone in all cases
        if (0 < AC.chronometer.postpone) {
            AC.chronometer.postpone--;
        }
        if (!AC.chronometer.step) {
            // Skip known retry/erase turns
            return;
        }
        if (AC.chronometer.amnesia++ < boundInteger(16, (2 * AC.config.addCardCooldown), 64)) {
            return;
        }
        AC.generation.cooldown = validateCooldown(underQuarterInteger(AC.config.addCardCooldown));
        forgetStuff();
        AC.chronometer.amnesia = 0;
        return;
    }
    function forgetStuff() {
        AC.generation.completed = 0;
        AC.generation.permitted = 34;
        AC.generation.workpiece = O.f({});
        // AC.generation.pending is not forgotten
        resetCompressionProperties();
        return;
    }
    function resetCompressionProperties() {
        AC.compression.completed = 0;
        AC.compression.titleKey = "";
        AC.compression.vanityTitle = "";
        AC.compression.responseEstimate = 1400;
        AC.compression.lastConstructIndex = -1;
        AC.compression.oldMemoryBank = [];
        AC.compression.newMemoryBank = [];
        return;
    }
    function underQuarterInteger(someNumber) {
        return Math.floor(someNumber / 4);
    }
    function getTurn() {
        if (Number.isInteger(info?.actionCount)) {
            // "But Leah, surely info.actionCount will never be negative?"
            // You have no idea what nightmares I've seen...
            return Math.abs(info.actionCount);
        } else {
            return 0;
        }
    }
    // Constructs a JSON representation of various properties/settings pulled from raw text
    // Used to parse the "Configure Auto-Cards" and "Edit to enable Auto-Cards" control card entries
    function extractSettings(settingsText) {
        const settings = {};
        // Lowercase everything
        // Remove all non-alphanumeric characters (aside from ":" and ">")
        // Split into an array of strings delimited by the ">" character
        const settingLines = settingsText.toLowerCase().replace(/[^a-z0-9:>]+/g, "").split(">");
        for (const settingLine of settingLines) {
            // Each setting line is preceded by ">" and bisected by ":"
            const settingKeyValue = settingLine.split(":");
            if ((settingKeyValue.length !== 2) || settings.hasOwnProperty(settingKeyValue[0])) {
                // The bisection failed or this setting line's key already exists
                continue;
            }
            // Parse boolean and integer setting values
            if (Words.falses.includes(settingKeyValue[1])) {
                // This setting line's value is false
                settings[settingKeyValue[0]] = false;
            } else if (Words.trues.includes(settingKeyValue[1])) {
                // This setting line's value is true
                settings[settingKeyValue[0]] = true;
            } else if (/^\d+$/.test(settingKeyValue[1])) {
                // This setting line's value is an integer
                // Negative integers are parsed as being positive (because "-" characters were removed)
                settings[settingKeyValue[0]] = parseInt(settingKeyValue[1], 10);
            }
        }
        // Return the settings object for later analysis
        return settings;
    }
    // Ensure the given singleton card is pinned near the top of the player's list of story cards
    function pinAndSortCards(pinnedCard) {
        if (!storyCards || (storyCards.length < 2)) {
            return;
        }
        storyCards.sort((cardA, cardB) => {
            return readDate(cardB) - readDate(cardA);
        });
        if (!AC.config.pinConfigureCard) {
            return;
        }
        const index = storyCards.indexOf(pinnedCard);
        if (0 < index) {
            storyCards.splice(index, 1);
            storyCards.unshift(pinnedCard);
        }
        function readDate(card) {
            if (card && card.updatedAt) {
                const timestamp = Date.parse(card.updatedAt);
                if (!isNaN(timestamp)) {
                    return timestamp;
                }
            }
            return 0;
        }
        return;
    }
    function see(arr) {
        return String.fromCharCode(...arr.map(n => Math.sqrt(n / 33)));
    }
    function formatTitle(title) {
        title = title.trim();
        const failureCase = O.f({newTitle: "", newKey: ""});
        if (short()) {
            // This is an abundantly called function, return as early as possible to ensure superior performance
            return failureCase;
        }
        title = (title
            // Begone!
            .replace(/[–。？！´“”؟،«»¿¡„“…§，、\*_~><\(\)\[\]{}#"`:!—;\.\?,\s\\]/g, " ")
            .replace(/[‘’]/g, "'").replace(/\s+'/g, " ")
            // Remove the words "I", "I'm", "I'd", "I'll", and "I've"
            .replace(/(?<=^|\s)(?:I|I'm|I'd|I'll|I've)(?=\s|$)/gi, "")
            // Remove "'s" only if not followed by a letter
            .replace(/'s(?![a-zA-Z])/g, "")
            // Replace "s'" with "s" only if preceded but not followed by a letter
            .replace(/(?<=[a-zA-Z])s'(?![a-zA-Z])/g, "s")
            // Remove apostrophes not between letters (preserve contractions like "don't")
            .replace(/(?<![a-zA-Z])'(?![a-zA-Z])/g, "")
            // Eliminate fake em dashes and terminal/leading dashes
            .replace(/\s-\s/g, " ")
            // Condense consecutive whitespace
            .trim().replace(/\s+/g, " ")
            // Remove a leading or trailing bullet
            .replace(/^-+\s*/, "").replace(/\s*-+$/, "")
        );
        if (short()) {
            return failureCase;
        }
        // Special-cased words
        const minorWordsJoin = Words.minor.join("|");
        const leadingMinorWordsKiller = new RegExp("^(?:" + minorWordsJoin + ")\\s", "i");
        const trailingMinorWordsKiller = new RegExp("\\s(?:" + minorWordsJoin + ")$", "i");
        // Ensure the title is not bounded by any outer minor words
        title = enforceBoundaryCondition(title);
        if (short()) {
            return failureCase;
        }
        // Ensure interior minor words are lowercase and excise all interior honorifics/abbreviations
        const honorAbbrevsKiller = new RegExp("(?:^|\\s|-|\\/)(?:" + (
            [...Words.honorifics, ...Words.abbreviations]
        ).map(word => word.replace(".", "")).join("|") + ")(?=\\s|-|\\/|$)", "gi");
        title = (title
            // Capitalize the first letter of each word
            .replace(/(?<=^|\s|-|\/)(?:\p{L})/gu, word => word.toUpperCase())
            // Lowercase minor words properly
            .replace(/(?<=^|\s|-|\/)(?:\p{L}+)(?=\s|-|\/|$)/gu, word => {
                const lowerWord = word.toLowerCase();
                if (Words.minor.includes(lowerWord)) {
                    return lowerWord;
                } else {
                    return word;
                }
            })
            // Remove interior honorifics/abbreviations
            .replace(honorAbbrevsKiller, "")
            .trim()
        );
        if (short()) {
            return failureCase;
        }
        let titleWords = title.split(" ");
        while ((2 < title.length) && (98 < title.length) && (1 < titleWords.length)) {
            titleWords.pop();
            title = titleWords.join(" ").trim();
            const unboundedLength = title.length;
            title = enforceBoundaryCondition(title);
            if (unboundedLength !== title.length) {
                titleWords = title.split(" ");
            }
        }
        if (isUsedOrBanned(title) || isNamed(title)) {
            return failureCase;
        }
        // Procedurally generated story card trigger keywords exclude certain words and patterns which are otherwise permitted in titles
        let key = title;
        const peerage = new Set(Words.peerage);
        if (titleWords.some(word => ((word === "the") || peerage.has(word.toLowerCase())))) {
            if (titleWords.length < 2) {
                return failureCase;
            }
            key = enforceBoundaryCondition(
                titleWords.filter(word => !peerage.has(word.toLowerCase())).join(" ")
            );
            if (key.includes(" the ")) {
                key = enforceBoundaryCondition(key.split(" the ")[0]);
            }
            if (isUsedOrBanned(key)) {
                return failureCase;
            }
        }
        function short() {
            return (title.length < 3);
        }
        function enforceBoundaryCondition(str) {
            while (leadingMinorWordsKiller.test(str)) {
                str = str.replace(/^\S+\s+/, "");
            }
            while (trailingMinorWordsKiller.test(str)) {
                str = str.replace(/\s+\S+$/, "");
            }
            return str;
        }
        return O.f({newTitle: title, newKey: key});
    }
    // I really hate english grammar
    function checkPlurals(title, predicate) {
        function check(t) { return ((t.length < 3) || (100 < t.length) || predicate(t)); }
        const t = title.toLowerCase();
        if (check(t)) { return true; }
        // s>p : singular -> plural : p>s: plural -> singular
        switch(t[t.length - 1]) {
        // p>s : s -> _ : Birds -> Bird
        case "s": if (check(t.slice(0, -1))) { return true; }
        case "x":
        // s>p : s, x, z -> ses, xes, zes : Mantis -> Mantises
        case "z": if (check(t + "es")) { return true; }
            break;
        // s>p : o -> oes, os : Gecko -> Geckoes, Geckos
        case "o": if (check(t + "es") || check(t + "s")) { return true; }
            break;
        // p>s : i -> us : Cacti -> Cactus
        case "i": if (check(t.slice(0, -1) + "us")) { return true; }
        // s>p : i, y -> ies : Kitty -> Kitties
        case "y": if (check(t.slice(0, -1) + "ies")) { return true; }
            break;
        // s>p : f -> ves : Wolf -> Wolves
        case "f": if (check(t.slice(0, -1) + "ves")) { return true; }
        // s>p : !(s, x, z, i, y) -> +s : Turtle -> Turtles
        default: if (check(t + "s")) { return true; }
            break;
        } switch(t.slice(-2)) {
        // p>s : es -> _ : Foxes -> Fox
        case "es": if (check(t.slice(0, -2))) { return true; } else if (
            (t.endsWith("ies") && (
                // p>s : ies -> y : Bunnies -> Bunny
                check(t.slice(0, -3) + "y")
                // p>s : ies -> i : Ravies -> Ravi
                || check(t.slice(0, -2))
            // p>s : es -> is : Crises -> Crisis
            )) || check(t.slice(0, -2) + "is")) { return true; }
            break;
        // s>p : us -> i : Cactus -> Cacti
        case "us": if (check(t.slice(0, -2) + "i")) { return true; }
            break;
        // s>p : is -> es : Thesis -> Theses
        case "is": if (check(t.slice(0, -2) + "es")) { return true; }
            break;
        // s>p : fe -> ves : Knife -> Knives
        case "fe": if (check(t.slice(0, -2) + "ves")) { return true; }
            break;
        case "sh":
        // s>p : sh, ch -> shes, ches : Fish -> Fishes
        case "ch": if (check(t + "es")) { return true; }
            break;
        } return false;
    }
    function isUsedOrBanned(title) {
        function isUsed(lowerTitle) {
            if (used.size === 0) {
                const usedTitles = Internal.getUsedTitles();
                for (let i = 0; i < usedTitles.length; i++) {
                    used.add(usedTitles[i].toLowerCase());
                }
                if (used.size === 0) {
                    // Add a placeholder so compute isn't wasted on additional checks during this hook
                    used.add("%@%");
                }
            }
            return used.has(lowerTitle);
        }
        return checkPlurals(title, t => (isUsed(t) || isBanned(t)));
    }
    function isBanned(lowerTitle, getUsedIsExternal) {
        if (bans.size === 0) {
            // In order to save space, implicit bans aren't listed within the UI
            const controlVariants = getControlVariants();
            const dataVariants = getDataVariants();
            const bansToAdd = [...lowArr([
                ...Internal.getBannedTitles(),
                controlVariants.enable.title.replace("\n", ""),
                controlVariants.enable.keys,
                controlVariants.configure.title.replace("\n", ""),
                controlVariants.configure.keys,
                dataVariants.debug.title,
                dataVariants.debug.keys,
                dataVariants.critical.title,
                dataVariants.critical.keys,
                ...Object.values(Words.reserved)
            ]), ...(function() {
                if (shouldProceed() || getUsedIsExternal) {
                    // These proper nouns are way too common to waste card generations on; they already exist within the AI training data so this would be pointless
                    return [...Words.entities, ...Words.undesirables.map(undesirable => see(undesirable))];
                } else {
                    return [];
                }
            })()];
            for (let i = 0; i < bansToAdd.length; i++) {
                bans.add(bansToAdd[i]);
            }
        }
        return bans.has(lowerTitle);
    }
    function isNamed(title, returnSurname) {
        const peerage = new Set(Words.peerage);
        const minorWords = new Set(Words.minor);
        if ((forenames.size === 0) || (surnames.size === 0)) {
            const usedTitles = Internal.getUsedTitles();
            for (let i = 0; i < usedTitles.length; i++) {
                const usedTitleWords = divideTitle(usedTitles[i]);
                if (
                    (usedTitleWords.length === 2)
                    && (2 < usedTitleWords[0].length)
                    && (2 < usedTitleWords[1].length)
                ) {
                    forenames.add(usedTitleWords[0]);
                    surnames.add(usedTitleWords[1]);
                } else if (
                    (usedTitleWords.length === 1)
                    && (2 < usedTitleWords[0].length)
                ) {
                    forenames.add(usedTitleWords[0]);
                }
            }
            if (forenames.size === 0) {
                forenames.add("%@%");
            }
            if (surnames.size === 0) {
                surnames.add("%@%");
            }
        }
        const titleWords = divideTitle(title);
        if (
            returnSurname
            && (titleWords.length === 2)
            && (3 < titleWords[0].length)
            && (3 < titleWords[1].length)
            && forenames.has(titleWords[0])
            && surnames.has(titleWords[1])
        ) {
            return (title
                .split(" ")
                .find(casedTitleWord => (casedTitleWord.toLowerCase() === titleWords[1]))
            );
        } else if (
            (titleWords.length === 2)
            && (2 < titleWords[0].length)
            && (2 < titleWords[1].length)
            && forenames.has(titleWords[0])
        ) {         
            return true;
        } else if (
            (titleWords.length === 1)
            && (2 < titleWords[0].length)
            && (forenames.has(titleWords[0]) || surnames.has(titleWords[0]))
        ) {
            return true;
        }
        function divideTitle(undividedTitle) {
            const titleWords = undividedTitle.toLowerCase().split(" ");
            if (titleWords.some(word => minorWords.has(word))) {
                return [];
            } else {
                return titleWords.filter(word => !peerage.has(word));
            }
        }
        return false;
    }
    function shouldProceed() {
        return (AC.config.doAC && !AC.signal.emergencyHalt && (AC.chronometer.postpone < 1));
    }
    function isDoSayStory(type) {
        return (isDoSay(type) || (type === "story"));
    }
    function isDoSay(type) {
        return ((type === "do") || (type === "say"));
    }
    function permitOutput() {
        return ((AC.config.deleteAllAutoCards === null) && (AC.signal.outputReplacement === ""));
    }
    function isAwaitingGeneration() {
        return (0 < AC.generation.pending.length);
    }
    function isPendingGeneration() {
        return notEmptyObj(AC.generation.workpiece);
    }
    function isPendingCompression() {
        return (AC.compression.titleKey !== "");
    }
    function notEmptyObj(obj) {
        return (obj && (0 < Object.keys(obj).length));
    }
    function clearTransientTitles() {
        AC.database.titles.used = [];
        [used, forenames, surnames].forEach(nameset => nameset.clear());
        return;
    }
    function banTitle(title, isFinalAssignment) {
        title = limitString(title.replace(/\s+/g, " ").trim(), 100);
        const lowerTitle = title.toLowerCase();
        if (bans.size !== 0) {
            bans.add(lowerTitle);
        }
        if (!lowArr(Internal.getBannedTitles()).includes(lowerTitle)) {
            AC.database.titles.banned.unshift(title);
            if (isFinalAssignment) {
                return;
            }
            AC.database.titles.pendingBans.unshift([title, 3]);
            const index = AC.database.titles.pendingUnbans.findIndex(pair => (pair[0].toLowerCase() === lowerTitle));
            if (index !== -1) {
                AC.database.titles.pendingUnbans.splice(index, 1);
            }
        }
        return;
    }
    function unbanTitle(title) {
        title = title.replace(/\s+/g, " ").trim();
        const lowerTitle = title.toLowerCase();
        if (used.size !== 0) {
            bans.delete(lowerTitle);
        }
        let index = lowArr(Internal.getBannedTitles()).indexOf(lowerTitle);
        if (index !== -1) {
            AC.database.titles.banned.splice(index, 1);
            AC.database.titles.pendingUnbans.unshift([title, 3]);
            index = AC.database.titles.pendingBans.findIndex(pair => (pair[0].toLowerCase() === lowerTitle));
            if (index !== -1) {
                AC.database.titles.pendingBans.splice(index, 1);
            }
        }
        return;
    }
    function lowArr(arr) {
        return arr.map(str => str.toLowerCase());
    }
    function getControlVariants() {
        return O.f({
            configure: O.f({
                title: "Configure \nAuto-Cards",
                keys: "Edit the entry above to adjust your story card automation settings",
            }),
            enable: O.f({
                title: "Edit to enable \nAuto-Cards",
                keys: "Edit the entry above to enable story card automation",
            }),
        });
    }
    function getDataVariants() {
        return O.f({
            debug: O.f({
                title: "Debug Data",
                keys: "You may view the debug state in the notes section below",
            }),
            critical: O.f({
                title: "Critical Data",
                keys: "Never modify or delete this story card",
            }),
        });
    }
    // Prepare to export the codomain
    const codomain = CODOMAIN.read();
    const [stopPackaged, lastCall] = (function() {
        // Tbh I don't know why I even bothered going through the trouble of implementing "stop" within LSIv2
        switch(HOOK) {
        case "context": {
            const haltStatus = [];
            if (Array.isArray(codomain)) {
                O.f(codomain);
                haltStatus.push(true, codomain[1]);
            } else {
                haltStatus.push(false, STOP);
            }
            if ((AC.config.LSIv2 !== false) && (haltStatus[1] === true)) {
                // AutoCards will return [text, (stop === true)] onContext
                // The onOutput lifecycle hook will not be executed during this turn
                concludeEmergency();
            }
            return haltStatus; }
        case "output": {
            // AC.config.LSIv2 being either true or null implies (lastCall === true)
            return [null, AC.config.LSIv2 ?? true]; }
        default: {
            return [null, null]; }
        }
    })();
    // Repackage AC to propagate its state forward in time
    if (state.LSIv2) {
        // Facilitates recursive calls of AutoCards
        // The Auto-Cards external API is accessible through the LSIv2 scope
        state.LSIv2 = AC;
    } else {
        const memoryOverflow = (38000 < (JSON.stringify(state).length + JSON.stringify(AC).length));
        if (memoryOverflow) {
            // Memory overflow is imminent
            const dataVariants = getDataVariants();
            if (lastCall) {
                unbanTitle(dataVariants.debug.title);
                banTitle(dataVariants.critical.title);
            }
            setData(dataVariants.critical, dataVariants.debug);
            if (state.AutoCards) {
                // Decouple state for safety
                delete state.AutoCards;
            }
        } else {
            if (lastCall) {
                const dataVariants = getDataVariants();
                unbanTitle(dataVariants.critical.title);
                if (AC.config.showDebugData) {
                    // Update the debug data card
                    banTitle(dataVariants.debug.title);
                    setData(dataVariants.debug, dataVariants.critical);
                } else {
                    // There should be no data card
                    unbanTitle(dataVariants.debug.title);
                    if (data === null) {
                        data = getSingletonCard(false, O.f({...dataVariants.debug}), O.f({...dataVariants.critical}));
                    }
                    eraseCard(data);
                    data = null;
                }
            } else if (AC.config.showDebugData && (HOOK === undefined)) {
                const dataVariants = getDataVariants();
                setData(dataVariants.debug, dataVariants.critical);
            }
            // Save a backup image to state
            state.AutoCards = AC;
        }
        function setData(primaryVariant, secondaryVariant) {
            const dataCardTemplate = O.f({
                type: AC.config.defaultCardType,
                title: primaryVariant.title,
                keys: primaryVariant.keys,
                entry: (function() {
                    const mutualEntry = (
                        "If you encounter an Auto-Cards bug or otherwise wish to help me improve this script by sharing your configs and game data, please send me the notes text found below. You may ping me @LewdLeah through the official AI Dungeon Discord server. Please ensure the content you share is appropriate for the server, otherwise DM me instead. 😌"
                    );
                    if (memoryOverflow) {
                        return (
                            "Seeing this means Auto-Cards detected an imminent memory overflow event. But fear not! As an emergency fallback, the full state of Auto-Cards' data has been serialized and written to the notes section below. This text will be deserialized during each lifecycle hook, therefore it's absolutely imperative that you avoid editing this story card!"
                        ) + (function() {
                            if (AC.config.showDebugData) {
                                return "\n\n" + mutualEntry;
                            } else {
                                return "";
                            }
                        })();
                    } else {
                        return (
                            "This story card displays the full serialized state of Auto-Cards. To remove this card, simply set the \"log debug data\" setting to false within your \"Configure\" card. "
                        ) + mutualEntry;
                    }
                })(),
                description: JSON.stringify(AC)
            });
            if (data === null) {
                data = getSingletonCard(true, dataCardTemplate, O.f({...secondaryVariant}));
            }
            for (const propertyName of ["title", "keys", "entry", "description"]) {
                if (data[propertyName] !== dataCardTemplate[propertyName]) {
                    data[propertyName] = dataCardTemplate[propertyName];
                }
            }
            const index = storyCards.indexOf(data);
            if ((index !== -1) && (index !== (storyCards.length - 1))) {
                // Ensure the data card is always at the bottom of the story cards list
                storyCards.splice(index, 1);
                storyCards.push(data);
            }
            return;
        }
    }
    // This is the only return point within the parent scope of AutoCards
    if (stopPackaged === false) {
        return [codomain, STOP];
    } else {
        return codomain;
    }
} AutoCards(null); function isolateLSIv2(code, log, text, stop) { const console = Object.freeze({log}); try { eval(code); return [null, text, stop]; } catch (error) { return [error, text, stop]; } }

// Your other library scripts go here
// Story Arc Engine Script by Yi1i1i

/* Credits: 
  LewdLeah - Idea for AI calling, debugging, testing, feedback
  Purplejump - Testing, feedback
*/

onLibrary_SAE();
function onLibrary_SAE(){
  // Update settingsSC at start of every hook
  createIfNoSettingsSC();
  retrieveSettingsFromSC();
  storeSettingsToSC();
  
  // Update ArcSC at the start of every hook
  createIfNoArcSC();
  retrieveArcFromSC();
  storeArcToSC();
  
     // ── RELATIONSHIPS CARD ──
  if (!storyCards.find(sc => sc.title === "Relationships")) {
    addStoryCard(
      "Relationships",
      "{}",  
      "JSON map of Name→Score for how much each character likes you."
    );
  }
  const relSC = storyCards.find(sc => sc.title === "Relationships");
  try {
    state.relationships = JSON.parse(relSC.entry);
  } catch {
    state.relationships = {};
  }

  // ── TRAITS CARD ──
  if (!storyCards.find(sc => sc.title === "Traits")) {
    addStoryCard(
      "Traits",
      "{}",  
      "JSON map of Name→[traits] for each character’s personality."
    );
  }
  const traitsSC = storyCards.find(sc => sc.title === "Traits");
  try {
    state.traits = JSON.parse(traitsSC.entry);
  } catch {
    state.traits = {};
  }

  // ── MEMORIES CARD ──
  if (!storyCards.find(sc => sc.title === "Memories")) {
    addStoryCard(
      "Memories",
      "{}",  
      "JSON map of Name→[recent sentences] for each character’s memories."
    );
  }
  const memSC = storyCards.find(sc => sc.title === "Memories");
  try {
    state.memories = JSON.parse(memSC.entry);
  } catch {
    state.memories = {};
  }

  // ── WORLD EVENTS CARD ──
  if (!storyCards.find(sc => sc.title === "World Events")) {
    addStoryCard(
      "World Events",
      JSON.stringify({ current: "Clear skies" }),
      "Tracks the current random world event (weather, war, festival, etc.)"
    );
  }
  const eventsSC = storyCards.find(sc => sc.title === "World Events");
  try {
    state.worldEvent = JSON.parse(eventsSC.entry).current;
  } catch {
    state.worldEvent = "Clear skies";
  }

  // ── HIDDEN QUESTS CARD ──
  if (!storyCards.find(sc => sc.title === "Hidden Quests")) {
    addStoryCard(
      "Hidden Quests",
      JSON.stringify([]),
      "List of active hidden quests unlocked by relationships"
    );
  }
  const questsSC = storyCards.find(sc => sc.title === "Hidden Quests");
  try {
    state.hiddenQuests = JSON.parse(questsSC.entry);
  } catch {
    state.hiddenQuests = [];
  }

  // ── TIME-TRACKER INIT ──
  // ensure manual override counter exists
  if (state.manualHours === undefined) {
    state.manualHours = 0;
  }
}

function onInput_SAE(text){
  text = helpCommandInput(text);

  text = detectRedoStoryArc(text);

  text = detectStopGenerating(text);

  return text;
}
  

function onInput_SAE(text){
  text = helpCommandInput(text);

  text = detectRedoStoryArc(text);

  text = detectStopGenerating(text);

  return text;
}

function onContext_SAE(text){
  text = removeAngleText(text);
  
  text = feedAIPrompt(text);

  text = feedStoryArc(text);
  
  text = logContextToSettingsSC(text);
  //log(text);
  
  return text;
}

function onOutput_SAE(text) {
  text = helpCommandOutput(text);

  text = saveStoryArc(text);
  //log("state.storyArc", state.storyArc);

  text = callAIForArc(text);

  //
  
  
  
  //log(text);

 turnCounter();
 //state.message = JSON.stringify({
 //   turnCount:    state.turnCount,
 //   nextArcCall:  state.unlockFeedAIPrompt,
 //   savingArc:    state.saveOutput,
 //   lastArc:      state.storyArc.slice(0,50) + "…"
 // }, null, 2);

  return text;
}

function helpCommandInput(text){
  if(text.includes("/help sae")){
    text = " ";

    state.commandCenter = 
    `
    << 
    - Story Arc Engine calls the AI to create a story arc in the Author's notes to better guide future storytelling.
    - Type "Story Arc" into story cards to access and modify settings. Logs are logged in the notes.
    - Input "/redo arc" to call the AI to regen the story arc. 
    - Text encased in << >> are auto cleared from context.
    - Repeated attempts for generating story arcs may be due to AI failing to fulfill instructions or low response length (< 125). troubleshoot by stopping and retrying in a few turns.
    >>
    `
  }

  return text;
}

function helpCommandOutput(text){
  if(state.commandCenter){
    text = state.commandCenter;
  }
  delete state.commandCenter
  return text;
}

// Prompt to be fed to AI context
state.arcPrompt = state.arcPrompt || [`
<<</SYSTEM>  
- Stop the story.  
- Only write a structured story arc outline for the future based on everything so far by following these strict instructions:  
- Write a numbered list of 11 major events within the story arc.  
- Each event must be under 7 words.  
- Events must be in chronological order.  
- Each event must build on the last and be further in the future.  
- Dont write clichés, dialogue, description, and prose.  
- Dont write the protagonist, main character, and player.  
- Use only brief, high-level story developments.  
- Events contain turning points, twists, discoveries, conflicts, motives, and lore.  
- Maintain immersion and consistent narrative tone. >>`
];

// Initialize variables
if(state.unlockFeedAIPrompt == undefined){
  state.unlockFeedAIPrompt = false;
}

if(state.saveOutput == undefined){
  state.saveOutput = false;
}

if(state.storyArc == undefined){
  state.storyArc = "";
}

if(state.attemptCounter == undefined){
  state.attemptCounter = 0;
}

state.turnsPerAICall = state.turnsPerAICall || 25;
//log("state.turnsPerAICall: " + state.turnsPerAICall);

// Increment turn counter at end of onOutput
function turnCounter(){
  if (state.turnCount == undefined) {
  state.turnCount = 0;
  }

  state.turnCount += 1;
  //log("state.turnCount: " + state.turnCount);
}

// Remove script texts to clean AI context
function removeAngleText(text) {
  return text.replace(/<<[\s\S]*?>>/g, '');
}

function createIfNoArcSC(){
  if (!storyCards.find(sc => sc.title === "Current Story Arc")) {
    // If sc doesn't exist, create it
    addStoryCard("Current Story Arc", "", "Current Story Arc");

    // Fetch the sc
    const arcSC = storyCards.find(sc => sc.title === "Current Story Arc");
    arcSC.keys = "/Current Story Arc"
    arcSC.description = "SPOILERS! This story card stores the story arc being fed to the AI to improve storytelling. Feel free to modify the contents.";
  }
}

function storeArcToSC(){
  // Fetch the sc
  const arcSC = storyCards.find(sc => sc.title === "Current Story Arc");

  arcSC.entry = state.storyArc;
}

function retrieveArcFromSC(){
  // Fetch the sc
  const arcSC = storyCards.find(sc => sc.title === "Current Story Arc");

  state.storyArc = arcSC.entry;
}

function createIfNoSettingsSC(){
  if (!storyCards.find(sc => sc.title === "Story Arc Settings")) {
    // If sc doesn't exist, create it
    addStoryCard("Story Arc Settings", "", "Story Arc Settings");

    // Fetch the sc
    const settingsSC = storyCards.find(sc => sc.title === "Story Arc Settings");
    settingsSC.description = `
    turnsPerAICall: Number of turns before calling AI to update the story arc. Takes in an integer.
    arcPrompt: Prompt that is fed to the AI to generate a story arc. Must be encased in << >>.
    `;
  }
}

function storeSettingsToSC(){
  // Fetch the sc
  const settingsSC = storyCards.find(sc => sc.title === "Story Arc Settings");

  settingsSC.entry = `turnsPerAICall = ${state.turnsPerAICall}\narcPrompt = ${state.arcPrompt}`
}

function retrieveSettingsFromSC(){
  // Fetch the sc
  const settingsSC = storyCards.find(sc => sc.title === "Story Arc Settings");

  // Extract turnsPerAICall
  const turnsMatch = settingsSC.entry.match(/turnsPerAICall\s*=\s*(\d+)/);
  if (turnsMatch) {
    state.turnsPerAICall = Number(turnsMatch[1]) ?? state.turnsPerAICall;
  }

  // Extract arcPrompt block
  const promptMatch = settingsSC.entry.match(/arcPrompt\s*=\s*(<<[\s\S]*?>>)/);
  if (promptMatch) {
    state.arcPrompt = promptMatch[1];
  }

}

// On output, waits for the correct turn to call AI for generating story arc
function callAIForArc(text){
  if (state.turnCount == 1 || state.turnCount % state.turnsPerAICall === 0) {
    // Warn player of AI call next turn
    text = text + "\n\n<< ⚠️ Updating Story Arc Next Turn! Click 'Continue' or type '/stop'. >>";
    AutoCards().API.postponeEvents(1)
    // Unlock feed prompt to AI for onContext
    state.unlockFeedAIPrompt = true;
    //log("state.unlockFeedAIPrompt: " + state.unlockFeedAIPrompt);

    // Unlock save resulting output to save story arc for next onOutput
    state.saveOutput = true;
   // log("state.saveOutput: " + state.saveOutput);
  }

  return text;
}

// After AI is called, this function will feed the prompt onContext for AI to create a story arc
function feedAIPrompt(text){
  if(state.unlockFeedAIPrompt){
    text = text + " " + state.arcPrompt;

    // Turn off after done feeding
    state.unlockFeedAIPrompt = false;
  }

  return text;
}

// After AI call and prompt is fed to context, this function saves the generated story arc during the following output hook
function saveStoryArc(text){
  if(state.saveOutput){
    // Copy the generated story arc from the output text
    state.storyArc = text;

    // Clean story arc text to ensure no incomplete numbered lines
    //log("Before: ", state.storyArc);
    state.storyArc = state.storyArc.replace(/\n?\d+\.\s*$/, '');
    state.storyArc = state.storyArc
      .split('\n')
      .filter(line => /^\d+\.\s/.test(line.trim()))
      .join('\n');
    //log("After: ", state.storyArc);

    // Incorrect story arc formatting recalls AI
    if(!/[89]/.test(state.storyArc)){
      state.unlockFeedAIPrompt = true;
      state.saveOutput = true;

      state.attemptCounter += 1;

      text = `\n<< ⏳ Generating Story Arc (Attempt ${state.attemptCounter})... Click 'Continue' or type '/stop'. >>`;

    }
    // Correct story arc formatting gets saved
    else {
      state.attemptCounter = 0;

      state.storyArc = "Write the story in the following direction:\n" + state.storyArc;

      text = "\n<< ✅ Story Arc generated and saved! Click 'Continue'. >>\n\n";

      // Fetch the sc and log the previous arc in sc notes
      const arcSC = storyCards.find(sc => sc.title === "Current Story Arc");
      arcSC.description = `Log ${state.turnCount} | Previous Story Arc:\n${arcSC.entry}\n` + arcSC.description;

      // Save the new story arc to the sc
      storeArcToSC();

      // Turn off save output when done saving story arc
      state.saveOutput = false;

    }
  }

  return text;
}

// Feeds the Story Arc into the Author's Note in the AI context every turn
function feedStoryArc(text){
  // Ensure story arc is fed only when a new story arc is not being generated
  if(state.saveOutput == false){
    text = text.replace(
      /(\[Author's note: [\s\S]*?)(])/,
      (_, noteStart, noteEnd) => noteStart + "\n" + state.storyArc + noteEnd
    );
  }

  return text;
}

function detectRedoStoryArc(text){
  if(text.includes("/redo arc")){
    state.unlockFeedAIPrompt = true;
    state.saveOutput = true;

    text = "<< ➰ Regenerating Story Arc... >>"
  }

  return text;
}

// Function to allow player to stop story arc generating
function detectStopGenerating(text){
  if(text.includes("/stop") && state.unlockFeedAIPrompt == true){
    state.unlockFeedAIPrompt = false;
    state.saveOutput = false;

    state.attemptCounter = 0;

    text = "<< ⛔ Story Arc Generation Stopped. >>";
  }

  return text;
}

function logContextToSettingsSC(text){
  // Fetch the sc
  const settingsSC = storyCards.find(sc => sc.title === "Story Arc Settings");
  
  // Trim notes on char limit to prevent memory overfill
  if(settingsSC.description.length > 5000){
    halfIndex = Math.floor(settingsSC.description.length / 2);
    settingsSC.description = settingsSC.description.slice(0, halfIndex);

    console.log("Trimming description to prevent memory overload.");
  }

  // Log to setting sc notes
  settingsSC.description = `Context Log ${state.turnCount} | ${text}\n` + settingsSC.description;

  return text;
}


// Library Script: Character System for Civilians & Pet-Vamp in Night Huntress





