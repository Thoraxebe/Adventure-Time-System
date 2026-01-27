const modifier = (text) => {
  // First: Run the original ATS output processing (stats, formatting, etc.)
  try { if (typeof ATS_onOutput === 'function') text = ATS_onOutput(text); } catch (_) {}

  return { text };
};
modifier(text);

