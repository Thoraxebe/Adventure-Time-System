const modifier = (text) => {
  try { if (typeof ATS_onOutput === 'function') text = ATS_onOutput(text); } catch (_) {}
  return { text };
};
modifier(text);
