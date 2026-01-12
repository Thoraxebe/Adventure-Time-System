/// <reference no-default-lib="true"/>
/// <reference lib="es2022"/>

/*
  =========================================================================
  AI Dungeon — HUD: Time & Calendar (Auto)
  VERSION: 4.19.10h-patched-refactored (removed redundancy, modularized)
  - Centralized config init and helpers in Library.js
  - Namespaced functions: ATS.utils, ATS.clock, ATS.calendar, ATS.parser
  - Moved age calc to ATS.calendar.collectCharactersWithAge()
  - Consolidated parsing, event checks, and banner logic
  - Added hooks for extensibility
  =========================================================================
*/

/* Bootstrap ATS state (ES5-safe) */
(function(){
  if (!state._ats) {
    state._ats = {
      version: '4.19.10h-patched-refactored',
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
        dawnHour: 5,
        dawnMinute: 30,
        duskHour: 19,
        duskMinute: 15,
        contextFlavor: 'neutral',
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

// Report buffer for slash commands
if (!ATS.cmd) ATS.cmd = { suppressLLM: false, lines: [] };

// Namespaces for modularity
ATS.utils = {};
ATS.clock = {};
ATS.calendar = {};
ATS.parser = {};
ATS.hooks = { onTick: [] }; // For custom extensions

// Central init (called on bootstrap or reset)
ATS.init = function() {
  // Build name maps
  ATS._namesMaps = ATS._namesMaps || {};
  var N = ATS.config.names || {
    months: ["January","February","March","April","May","June","July","August","September","October","November","December"],
    weekdays: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
    aliases: { months: {}, weekdays: {} }
  };
  ATS._namesMaps.monthNameMap = {};
  N.months.forEach(function(name, i) { ATS._namesMaps.monthNameMap[name.toLowerCase()] = i + 1; });
  Object.keys(N.aliases.months).forEach(function(alias) { ATS._namesMaps.monthNameMap[alias.toLowerCase()] = ATS._namesMaps.monthNameMap[N.aliases.months[alias].toLowerCase()]; });
  ATS._namesMaps.weekdayNameMap = {};
  N.weekdays.forEach(function(name, i) { ATS._namesMaps.weekdayNameMap[name.toLowerCase()] = i; });
  Object.keys(N.aliases.weekdays).forEach(function(alias) { ATS._namesMaps.weekdayNameMap[alias.toLowerCase()] = ATS._namesMaps.weekdayNameMap[N.aliases.weekdays[alias].toLowerCase()]; });

  // Init cards if needed
  ATS.cards.timeIdx = ATS.utils.findCardIndexByMarker(ATS_MARKER_TIME);
  ATS.cards.settingsIdx = ATS.utils.findCardIndexByMarker(ATS_MARKER_SETTINGS);
  ATS.cards.calendarIdx = ATS.utils.findCalendarIndexByMarkerOrKey();
};
ATS.init();

// --- Utils ---
ATS.utils.pad2 = function(n) { n = n | 0; return (n < 10 ? "0" + n : String(n)); };
ATS.utils.clamp = function(n, min, max) { return n < min ? min : (n > max ? max : n); };
ATS.utils.prependWithNewline = function(block, body) {
  var lead = body.startsWith("\n") ? "" : "\n";
  var b = String(block || "").replace(/\s+$/, "");
  return lead + b + "\n" + body;
};
ATS.utils.getBodyText = function(obj) {
  return String((obj && (obj.value != null ? obj.value : (obj.entry != null ? obj.entry : (obj.text != null ? obj.text : "")))) || "");
};
ATS.utils.embedMarkerOnce = function(body, marker) {
  body = String(body || "");
  if (body.indexOf(marker) !== -1) return body;
  return marker + "\n" + body;
};
ATS.utils.findCardIndexByMarker = function(marker) {
  if (!Array.isArray(worldInfo)) return null;
  for (var i = 0; i < worldInfo.length; i++) {
    var wi = worldInfo[i]; if (!wi) continue;
    var body = ATS.utils.getBodyText(wi);
    if (body && body.indexOf(marker) !== -1) return i;
  }
  return null;
};
ATS.utils.findCalendarIndexByMarkerOrKey = function() {
  var idx = ATS.utils.findCardIndexByMarker(ATS_MARKER_CAL_AUTO);
  if (idx != null) return idx;
  if (!Array.isArray(worldInfo)) return null;
  for (var i = 0; i < worldInfo.length; i++) {
    var wi = worldInfo[i]; if (!wi) continue;
    if (String(wi.keys || "") === "__hud_calendar__") return i;
  }
  return null;
};
ATS.utils.moveIndexToPosition = function(fromIdx, toIdx) {
  try {
    if (!Array.isArray(worldInfo)) return;
    if (fromIdx == null || fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= worldInfo.length) return;
    var item = worldInfo.splice(fromIdx, 1)[0];
    worldInfo.splice(Math.min(toIdx, worldInfo.length), 0, item);
  } catch (e) {}
};
ATS.utils.shouldShowNextHolidayLine = function(days) {
  var MIN_DAYS_AHEAD = 1;
  var MAX_DAYS_AHEAD = 7;
  return typeof days === "number" && days >= MIN_DAYS_AHEAD && days <= MAX_DAYS_AHEAD;
};
ATS.utils.createOrUpdateTimeCard = function() {
  var c = ATS.clock;
  var wd = ATS.clock.weekdayNameLong(c.year, c.month, c.day);
  var mn = ATS.clock.monthNameLong(c.month);
  var iso = c.year + "-" + ATS.utils.pad2(c.month) + "-" + ATS.utils.pad2(c.day);
  var time = ATS.utils.pad2(c.hour) + ":" + ATS.utils.pad2(c.minute);
  var moon = ATS.calendar.describeMoonPhase(c.year, c.month, c.day);
  var body = iso + " " + time + "\n" + wd + ", " + mn + " " + c.day + ", " + c.year + "\nMoon: " + moon;
  var idx = ATS.cards.timeIdx;
  if (idx == null) {
    worldInfo.push({ keys: "__hud_time__", entry: ATS.utils.embedMarkerOnce(body, ATS_MARKER_TIME), hidden: true });
    ATS.cards.timeIdx = worldInfo.length - 1;
  } else {
    worldInfo[idx].entry = ATS.utils.embedMarkerOnce(body, ATS_MARKER_TIME);
  }
};
ATS.utils.createOrUpdateCalendarCard = function() {
  var body = "";
  // Build calendar body with holidays, events, etc.
  var idx = ATS.cards.calendarIdx;
  if (idx == null) {
    worldInfo.push({ keys: "__hud_calendar__", entry: ATS.utils.embedMarkerOnce(body, ATS_MARKER_CAL_AUTO), hidden: true });
    ATS.cards.calendarIdx = worldInfo.length - 1;
  } else {
    worldInfo[idx].entry = ATS.utils.embedMarkerOnce(body, ATS_MARKER_CAL_AUTO);
  }
};

// --- Clock ---
ATS.clock.isLeapYear = function(y) { return (y % 4 === 0) && ((y % 100 !== 0) || (y % 400 === 0)); };
ATS.clock.daysInMonth = function(y, m) { var L = [31, (ATS.clock.isLeapYear(y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; return L[m - 1]; };
ATS.clock.weekdayIndex = function(y, m, d) { var t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]; if (m < 3) y -= 1; return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7; };
ATS.clock.weekdayNameLong = function(y, m, d) {
  var names = ATS.config.names.weekdays;
  return names[ATS.clock.weekdayIndex(y, m, d)];
};
ATS.clock.monthNameLong = function(m) {
  var months = ATS.config.names.months;
  m = (m | 0);
  return months[(m - 1 + 12) % 12];
};
ATS.clock.formatLongDateLine = function(y, m, d) {
  var wd = ATS.clock.weekdayNameLong(y, m, d);
  var mn = ATS.clock.monthNameLong(m);
  return wd + ', ' + mn + ' ' + ATS.utils.pad2(d) + ', ' + y;
};
ATS.clock.formatClockShort = function() {
  var c = ATS.clock;
  return (c.year + "-" + ATS.utils.pad2(c.month) + "-" + ATS.utils.pad2(c.day) + " " + ATS.utils.pad2(c.hour) + ":" + ATS.utils.pad2(c.minute));
};
ATS.clock.fmtDelta = function(mins) {
  mins = Math.round(Number(mins) || 0);
  var sign = mins >= 0 ? '+' : '-';
  var m = Math.abs(mins);
  var h = Math.floor(m / 60), mm = m % 60;
  return sign + (h > 0 ? (h + 'h' + (mm ? mm + 'm' : '')) : (mm + 'm'));
};
ATS.clock.advanceMinutes = function(mins) {
  mins = Number(mins) || 0;
  if (mins <= 0) return false;
  var c = ATS.clock;
  c.minute += mins;
  while (c.minute >= 60) { c.minute -= 60; c.hour += 1; }
  while (c.hour >= 24) { c.hour -= 24; c.day += 1; }
  while (c.day > ATS.clock.daysInMonth(c.year, c.month)) { c.day -= ATS.clock.daysInMonth(c.year, c.month); c.month += 1; }
  while (c.month > 12) { c.month -= 12; c.year += 1; }
  c.elapsedMinutes += mins;
  return true;
};
ATS.clock.tick = function() {
  var changed = false;
  if (ATS.pendingMinutes > 0) {
    changed = ATS.clock.advanceMinutes(ATS.pendingMinutes);
    ATS.pendingMinutes = 0;
  } else if (!ATS.appliedFromTextThisTurn) {
    changed = ATS.clock.advanceMinutes(ATS.clock.minutesPerTurn);
  }
  if (changed) {
    ATS._tickChangedThisTurn = true;
    ATS.utils.createOrUpdateTimeCard();
    ATS.calendar.updateToday();
    ATS.hooks.onTick.forEach(function(fn) { try { fn(); } catch (_) {} });
  }
  return changed;
};
ATS.clock.setClock = function(y, m, d, h, min) {
  var c = ATS.clock;
  c.year = y;
  c.month = m;
  c.day = d;
  c.hour = h;
  c.minute = min;
  ATS.utils.createOrUpdateTimeCard();
  ATS.calendar.updateToday();
};

// --- Calendar (Gregorian JDN, Islamic, Chinese approx, Moon) ---
ATS.calendar.gregorianToJDN = function(y, m, d) {
  var a = Math.floor((14 - m) / 12);
  var y2 = y + 4800 - a;
  var m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
};
ATS.calendar.ISLAMIC_EPOCH = 1948439;
ATS.calendar.islamicToJDN = function(y, m, d) { return d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + Math.floor((3 + 11 * y) / 30) + ATS.calendar.ISLAMIC_EPOCH - 1; };
ATS.calendar.jdnToIslamic = function(jd) {
  var jd2 = Math.floor(jd) + 0.5;
  var y = Math.floor((30 * (jd2 - ATS.calendar.ISLAMIC_EPOCH) + 10646) / 10631);
  var m = Math.min(12, Math.ceil((jd2 - ATS.calendar.islamicToJDN(y, 1, 1)) / 29.5) + 1);
  var d = Math.floor(jd2 - ATS.calendar.islamicToJDN(y, m, 1)) + 1;
  return { year: y, month: m, day: d };
};
ATS.calendar.islamicMonthName = function(m) {
  var names = ["Muharram", "Safar", "Rabi’ al-awwal", "Rabi’ al-thani", "Jumada al-awwal", "Jumada al-thani", "Rajab", "Sha’ban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"];
  return names[(m - 1) % 12];
};
ATS.calendar.describeIslamicLunarLine = function(y, m, d) {
  var jdn = ATS.calendar.gregorianToJDN(y, m, d);
  var isl = ATS.calendar.jdnToIslamic(jdn);
  return isl.day + " " + ATS.calendar.islamicMonthName(isl.month) + " " + isl.year + " AH";
};
ATS.calendar.NM_EPOCH = 2451550.09765;
ATS.calendar.SYNODIC = 29.530588861;
ATS.calendar.firstNewMoonOnOrAfter = function(jd) { var k = Math.ceil((jd - ATS.calendar.NM_EPOCH) / ATS.calendar.SYNODIC); return ATS.calendar.NM_EPOCH + k * ATS.calendar.SYNODIC; };
ATS.calendar.newMoonBefore = function(jd) { var k = Math.floor((jd - ATS.calendar.NM_EPOCH) / ATS.calendar.SYNODIC); return ATS.calendar.NM_EPOCH + k * ATS.calendar.SYNODIC; };
ATS.calendar.approximateCNY_JDN = function(year) {
  var solsticeJDN = ATS.calendar.gregorianToJDN(year - 1, 12, 21);
  var nm1 = ATS.calendar.firstNewMoonOnOrAfter(solsticeJDN);
  var nm2 = nm1 + ATS.calendar.SYNODIC;
  return Math.floor(nm2 + 0.5);
};
ATS.calendar.sexagenaryYearName = function(chYear) {
  var stems = ["Jia","Yi","Bing","Ding","Wu","Ji","Geng","Xin","Ren","Gui"];
  var branches = ["Zi (Rat)","Chou (Ox)","Yin (Tiger)","Mao (Rabbit)","Chen (Dragon)","Si (Snake)","Wu (Horse)","Wei (Goat)","Shen (Monkey)","You (Rooster)","Xu (Dog)","Hai (Pig)"];
  var idx = (chYear - 1984) % 60; if (idx < 0) idx += 60;
  var stem = stems[idx % 10];
  var branch = branches[idx % 12];
  return stem + "-" + branch;
};
ATS.calendar.describeChineseLunisolarApprox = function(y, m, d) {
  var jdn = ATS.calendar.gregorianToJDN(y, m, d);
  var cnyThis = ATS.calendar.approximateCNY_JDN(y);
  var lunarYear = y;
  var cnyStart = cnyThis;
  if (jdn < cnyThis) { lunarYear = y - 1; cnyStart = ATS.calendar.approximateCNY_JDN(y - 1); }
  var monthsSinceCNY = Math.floor((jdn - cnyStart) / ATS.calendar.SYNODIC);
  if (monthsSinceCNY < 0) monthsSinceCNY = 0;
  var monthStart = cnyStart + monthsSinceCNY * ATS.calendar.SYNODIC;
  var lunarMonth = monthsSinceCNY + 1;
  var lunarDay = Math.floor(jdn - Math.floor(monthStart + 0.5)) + 1;
  // Approximate leap month: if lunarMonth > 12, it's leap (simplified)
  if (lunarMonth > 12) lunarMonth = 'Leap ' + (lunarMonth - 12);
  return lunarDay + " day of month " + lunarMonth + ", " + ATS.calendar.sexagenaryYearName(lunarYear);
};
ATS.calendar.moonPhaseNames = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous", "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"];
ATS.calendar.describeMoonPhase = function(y, m, d) {
  var jdn = ATS.calendar.gregorianToJDN(y, m, d);
  var nm = ATS.calendar.newMoonBefore(jdn + 1);
  var phase = Math.floor(((jdn - nm) / ATS.calendar.SYNODIC) * 8) % 8;
  return ATS.calendar.moonPhaseNames[phase];
};

// Character age support (moved from Context.js)
ATS.calendar.parseISODateToYMD = function(s) {
  if (typeof s !== "string") return null;
  s = s.trim();
  if (s.length !== 10 || s.charAt(4) !== "-" || s.charAt(7) !== "-") return null;
  var Y = parseInt(s.slice(0, 4), 10),
      M = parseInt(s.slice(5, 7), 10),
      D = parseInt(s.slice(8, 10), 10);
  if (isNaN(Y) || isNaN(M) || isNaN(D)) return null;
  if (M < 1 || M > 12) return null;
  return { y: Y, m: M, d: D };
};
ATS.calendar.computeAgeOnDate = function(dobY, dobM, dobD, curY, curM, curD) {
  var age = curY - dobY;
  if (curM < dobM || (curM === dobM && curD < dobD)) age -= 1;
  return age < 0 ? 0 : age;
};
ATS.calendar.collectCharactersWithAge = function() {
  var result = [];
  try {
    if (!Array.isArray(worldInfo)) return result;
    for (var i = 0; i < worldInfo.length; i++) {
      var wi = worldInfo[i]; if (!wi) continue;
      var body = ATS.utils.getBodyText(wi);
      var notes = String(wi.notes || wi.description || wi.desc || "");
      var scan = body + "\n" + notes;
      var m = scan.match(/^\s*DOB\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/mi);
      if (!m) continue;
      var dob = ATS.calendar.parseISODateToYMD(m[1]); if (!dob) continue;
      var name = String(wi.title || wi.keys || "").trim();
      if (!name) name = "Character";
      var c = ATS.clock;
      if (!c) continue;
      var age = ATS.calendar.computeAgeOnDate(dob.y, dob.m, dob.d, c.year, c.month, c.day);
      var dobISO = dob.y + "-" + ATS.utils.pad2(dob.m) + "-" + ATS.utils.pad2(dob.d);
      result.push({ name: name, dobISO: dobISO, age: age });
    }
  } catch (_) {}
  return result;
};

// Event and Holiday Parsing (from worldInfo)
ATS.calendar.parseDate = function(s) {
  if (typeof s !== "string") return null;
  var parts = s.split("-").map(Number);
  if (parts.length !== 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) return null;
  return { y: parts[0], m: parts[1], d: parts[2] };
};
ATS.calendar.parseEventsFromWorldInfo = function() {
  ATS.calendar.holidays = [];
  ATS.calendar.recHolidays = [];
  ATS.calendar.events = [];
  ATS.calendar.eventsRanges = [];
  ATS.calendar.recEvents = [];
  if (!Array.isArray(worldInfo)) return;
  for (var i = 0; i < worldInfo.length; i++) {
    var wi = worldInfo[i]; if (!wi) continue;
    var body = ATS.utils.getBodyText(wi);
    var lines = body.split(/\r?\n/);
    lines.forEach(function(line) {
      line = line.trim();
      if (line.startsWith("//") || !line) return;
      var parts = line.split(/\s+/);
      var type = parts[0].toLowerCase();
      var name = parts.slice(2).join(" ");
      if (type === "holiday") {
        var date = ATS.calendar.parseDate(parts[1]);
        if (date) ATS.calendar.holidays.push({ date: date, name: name });
      } else if (type === "rec_holiday") {
        var md = parts[1].split("-").map(Number);
        if (md.length === 2) ATS.calendar.recHolidays.push({ month: md[0], day: md[1], name: name });
      } else if (type === "event") {
        var date = ATS.calendar.parseDate(parts[1]);
        if (date) ATS.calendar.events.push({ date: date, name: name });
      } else if (type === "event_range") {
        var start = ATS.calendar.parseDate(parts[1]);
        var end = ATS.calendar.parseDate(parts[2]);
        if (start && end) ATS.calendar.eventsRanges.push({ start: start, end: end, name: parts.slice(3).join(" ") });
      } else if (type === "rec_event") {
        var md = parts[1].split("-").map(Number);
        if (md.length === 2) ATS.calendar.recEvents.push({ month: md[0], day: md[1], name: name });
      }
    });
  }
  ATS.utils.createOrUpdateCalendarCard();
};
ATS.calendar.isDateEqual = function(d1, d2) {
  return d1.y === d2.y && d1.m === d2.m && d1.d === d2.d;
};
ATS.calendar.dateToJDN = ATS.calendar.gregorianToJDN;
ATS.calendar.daysBetween = function(d1, d2) {
  return ATS.calendar.dateToJDN(d2.y, d2.m, d2.d) - ATS.calendar.dateToJDN(d1.y, d1.m, d1.d);
};
ATS.calendar.updateToday = function() {
  var c = ATS.clock;
  var todayDate = { y: c.year, m: c.month, d: c.day };
  var today = ATS.calendar.today;
  today.holidays = [];
  ATS.calendar.holidays.forEach(function(h) {
    if (ATS.calendar.isDateEqual(h.date, todayDate)) today.holidays.push(h.name);
  });
  ATS.calendar.recHolidays.forEach(function(rh) {
    if (rh.month === c.month && rh.day === c.day) today.holidays.push(rh.name);
  });
  today.eventsToday = [];
  ATS.calendar.events.forEach(function(e) {
    if (ATS.calendar.isDateEqual(e.date, todayDate)) today.eventsToday.push(e.name);
  });
  ATS.calendar.recEvents.forEach(function(re) {
    if (re.month === c.month && re.day === c.day) today.eventsToday.push(re.name);
  });
  today.ongoing = null;
  ATS.calendar.eventsRanges.forEach(function(er) {
    var startJDN = ATS.calendar.dateToJDN(er.start.y, er.start.m, er.start.d);
    var endJDN = ATS.calendar.dateToJDN(er.end.y, er.end.m, er.end.d);
    var todayJDN = ATS.calendar.dateToJDN(todayDate.y, todayDate.m, todayDate.d);
    if (todayJDN >= startJDN && todayJDN <= endJDN) {
      if (!today.ongoing) today.ongoing = [];
      today.ongoing.push(er.name);
    }
  });
  today.next = null;
  today.nextHoliday = null;
  today.nextHolidayDays = null;
  // Find next holiday/event (scan forward)
  var nextDays = 1;
  while (nextDays < 30) {
    var nextDate = { y: c.year, m: c.month, d: c.day + nextDays };
    while (nextDate.d > ATS.clock.daysInMonth(nextDate.y, nextDate.m)) {
      nextDate.d -= ATS.clock.daysInMonth(nextDate.y, nextDate.m);
      nextDate.m += 1;
      if (nextDate.m > 12) { nextDate.m = 1; nextDate.y += 1; }
    }
    var hasEvent = false;
    ATS.calendar.events.forEach(function(e) {
      if (ATS.calendar.isDateEqual(e.date, nextDate)) { hasEvent = true; if (!today.next) today.next = []; today.next.push(e.name); }
    });
    ATS.calendar.recEvents.forEach(function(re) {
      if (re.month === nextDate.m && re.day === nextDate.d) { hasEvent = true; if (!today.next) today.next = []; today.next.push(re.name); }
    });
    ATS.calendar.holidays.forEach(function(h) {
      if (ATS.calendar.isDateEqual(h.date, nextDate)) { hasEvent = true; if (!today.nextHoliday) today.nextHoliday = []; today.nextHoliday.push(h.name); today.nextHolidayDays = nextDays; }
    });
    ATS.calendar.recHolidays.forEach(function(rh) {
      if (rh.month === nextDate.m && rh.day === nextDate.d) { hasEvent = true; if (!today.nextHoliday) today.nextHoliday = []; today.nextHoliday.push(rh.name); today.nextHolidayDays = nextDays; }
    });
    if (hasEvent) break;
    nextDays++;
  }
};

// --- Parser ---
ATS.parser.pushReport = function(line) {
  line = String(line || "").trim();
  if (!line) return;
  ATS.cmd.lines.push(line);
  ATS.cmd.suppressLLM = true;
  ATS.pendingMinutes = 0;
};
ATS.parser.parseNaturalLanguageTime = function(text) {
  text = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  var mins = 0;
  if (text.match(/\bnext\s+day\b/)) mins = 1440;
  else if (text.match(/\bnext\s+week\b/)) mins = 10080;
  else if (text.match(/\bnext\s+month\b/)) mins = ATS.config.monthDaysApprox * 1440;
  else if (text.match(/\bnext\s+year\b/)) mins = ATS.config.yearDaysApprox * 1440;
  else if (text.match(/\ba\s+little\s+while\b/)) mins = ATS.config.idioms.littleWhileMinutes;
  else if (text.match(/\bseveral\s+minutes\b/)) mins = ATS.config.idioms.severalMinutes;
  else if (text.match(/\bwait\s+a\s+minute\b/)) mins = 1; // Idiom, but literal
  else if (text.match(/\bin\s+(\d+)\s+minute(s?)\b/)) mins = parseInt(RegExp.$1);
  else if (text.match(/\bin\s+(\d+)\s+hour(s?)\b/)) mins = parseInt(RegExp.$1) * 60;
  else if (text.match(/\bin\s+(\d+)\s+day(s?)\b/)) mins = parseInt(RegExp.$1) * 1440;
  else if (text.match(/\bin\s+(\d+)\s+week(s?)\b/)) mins = parseInt(RegExp.$1) * 10080;
  else if (text.match(/\buntil\s+tomorrow\b/)) mins = (24 - ATS.clock.hour) * 60 - ATS.clock.minute;
  else if (text.match(/\buntil\s+morning\b/)) {
    var target = ATS.config.morningHour * 60;
    mins = target - (ATS.clock.hour * 60 + ATS.clock.minute);
    if (mins <= 0) mins += 1440;
  }
  // Add more phrases as needed
  mins = ATS.utils.clamp(mins, 0, ATS.config.nlMaxMinutesCap);
  if (mins > 0) ATS.pendingMinutes = mins;
  return mins > 0;
};
ATS.parser.handleCommand = function(text) {
  if (!text.startsWith("/")) return text;
  var args = text.slice(1).trim().split(/\s+/);
  var cmd = args.shift().toLowerCase();
  if (cmd !== "time" && cmd !== "ats") return text;
  var subcmd = (args.shift() || "").toLowerCase();
  if (subcmd === "add") {
    var mins = parseInt(args[0]);
    if (!isNaN(mins)) {
      ATS.pendingMinutes += mins;
      ATS.parser.pushReport("Time advanced by " + ATS.clock.fmtDelta(mins));
    }
  } else if (subcmd === "set") {
    var dateTime = args.join(" ");
    var parts = dateTime.split(" ");
    if (parts.length >= 2) {
      var dateParts = parts[0].split("-").map(Number);
      var timeParts = parts[1].split(":").map(Number);
      if (dateParts.length === 3 && timeParts.length === 2) {
        ATS.clock.setClock(dateParts[0], dateParts[1], dateParts[2], timeParts[0], timeParts[1]);
        ATS.parser.pushReport("Time set to " + ATS.clock.formatClockShort());
      }
    }
  } else if (subcmd === "report") {
    ATS.parser.pushReport("Current time: " + ATS.clock.formatClockShort());
    ATS.parser.pushReport("Holidays today: " + (ATS.calendar.today.holidays.join(", ") || "None"));
    ATS.parser.pushReport("Events today: " + (ATS.calendar.today.eventsToday.join(", ") || "None"));
  } else if (subcmd === "reset") {
    ATS.clock.year = 2025; ATS.clock.month = 11; ATS.clock.day = 28; ATS.clock.hour = 8; ATS.clock.minute = 0;
    ATS.init();
    ATS.calendar.parseEventsFromWorldInfo();
    ATS.parser.pushReport("ATS reset to default state.");
  } else if (subcmd === "config") {
    // Handle config changes, e.g., /ats config showDailyBanner false
    var key = args[0];
    var value = args[1];
    if (key in ATS.config) {
      ATS.config[key] = JSON.parse(value); // Simple parse
      ATS.parser.pushReport("Config updated: " + key + " = " + value);
    }
  } else {
    ATS.parser.pushReport("ATS Commands: add <mins>, set <YYYY-MM-DD HH:MM>, report, reset, config <key> <value>");
  }
  return ""; // Suppress original input
};

// --- Banner ---
ATS.calendar.renderDailyBanner = function() {
  if (!ATS.config.showDailyBanner) return "";
  var c = ATS.clock;
  var iso = c.year + "-" + ATS.utils.pad2(c.month) + "-" + ATS.utils.pad2(c.day);
  if (ATS.dailyBanner.lastISO === iso && !ATS._debugBannerNext) return "";
  ATS.dailyBanner.lastISO = iso;
  var bannerLines = [];
  if (ATS.config.bannerDateStyle === "long") {
    bannerLines.push(ATS.clock.formatLongDateLine(c.year, c.month, c.day));
  } else {
    bannerLines.push(iso);
  }
  if (ATS.config.bannerShowHolidays && ATS.calendar.today.holidays.length > 0) {
    bannerLines.push("Holidays: " + ATS.calendar.today.holidays.join(", "));
  }
  if (ATS.config.bannerShowEvents) {
    if (ATS.calendar.today.eventsToday.length > 0) {
      bannerLines.push("Events: " + ATS.calendar.today.eventsToday.join(", "));
    }
    if (ATS.calendar.today.ongoing) {
      bannerLines.push("Ongoing: " + ATS.calendar.today.ongoing.join(", "));
    }
    if (ATS.calendar.today.next) {
      bannerLines.push("Next event in " + ATS.calendar.today.nextHolidayDays + " days: " + ATS.calendar.today.next.join(", "));
    }
  }
  if (ATS.config.bannerShowMoon) {
    bannerLines.push("Moon: " + ATS.calendar.describeMoonPhase(c.year, c.month, c.day));
  }
  if (ATS.config.showIslamic) {
    bannerLines.push("Islamic: " + ATS.calendar.describeIslamicLunarLine(c.year, c.month, c.day));
  }
  if (ATS.config.showChinese) {
    bannerLines.push("Chinese (approx): " + ATS.calendar.describeChineseLunisolarApprox(c.year, c.month, c.day));
  }
  var banner = bannerLines.join("\n");
  if (ATS.config.bannerCompact) banner = banner.replace(/\n/g, " | ");
  ATS._debugBannerNext = null;
  return banner;
};

// --- Modifier Hooks ---
globalThis.ATS_timeCommand = ATS.parser.handleCommand;
globalThis.ATS_onInput = function(text) {
  ATS.appliedFromTextThisTurn = ATS.parser.parseNaturalLanguageTime(text);
  return text;
};
globalThis.ATS_onOutput = function(text) {
  ATS.clock.tick();
  var banner = ATS.calendar.renderDailyBanner();
  if (banner && !ATS._bannerPrintedThisTurn) {
    text = ATS.utils.prependWithNewline(banner, text);
    ATS._bannerPrintedThisTurn = true;
  }
  if (ATS.cmd.lines.length > 0) {
    text = ATS.utils.prependWithNewline(ATS.cmd.lines.join("\n"), text);
    ATS.cmd.lines = [];
  }
  ATS.appliedFromTextThisTurn = false;
  ATS._tickChangedThisTurn = false;
  ATS._bannerPrintedThisTurn = false;
  return text;
};

// Markers
var ATS_MARKER_TIME = "[[ATS:TIME]]";
var ATS_MARKER_SETTINGS = "[[ATS:SETTINGS]]";
var ATS_MARKER_CAL_AUTO = "[[ATS AUTO CONTEXT]]";

// Run on load
ATS.calendar.parseEventsFromWorldInfo();
