// Initialize both systems for input processing
InnerSelf("input");

// ATS input modifier (handles time commands and natural language time parsing)
const modifier = (text) => {
  // 1. ATS time command handling (slash commands like /time add, /tick, etc.)
  try {
    if (typeof ATS_timeCommand === 'function') {
      text = ATS_timeCommand(text);
    }
  } catch (_) {}

  // 2. Skip natural language parsing if a command was already processed
  if (!ATS?.cmd || !ATS.cmd.suppressLLM) {
    try {
      if (typeof ATS_onInput === 'function') {
        text = ATS_onInput(text);
      }
    } catch (_) {}
  }

  // 3. InnerSelf input modifications are applied automatically after InnerSelf("input")
  //    → in most versions no extra call is needed here

  return { text };
};

modifier(text);
