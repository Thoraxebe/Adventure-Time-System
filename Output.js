const modifier = (text) => {
  // First: Run the original ATS output processing (stats, formatting, etc.)
  try { if (typeof ATS_onOutput === 'function') text = ATS_onOutput(text); } catch (_) {}

  // Then: Our time advancement logic (LLM tag handling)
  // 1. Did we already advance time this turn via input/command/regex?
  const alreadyAdvanced = ATS.pendingMinutes > 0 ||
    (ATS.history?.stack?.length > 0 &&
     ATS.history.stack[ATS.history.stack.length - 1]?.applied > 0 &&
     ATS.history.stack[ATS.history.stack.length - 1]?.source !== 'llm_output');

  // 2. Aggressive cleanup of any stray/leftover tags (safety net)
  text = text.replace(/\[ATS_TIME_ADVANCE:[^\]]*\]/gi, '').trim();
  text = text.replace(/ATS_TIME_ADVANCE\s*:\s*\d+/gi, '');

  // 3. Only parse for time advance tag if NO time was advanced yet
  if (!alreadyAdvanced) {
    // Flexible regex: allows minor formatting variations, units, etc.
    const match = text.match(/\[?\s*ATS_TIME_ADVANCE\s*:\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|m|h(?:our)?s?|d(?:ay)?s?)?\s*\]?\s*$/i);

    if (match) {
      let value = parseFloat(match[1]);
      let unit = (match[2] || 'm').toLowerCase().charAt(0);

      let minutes = value;
      if (unit === 'h') minutes *= 60;
      if (unit === 'd') minutes *= 1440;

      // Safety limits: 1 minute minimum, 1 week maximum
      if (minutes >= 1 && minutes <= 10080) {
        try {
          tickMinutes(minutes);
          recordAdvance(minutes, 'llm_output');
          // Remove the matched tag from the visible text
          text = text.replace(match[0], '').trimEnd();
        } catch (e) {
          console.error("LLM time advance failed:", e);
        }
      }
    }
  }

  // Final extra cleanup pass (in case model did something weird)
  text = text.replace(/\[ATS_TIME_ADVANCE:[^\]]*\]/gi, '').trim();

  return { text };
};
modifier(text);
