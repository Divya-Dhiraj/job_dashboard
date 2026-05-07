// models.js — central Claude model selection.
//
// We split work across two tiers to keep API spend predictable while
// preserving quality on the parts the user actually reads:
//
//   GENERATION  (claude-sonnet-4-20250514)
//     The high-stakes prose work: full CV + cover letter, surgical edits,
//     and per-bullet rewrites. These calls answer to the strict writing
//     rules (no hyphens, B1 German vocabulary, defendable metrics, JSON
//     output) and Haiku tends to crack on at least one of those.
//
//   AUXILIARY   (claude-haiku-4-5-20251001)
//     Structured-extraction and classification tasks where Haiku is
//     basically as good as Sonnet at a fraction of the price:
//       - resume → structured profile (skills, titles, contact info)
//       - resume picker (which library resume best fits this JD)
//       - resume summarizer (2-sentence digest used by the picker)
//       - JD paste parser (free-form paste → structured fields)
//       - translation between EN and DE
//       - brain analyze (JD + company → archetype, department)
//       - brain reflect (post-generation insight extraction)
//
// Override path: set MODEL_GENERATION / MODEL_AUXILIARY in .env to swap.
// Useful when a new model lands and you want to A/B before changing code.
const MODELS = {
  generation: process.env.MODEL_GENERATION || 'claude-sonnet-4-20250514',
  auxiliary:  process.env.MODEL_AUXILIARY  || 'claude-haiku-4-5-20251001',
};

module.exports = MODELS;
