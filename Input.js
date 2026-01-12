const modifier = (text) => {
  try { if (typeof ATS_timeCommand === 'function') text = ATS_timeCommand(text); } catch (_) {}
  try { if (typeof ATS_onInput === 'function') text = ATS_onInput(text); } catch (_) {}
  return { text };
};
modifier(text);
