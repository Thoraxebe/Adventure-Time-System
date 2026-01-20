// Initialize Inner-Self for output processing
InnerSelf("output");

// Combined ATS + Inner-Self output modifier
const modifier = (text) => {
  // 1. First run the main ATS output processing
  //    (handles formatting, stats, banner updates, etc.)
  try {
    if (typeof ATS_onOutput === 'function') {
      text = ATS_onOutput(text);
    }
  } catch (_) {}

  // 2. ATS time advancement logic from LLM output
  //    (only if no time was advanced earlier in the turn)
  const alreadyAdvanced = ATS.pendingMinutes > 0 ||
    (ATS.history?.stack?.length > 0 &&
     ATS.history.stack[ATS.history.stack.length - 1]?.applied > 0 &&
     ATS.history.stack[ATS.history.stack.length - 1]?.source !== 'llm_output');

  // Aggressive cleanup of any stray time advance tags
  text = text.replace(/\[ATS_TIME_ADVANCE:[^\]]*\]/gi, '');
  text = text.replace(/ATS_TIME_ADVANCE\s*:\s*\d+/gi, '');

  // Parse for time advance only if nothing advanced yet
  if (!alreadyAdvanced) {
    // Flexible regex for various formats the model might use
    const match = text.match(/\[?\s*ATS_TIME_ADVANCE\s*:\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|m|h(?:our)?s?|d(?:ay)?s?)?\s*\]?\s*$/i);
    
    if (match) {
      let value = parseFloat(match[1]);
      let unit = (match[2] || 'm').toLowerCase().charAt(0);
      let minutes = value;

      if (unit === 'h') minutes *= 60;
      if (unit === 'd') minutes *= 1440;

      // Safety limits: 1 min minimum, 1 week maximum
      if (minutes >= 1 && minutes <= 10080) {
        try {
          tickMinutes(minutes);
          recordAdvance(minutes, 'llm_output');
          // Remove the tag from visible output
          text = text.replace(match[0], '').trim();
        } catch (e) {
          console.error("LLM time advance failed:", e);
        }
      }
    }
  }

  // Final cleanup pass
  text = text.replace(/\[ATS_TIME_ADVANCE:[^\]]*\]/gi, '');

  // Inner-Self output modifications are applied automatically after InnerSelf("output")
  // → no extra call is usually needed here

  return { text };
};

modifier(text);
