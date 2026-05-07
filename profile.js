// profile.js — Resume → profile pipeline.
// Given a PDF or DOCX buffer, this module:
//   1. Extracts plain text (pdf-parse for PDF, mammoth for DOCX, raw for TXT)
//   2. Calls Claude to infer:
//      - contact info (name, email, phone, address, linkedin)
//      - weighted skill_groups (categories with weight + skill list)
//      - search_titles (5–10 titles for scrapers)
//      - target_titles (broader list for title-bonus matching)
// The resulting profile object can be saved via database.createProfile().
const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('./models');

// Resume → structured profile is a structured-extraction task. Haiku
// handles it just as well as Sonnet at a fraction of the cost.
const PROFILE_INFERENCE_MODEL = MODELS.auxiliary;

// ─────────────────────────────────────────────────────────────────────────────
// Resume text extraction
// ─────────────────────────────────────────────────────────────────────────────
async function extractResumeText(buffer, filename = '') {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.txt')) return buffer.toString('utf-8');
  if (lower.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return value || '';
  }
  if (lower.endsWith('.pdf')) {
    // pdf-parse can be noisy on first import; isolate it
    const pdfParse = require('pdf-parse');
    const { text } = await pdfParse(buffer);
    return text || '';
  }
  // Best-effort fallback: try pdf-parse, then mammoth, then utf-8
  try {
    const pdfParse = require('pdf-parse');
    const { text } = await pdfParse(buffer);
    if (text && text.trim()) return text;
  } catch {}
  try {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    if (value && value.trim()) return value;
  } catch {}
  return buffer.toString('utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude-driven profile inference
// ─────────────────────────────────────────────────────────────────────────────
async function inferProfileFromResume(resumeText, { anthropicKey } = {}) {
  const apiKey = anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for profile inference');
  const client = new Anthropic({ apiKey });

  const systemPrompt = `You analyze resumes and produce a structured profile for a job-search automation tool.

Output ONLY valid JSON with these exact keys:
{
  "name": "Full Name",
  "email": "...",
  "phone": "...",
  "address": "City, Country",  // current location, not full street address
  "linkedin": "linkedin.com/in/...",  // strip https:// prefix; empty string if not present
  "skill_groups": {
    "<category_key>": {
      "weight": <integer 1-4>,
      "skills": ["skill1", "skill2", ...]  // lowercase, deduplicated, the skills the candidate actually has
    },
    ...
  },
  "search_titles": ["Title 1", "Title 2", ...],   // 5-10 job titles best suited to scrape for this candidate; concise, real-world titles recruiters use
  "target_titles": ["Title 1", ...]                // 10-25 titles for broader title-bonus matching; includes synonyms, variations
}

GUIDELINES:
- skill_groups: 4-7 categories such as "core_role", "languages_frameworks", "cloud_data", "tools", "domain". Choose categories that fit the candidate's actual background (don't force BI/SAP categories on a frontend dev). Keys: lowercase snake_case.
- weight: 4 = primary professional skill (the role itself, e.g. "data analyst" for a data analyst), 3 = strong technical stack, 2 = supporting tools, 1 = soft/domain.
- skills: lowercase, only what's clearly present in the resume. Include common variants (e.g. both "powerbi" and "power bi", "postgres" and "postgresql"). 8-25 skills per group.
- search_titles: derived from candidate's experience + the kind of next role they'd realistically apply to. Use industry-standard titles. Don't invent niche titles.
- target_titles: a superset of search_titles plus common variations (e.g. "Senior X", "X Engineer", "X Developer") used to give a title bonus during matching.
- If a field is genuinely missing (no email, no linkedin), return an empty string. Do NOT make up data.`;

  const userPrompt = `Resume text:

${resumeText.slice(0, 18000)}

Generate the JSON profile now.`;

  const response = await client.messages.create({
    model: PROFILE_INFERENCE_MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Profile inference: no JSON in Claude response');
  const parsed = JSON.parse(jsonMatch[0]);

  // Validate + normalize
  return {
    name: String(parsed.name || '').trim(),
    email: String(parsed.email || '').trim(),
    phone: String(parsed.phone || '').trim(),
    address: String(parsed.address || '').trim(),
    linkedin: normalizeLinkedIn(parsed.linkedin),
    skill_groups: normalizeSkillGroups(parsed.skill_groups),
    search_titles: Array.isArray(parsed.search_titles) ? parsed.search_titles.filter(Boolean).slice(0, 12) : [],
    target_titles: Array.isArray(parsed.target_titles) ? parsed.target_titles.filter(Boolean).slice(0, 30) : [],
  };
}

function normalizeLinkedIn(raw) {
  if (!raw) return '';
  return String(raw).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').trim();
}

function normalizeSkillGroups(groups) {
  if (!groups || typeof groups !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(groups)) {
    if (!val || typeof val !== 'object') continue;
    const weight = Math.min(4, Math.max(1, parseInt(val.weight) || 2));
    const skills = Array.isArray(val.skills)
      ? [...new Set(val.skills.map(s => String(s).toLowerCase().trim()).filter(Boolean))]
      : [];
    if (skills.length === 0) continue;
    out[key.toLowerCase().replace(/[^a-z0-9_]+/g, '_')] = { weight, skills };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-shot helper: buffer → full profile object
// ─────────────────────────────────────────────────────────────────────────────
async function profileFromUpload({ buffer, filename, anthropicKey, allowedCountryCodes }) {
  const resumeText = (await extractResumeText(buffer, filename)).trim();
  if (!resumeText) throw new Error('Could not extract any text from resume file');
  const inferred = await inferProfileFromResume(resumeText, { anthropicKey });
  return {
    ...inferred,
    resume_text: resumeText,
    allowed_country_codes: Array.isArray(allowedCountryCodes) && allowedCountryCodes.length
      ? allowedCountryCodes
      : ['de'],
  };
}

module.exports = {
  extractResumeText,
  inferProfileFromResume,
  profileFromUpload,
};
