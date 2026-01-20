const modifier = (text) => {

  try { if (typeof ATS_timeCommand === 'function') text = ATS_timeCommand(text); } catch (_) {}

  // Skip natural language time parsing if a slash command was already handled
  if (!ATS.cmd || !ATS.cmd.suppressLLM) {
    try { if (typeof ATS_onInput === 'function') text = ATS_onInput(text); } catch (_) {}
  }

  return { text };
};
modifier(text);
