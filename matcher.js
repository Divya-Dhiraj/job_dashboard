// matcher.js — Profile-aware resume → job scoring.
//
// Final score blends two signals:
//
//   1. Keyword overlap + title bonus + city bonus  (the original signal,
//      max ~100). Cheap, instant, deterministic. Captures literal skill
//      hits ("snowflake" appears in JD).
//
//   2. Semantic similarity (cosine of the embedding-model representations
//      of the resume vs. the job text, scaled to 0–100). Captures conceptual
//      relevance ("Data Scientist" ↔ "BI Engineer" cluster close even though
//      keyword overlap is low).
//
// Final = round(KEYWORD_WEIGHT × keyword + SEMANTIC_WEIGHT × semantic).
// When the embedding provider is the keyword fallback (semantic == 0 useful
// signal), we return keyword score alone — guards against double-discounting
// when bge-base-en-v1.5 fails to load.
//
// scoreJob() is now async because it awaits embeddings. Callers must await.

const { embedOne, cosine, provider: embedProvider } = require('./embeddings');

const KEYWORD_WEIGHT  = 0.5;
const SEMANTIC_WEIGHT = 0.5;

let activeProfile = null;
// Cache: resume embedding is identical for every job in a scrape, so we
// compute it once per profile and reuse. Invalidated when setProfile()
// is called with a different id.
let _resumeEmbedding = null;
let _resumeEmbeddingProfileId = null;

function setProfile(profile) {
  activeProfile = profile || null;
  if (!activeProfile || activeProfile.id !== _resumeEmbeddingProfileId) {
    _resumeEmbedding = null;
    _resumeEmbeddingProfileId = activeProfile?.id || null;
  }
  if (activeProfile) {
    const groups = activeProfile.skill_groups || {};
    const totalSkills = Object.values(groups).reduce((n, g) => n + (g.skills?.length || 0), 0);
    console.log(`[Matcher] Profile "${activeProfile.name}" loaded — ${Object.keys(groups).length} skill groups, ${totalSkills} skills, ${activeProfile.search_titles?.length || 0} search titles`);
  } else {
    console.warn('[Matcher] No profile loaded.');
  }
}

function getProfile() { return activeProfile; }

// ─────────────────────────────────────────────────────────────────────────────
// Keyword score — same as the original implementation. Deterministic,
// returns the same shape (so callers/tests don't break) but is now an
// internal helper.
// ─────────────────────────────────────────────────────────────────────────────
function keywordScore(job) {
  const groups = activeProfile.skill_groups || {};
  const targetTitles = activeProfile.target_titles?.length
    ? activeProfile.target_titles
    : (activeProfile.search_titles || []);

  const jobText = [job.title, job.description].join(' ').toLowerCase();

  let weightedMatches = 0;
  let maxPossible = 0;
  const matchedSkills = new Set();

  for (const { weight, skills } of Object.values(groups)) {
    for (const skill of (skills || [])) {
      maxPossible += weight;
      if (jobText.includes(String(skill).toLowerCase())) {
        weightedMatches += weight;
        matchedSkills.add(skill);
      }
    }
  }

  // Title match bonus
  let titleBonus = 0;
  const jobTitleLower = (job.title || '').toLowerCase();
  for (const title of targetTitles) {
    const words = String(title).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const hits = words.filter(w => jobTitleLower.includes(w)).length;
    if (hits >= Math.ceil(words.length * 0.6)) { titleBonus = 22; break; }
    if (hits >= 1) titleBonus = Math.max(titleBonus, 8);
  }

  // Location bonus — reward an exact city/region match from the profile
  let locBonus = 0;
  const profileCity = (activeProfile.address || '').split(',')[0].trim().toLowerCase();
  if (profileCity && jobText.includes(profileCity)) locBonus = 5;

  const base = maxPossible > 0
    ? Math.round((weightedMatches / Math.min(maxPossible, 80)) * 73)
    : 35;

  return {
    score: Math.min(100, base + titleBonus + locBonus),
    matched_skills: [...matchedSkills].slice(0, 15),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic score — cosine of resume vs. job text, scaled to 0-100.
// Returns null when the embedding provider is the keyword fallback (no
// useful semantic signal — would just double-count keyword overlap).
// ─────────────────────────────────────────────────────────────────────────────
async function semanticScore(job) {
  // 'keyword' is the dummy fallback provider — nothing semantic to add.
  if (embedProvider() === 'keyword') return null;

  if (!_resumeEmbedding) {
    const resumeText = activeProfile.resume_text || activeProfile.name || '';
    if (!resumeText.trim()) return null;
    try { _resumeEmbedding = await embedOne(resumeText); }
    catch (e) {
      console.warn('[Matcher] Resume embedding failed:', e.message);
      return null;
    }
  }

  let jobEmbedding;
  try {
    jobEmbedding = await embedOne([job.title, job.description].filter(Boolean).join('\n'));
  } catch (e) {
    console.warn('[Matcher] Job embedding failed:', e.message);
    return null;
  }

  const sim = cosine(_resumeEmbedding, jobEmbedding);
  // Cosine for related professional text on bge-base-en-v1.5 typically
  // sits in 0.4-0.85. Linear scaling keeps the math transparent.
  const score = Math.max(0, Math.min(100, Math.round(sim * 100)));
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public scoreJob — async. Combines keyword + semantic when both available.
// ─────────────────────────────────────────────────────────────────────────────
async function scoreJob(job) {
  if (!activeProfile) {
    return { match_score: 0, matched_skills: '[]' };
  }
  const k = keywordScore(job);
  const s = await semanticScore(job);

  let final;
  if (s == null) {
    final = k.score;  // keyword-only fallback
  } else {
    final = Math.round(KEYWORD_WEIGHT * k.score + SEMANTIC_WEIGHT * s);
  }
  return {
    match_score:    Math.min(100, final),
    matched_skills: JSON.stringify(k.matched_skills),
  };
}

function getInferredTitles() {
  return activeProfile?.search_titles || [];
}

function getDisplayTitles() {
  return activeProfile?.target_titles || [];
}

function getResumeKeywords() {
  if (!activeProfile) return [];
  const resumeText = (activeProfile.resume_text || '').toLowerCase();
  const display = [];
  for (const { skills } of Object.values(activeProfile.skill_groups || {})) {
    for (const skill of (skills || [])) {
      if (resumeText.includes(String(skill).toLowerCase())) display.push(skill);
    }
  }
  return [...new Set(display)];
}

module.exports = {
  setProfile, getProfile,
  scoreJob, getInferredTitles, getDisplayTitles, getResumeKeywords,
  loadResume: () => {},
};
