
// ===== START: Output.js (original) =====
const modifier_original = (text) => {
  try { if (typeof ATS_onOutput === 'function') text = ATS_onOutput(text); } catch (_) {}
  return { text };
};
// ===== END: Output.js =====


// ===== START: AC Hidden quest output.js =====
const modifier_AC = (text) => {
  text = AutoCards("output", text);
  // 1) run your existing SAE output hook
  let output = onOutput_SAE(text);
  if (typeof output === "object" && output.text) output = output.text;

  // 2) Define positive & negative cues
  const positive = /\bhug\b|\bkiss\b|\bthank you\b/i;
  const negative = /\battack\b|\binsult\b|\bbetray\b|\bkill\b/i;

  // 3) Loop through every known character
  for (const name of Object.keys(state.relationships)) {
    // escape name for regex
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRx = new RegExp(`\\b${esc}\\b`, 'i');
    if (nameRx.test(output)) {
      // a) bump relationships
      if (positive.test(output)) state.relationships[name] += 5;
      if (negative.test(output)) state.relationships[name] -= 10;
      // b) capture a memory snippet (the full sentence mentioning them)
      const sentenceMatch = output.match(
        new RegExp(`[^.]*\\b${esc}\\b[^.]*\\.`, 'i')
      );
      if (sentenceMatch) {
        if (!(name in state.memories)) state.memories[name] = [];
        state.memories[name].push(sentenceMatch[0].trim());
      }
    }
  }
  // ── RANDOM WORLD EVENTS ──
  if (Math.random() < 0.1) { // ~10% chance each turn
    const possibilities = [
      "Stormy weather", "Harvest Festival", "Bandit Raid",
      "Royal Wedding", "Outbreak of War", "Eclipse"
    ];
    state.worldEvent = possibilities[
      Math.floor(Math.random() * possibilities.length)
    ];
    // persist
    const eventsSC = storyCards.find(sc => sc.title === "World Events");
    eventsSC.entry = JSON.stringify({ current: state.worldEvent });
    output += `\n\n<< The world shifts: ${state.worldEvent} >>`;
  }
  // ── HIDDEN QUESTS BASED ON RELATIONSHIP ──
  for (const [name, score] of Object.entries(state.relationships)) {
    // if very high affinity and no quest yet
    if (score >= 50 && !state.hiddenQuests.includes(name)) {
      const quest = `Aid ${name} in their personal quest`;
      state.hiddenQuests.push(name);
      const questsSC = storyCards.find(sc => sc.title === "Hidden Quests");
      questsSC.entry = JSON.stringify(state.hiddenQuests);
      output += `\n\n<< New hidden quest unlocked: ${quest} >>`;
    }
  }
  // 4) persist relationships & memories
  const relSC = storyCards.find(sc => sc.title === "Relationships");
  const memSC = storyCards.find(sc => sc.title === "Memories");
  relSC.entry = JSON.stringify(state.relationships);
  memSC.entry = JSON.stringify(state.memories);
  // 5) return the final text object
  return { text: output };
  // Your other output modifier scripts go here (alternative)
  // return {text};
};
// ===== END: AC Hidden quest output.js =====


// ===== CHAINED MODIFIER =====
const modifier = (text) => {
  // Run the original modifier first
  const result1 = modifier_original(text);
  // Then run the AC Hidden quest modifier on the output of the first
  return modifier_AC(result1.text);
};

// AiDungeon will call this under the hood:
modifier(text);
