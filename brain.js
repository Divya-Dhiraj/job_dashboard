// brain.js — Per-profile learning loop.
//
// The brain has four operations driven from server.js / generator.js:
//
//   analyzeJobAndCompany(profile, job)
//      Called BEFORE the CV generation. Claude reads the JD and emits
//      structured facts about the company, department, role archetype, and
//      the skills the JD demands. Those facts are upserted into brain_*.
//
//   retrieveContext(profile, job)
//      Called RIGHT BEFORE the CV generation. Returns a payload that's
//      injected into the generator's system prompt: company history, similar
//      past applications, skill demand/supply summary, active insights,
//      manual facts.
//
//   recordGeneration(profile, applicationId, job, cv, coverLetter)
//      Called AFTER the CV generation. Saves the artifacts to
//      brain_application_log + writes embeddings for semantic retrieval.
//
//   recordEdit(profileId, applicationId, edit)
//      Called when the user edits a section.
//
//   markApplied(profileId, applicationId) + runReflection(profile)
//      markApplied flags the row applied. runReflection asks Claude to
//      summarize lessons learned across the last N applications.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const brainDb = require('./brain_db');
const { embed, embedOne, topK } = require('./embeddings');
const MODELS = require('./models');

// Brain tasks (analyze JD + company, post-generation reflection,
// match-explanation) are structured-extraction work. Haiku handles them
// well at much lower cost than Sonnet. Override via MODEL_AUXILIARY in .env.
const ANALYZER_MODEL  = MODELS.auxiliary;
const REFLECTOR_MODEL = MODELS.auxiliary;

function anthropicClient(profile) {
  const key = (profile && profile.anthropic_key_override)
    || db.getSetting('anthropic_api_key')
    || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key missing — set in Settings');
  return new Anthropic({ apiKey: key });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. analyzeJobAndCompany — extract structured facts from the JD
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeJobAndCompany(profile, job) {
  const client = anthropicClient(profile);

  const sys = `You analyze job descriptions and extract structured facts for a candidate's brain.

Output ONLY JSON with this exact shape:
{
  "company": {
    "name": "...",
    "industry": "fintech | logistics | saas | healthtech | media | ...",
    "size_estimate": "startup | scaleup | mid-size | enterprise",
    "what_they_do": "1-2 sentence plain English",
    "mission": "1 sentence if discernible, else empty string",
    "tech_stack": ["python", "snowflake", ...]   // if mentioned in JD
  },
  "department": {
    "name": "Data Platform | Marketing Analytics | Engineering | ...",
    "what_they_do": "1-2 sentence team purpose, inferred",
    "what_they_want": "1-2 sentence: what kind of person they're hiring; required mindset/strengths"
  },
  "role_archetype": "Short label that clusters this role with similar past ones (e.g. 'BI Engineer at fintech', 'Analytics Engineer at SaaS scaleup')",
  "skills_demanded": ["sql", "dbt", "stakeholder management", ...]   // 5-15 lowercase skills
}

RULES:
- Use the company/department names from the JD if present; if not, leave empty string for name.
- Be concise. Don't fabricate facts the JD doesn't support.
- skills_demanded must reflect what THIS specific JD asks for, not generic role expectations.`;

  const usr = `Job title: ${job.title || ''}
Company: ${job.company || ''}
Location: ${job.location || ''}

Job description:
${(job.description || '').slice(0, 12000)}

Output the JSON now.`;

  const res = await client.messages.create({
    model: ANALYZER_MODEL,
    max_tokens: 1500,
    // Cache the analyzer system prompt — same text for every JD analysis,
    // and we run analyzeJobAndCompany on every generate. ~5s saved per
    // generation once the cache is warm.
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: usr }],
  });
  const text = res.content[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Brain analyzer: no JSON in Claude response');
  const facts = JSON.parse(m[0]);

  // Upserts
  const companyName = (facts.company?.name || job.company || '').trim();
  let companyId = null;
  if (companyName) {
    companyId = brainDb.upsertCompany(profile.id, {
      name: companyName,
      industry: facts.company?.industry,
      size_estimate: facts.company?.size_estimate,
      what_they_do: facts.company?.what_they_do,
      mission: facts.company?.mission,
      tech_stack: facts.company?.tech_stack || [],
    });
  }

  let departmentId = null;
  if (companyId && facts.department?.name) {
    departmentId = brainDb.upsertDepartment(profile.id, companyId, {
      name: facts.department.name,
      what_they_do: facts.department.what_they_do,
      what_they_want: facts.department.what_they_want,
    });
  }

  let archetypeId = null;
  if (facts.role_archetype) {
    archetypeId = brainDb.upsertRoleArchetype(profile.id, {
      name: facts.role_archetype,
      common_skills: facts.skills_demanded || [],
    });
  }

  // Bump skill demand counters
  for (const skill of (facts.skills_demanded || [])) {
    brainDb.bumpSkillDemand(profile.id, skill);
  }

  return { facts, companyId, departmentId, archetypeId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. retrieveContext — assemble the "brain context" payload
// ─────────────────────────────────────────────────────────────────────────────
async function retrieveContext(profile, job, { topPastApps = 4, topSkills = 12, archetypeId = null } = {}) {
  const profileId = profile.id;

  // Company history (if we've seen this employer)
  const company = job.company ? brainDb.getCompanyByName(profileId, job.company) : null;

  // Top demanded + emphasized skills (still global — useful big-picture context)
  const allSkills = brainDb.listSkills(profileId, { limit: 200 });
  const topDemand    = [...allSkills].sort((a, b) => b.demand_count - a.demand_count).slice(0, topSkills);
  const topEmphasis  = [...allSkills].sort((a, b) => b.emphasis_count - a.emphasis_count).slice(0, topSkills);

  // Active insights + facts split into "global" (archetype_id NULL) and
  // "this angle" (archetype_id matches). Different prompt sections so Claude
  // can apply angle-specific guidance only when relevant.
  let globalInsights = [], angleInsights = [], globalFacts = [], angleFacts = [], archetypeName = null;
  if (archetypeId) {
    const archetype = brainDb.getArchetype(profileId, archetypeId);
    archetypeName = archetype?.name || null;
    angleInsights  = brainDb.listInsights(profileId, { activeOnly: true, archetypeId, includeGlobal: false }).slice(0, 10);
    globalInsights = brainDb.listInsights(profileId, { activeOnly: true, archetypeId: null }).slice(0, 10);
    angleFacts     = brainDb.listFacts(profileId,    { archetypeId, includeGlobal: false }).slice(0, 10);
    globalFacts    = brainDb.listFacts(profileId,    { archetypeId: null }).slice(0, 10);
  } else {
    globalInsights = brainDb.listInsights(profileId, { activeOnly: true }).slice(0, 10);
    globalFacts    = brainDb.listFacts(profileId).slice(0, 10);
  }

  // Similar past applications via embedding cosine.
  // 1. Compute query vector from the job description.
  // 2. Pull candidate embeddings for ref_type='job_description' from this profile.
  // 3. Top-K → look up the corresponding application_log rows.
  let similarApps = [];
  try {
    const queryText = `${job.title || ''}\n${job.description || ''}`.slice(0, 8000);
    const queryVec = await embedOne(queryText);
    const candidates = brainDb.listEmbeddings(profileId, 'job_description');
    const ranked = topK(queryVec, candidates, topPastApps);
    for (const r of ranked) {
      // ref_id points to brain_application_log.id
      const log = db.brainOne('SELECT * FROM brain_application_log WHERE id = ?', [r.ref_id]);
      if (log) {
        similarApps.push({
          job_title: log.job_title,
          company:   log.company_id ? db.brainOne('SELECT name FROM brain_companies WHERE id = ?', [log.company_id])?.name : '',
          applied:   !!log.applied,
          similarity: r._sim,
          cv: tryParse(log.cv_json),
          edits: tryParse(log.user_edits) || [],
          excerpt_jd: (log.job_description || '').slice(0, 500),
        });
      }
    }
  } catch (e) {
    console.warn('[Brain] retrieveContext: embeddings step failed:', e.message);
  }

  // Recent companies & archetype
  const recentCompanies = brainDb.listCompanies(profileId).slice(0, 5);

  return {
    candidate: {
      name: profile.name,
      headline_from_resume: (profile.resume_text || '').slice(0, 280),
    },
    angle: archetypeName ? { id: archetypeId, name: archetypeName } : null,
    company_history: company ? {
      name: company.name,
      industry: company.industry,
      what_they_do: company.what_they_do,
      tech_stack: tryParse(company.tech_stack) || [],
      times_applied: company.application_count,
      notes: company.notes || '',
    } : null,
    top_demanded_skills:    topDemand.map(s => ({ skill: s.skill, demand: s.demand_count })),
    candidate_strengths:    topEmphasis.map(s => ({ skill: s.skill, emphasized: s.emphasis_count, candidate_strength: s.candidate_strength })),
    global_insights:        globalInsights.map(i => ({ insight: i.insight, category: i.category, confidence: i.confidence })),
    angle_insights:         angleInsights.map(i => ({ insight: i.insight, category: i.category, confidence: i.confidence })),
    global_facts:           globalFacts.map(f => ({ fact: f.fact, tag: f.tag })),
    angle_facts:            angleFacts.map(f => ({ fact: f.fact, tag: f.tag })),
    similar_past_applications: similarApps,
    recent_companies:       recentCompanies.map(c => ({ name: c.name, industry: c.industry, applied_count: c.application_count })),
  };
}

// Format the brain context as a compact text block to inject into a Claude prompt.
// The candidate may apply for many distinct angles (e.g. BI vs SAP vs Data
// Engineer) within one profile — we split insights and facts into "across all
// applications" (cross-angle wisdom) and "for the X angle" (angle-specific)
// so Claude doesn't import SAP-only lessons into a Data Analyst CV.
function formatContextForPrompt(ctx) {
  const lines = ['=== PROFILE BRAIN — accumulated knowledge ==='];
  const angleLabel = ctx.angle?.name ? ` (current angle: "${ctx.angle.name}")` : '';
  lines.push(`This candidate has applied to many roles. The brain entries below are${angleLabel ? ' separated by relevance' : ' summarized below'}${angleLabel}.`);
  lines.push('');

  if (ctx.company_history) {
    lines.push(`# This company before`);
    lines.push(`- ${ctx.company_history.name} (${ctx.company_history.industry || 'unknown industry'})`);
    if (ctx.company_history.what_they_do) lines.push(`- What they do: ${ctx.company_history.what_they_do}`);
    if (ctx.company_history.tech_stack?.length) lines.push(`- Stack: ${ctx.company_history.tech_stack.join(', ')}`);
    lines.push(`- Previous applications to this company: ${ctx.company_history.times_applied}`);
    if (ctx.company_history.notes) lines.push(`- Notes: ${ctx.company_history.notes.slice(0, 400)}`);
    lines.push('');
  }

  // Angle-specific insights/facts: highest priority for THIS application
  if (ctx.angle_insights?.length) {
    lines.push(`# Lessons specific to the "${ctx.angle.name}" angle (apply these)`);
    for (const i of ctx.angle_insights) lines.push(`- [${i.category || 'general'}] ${i.insight}`);
    lines.push('');
  }
  if (ctx.angle_facts?.length) {
    lines.push(`# Facts specific to the "${ctx.angle.name}" angle (high priority)`);
    for (const f of ctx.angle_facts) lines.push(`- ${f.tag ? '['+f.tag+'] ' : ''}${f.fact}`);
    lines.push('');
  }

  // Cross-angle insights/facts: apply only when relevant
  if (ctx.global_insights?.length) {
    lines.push('# Lessons across all applications (apply only when relevant to this role)');
    for (const i of ctx.global_insights) lines.push(`- [${i.category || 'general'}] ${i.insight}`);
    lines.push('');
  }
  if (ctx.global_facts?.length) {
    lines.push('# General user-added facts (apply only when relevant)');
    for (const f of ctx.global_facts) lines.push(`- ${f.tag ? '['+f.tag+'] ' : ''}${f.fact}`);
    lines.push('');
  }

  if (ctx.top_demanded_skills?.length) {
    lines.push('# Skills frequently demanded across all jobs the candidate looks at');
    lines.push(ctx.top_demanded_skills.slice(0, 10).map(s => `${s.skill} (×${s.demand})`).join(', '));
    lines.push('');
  }
  if (ctx.candidate_strengths?.length) {
    lines.push('# Skills the candidate has emphasized in past CVs');
    lines.push(ctx.candidate_strengths.slice(0, 10).map(s => `${s.skill} (emphasized ×${s.emphasized})`).join(', '));
    lines.push('');
  }
  if (ctx.similar_past_applications?.length) {
    lines.push('# Similar past applications (semantically closest first — these tend to share the current angle)');
    lines.push('Use the headlines, summaries, and bullets below as a starting point. Lean on what you reused before; improve where the user edited. Do NOT copy verbatim if the role is meaningfully different — adapt language and emphasis.');
    lines.push('');
    // Top 2 only get full bullet exposure to stay within prompt budget; the
    // rest only carry meta for "I've seen this kind of role before".
    for (let i = 0; i < ctx.similar_past_applications.length; i++) {
      const a = ctx.similar_past_applications[i];
      const verbose = i < 2;
      lines.push(`- ${a.job_title} @ ${a.company || '?'} — sim=${a.similarity?.toFixed(2)}, applied=${a.applied ? 'yes' : 'no'}`);
      if (a.cv?.targetTitle)    lines.push(`  headline used: "${a.cv.targetTitle}"`);
      if (a.cv?.profileSummary) lines.push(`  summary used: "${a.cv.profileSummary.slice(0, 220)}..."`);
      if (a.edits?.length) {
        lines.push(`  user edits made: ${a.edits.length} (most recent: "${(a.edits[a.edits.length-1].instruction || '').slice(0, 120)}")`);
      }
      // For the top 2 most-similar past applications, expose the actual
      // experience bullets — this is where the candidate's "best phrasings"
      // accumulate across applications. Generator can lift / refine them.
      if (verbose && Array.isArray(a.cv?.experience)) {
        const recent = a.cv.experience[0];  // most recent role
        if (recent?.bullets?.length) {
          lines.push(`  bullets used at "${recent.company}":`);
          for (const b of recent.bullets.slice(0, 4)) {
            lines.push(`    · ${String(b).slice(0, 220)}`);
          }
        }
      }
    }
    lines.push('');
  }
  lines.push('=== END BRAIN ===');
  lines.push('');
  lines.push('Use the brain context to make this CV/cover letter STRONGER than past attempts: prioritize angle-specific lessons and facts; treat cross-angle wisdom as secondary; emphasize demand-aligned skills the candidate has; reuse phrasings that worked while improving on ones the user edited.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. recordGeneration — store artifacts + embeddings
// ─────────────────────────────────────────────────────────────────────────────
async function recordGeneration(profile, { applicationId, companyId, departmentId, archetypeId, job, cv, coverLetter }) {
  const profileId = profile.id;
  const logId = brainDb.logApplication(profileId, {
    application_id:   applicationId,
    company_id:       companyId,
    department_id:    departmentId,
    role_archetype_id: archetypeId,
    job_id:           job.id,
    job_title:        job.title,
    job_description:  job.description,
    cv,
    cover_letter:     coverLetter,
  });
  if (companyId) brainDb.bumpCompanyApplicationCount(companyId);

  // Bump emphasis for every skill that appears in the generated CV's skills section
  if (cv?.skills && typeof cv.skills === 'object') {
    const flat = [];
    for (const list of Object.values(cv.skills)) {
      if (Array.isArray(list)) flat.push(...list);
    }
    for (const s of flat) brainDb.bumpSkillEmphasis(profileId, s);
  }

  // Record achievement variations for retrieval / introspection
  if (Array.isArray(cv?.experience)) {
    for (const exp of cv.experience) {
      for (const b of (exp.bullets || [])) {
        brainDb.addAchievement(profileId, {
          source_bullet: '',
          variation: b,
          context: `${job.title || ''} @ ${job.company || ''}`,
        });
      }
    }
  }

  // Embeddings for semantic retrieval next time
  try {
    const jdText = `${job.title || ''}\n${job.description || ''}`.slice(0, 8000);
    const cvText = JSON.stringify(cv).slice(0, 8000);
    const [vJd, vCv] = await embed([jdText, cvText]);
    brainDb.saveEmbedding(profileId, { ref_type: 'job_description', ref_id: logId, ref_key: String(job.id || ''), text: jdText, embedding: vJd, dim: vJd.length });
    brainDb.saveEmbedding(profileId, { ref_type: 'cv',              ref_id: logId, ref_key: String(applicationId || ''), text: cvText, embedding: vCv, dim: vCv.length });
  } catch (e) {
    console.warn('[Brain] recordGeneration: embeddings step failed:', e.message);
  }

  return { logId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. recordEdit + markApplied + runReflection
// ─────────────────────────────────────────────────────────────────────────────
function recordEdit(profileId, applicationId, edit) {
  brainDb.appendUserEdit(applicationId, edit);
}

function markApplied(profileId, applicationId) {
  brainDb.markApplicationApplied(applicationId);
}

// runReflection — Claude reads recent applications and produces 1-3 new insights.
// If archetypeId is provided, we look only at applications matching that
// archetype (so SAP reflections produce SAP insights, not "average across
// everything Divya applies to") and tag the new insights with that archetype.
async function runReflection(profile, { lookback = 5, archetypeId = null } = {}) {
  const all = brainDb.recentApplicationLogs(profile.id, lookback * 3);
  const recent = archetypeId
    ? all.filter(r => r.role_archetype_id === archetypeId).slice(0, lookback)
    : all.slice(0, lookback);

  if (recent.length < 2) {
    return { skipped: true, reason: archetypeId
      ? `need at least 2 recent applications in this angle (have ${recent.length})`
      : 'need at least 2 recent applications to reflect' };
  }

  const archetype = archetypeId ? brainDb.getArchetype(profile.id, archetypeId) : null;
  const angleLabel = archetype ? `for the "${archetype.name}" angle` : 'across all roles';

  const client = anthropicClient(profile);
  const condensed = recent.map(r => ({
    role: r.job_title,
    company_id: r.company_id,
    applied: !!r.applied,
    cv_headline:    tryParse(r.cv_json)?.targetTitle || '',
    cv_summary:     (tryParse(r.cv_json)?.profileSummary || '').slice(0, 220),
    user_edits:     tryParse(r.user_edits) || [],
    jd_excerpt:     (r.job_description || '').slice(0, 600),
  }));

  const sys = `You are a meta-coach analyzing a job seeker's recent applications ${angleLabel}. Look for patterns:
  - When did the candidate get edited the most? Why? What does that suggest about default phrasings?
  - Which kinds of jobs did they actually apply to vs. just generate?
  - Which skills/experiences come up repeatedly across the matched roles?
  - Are there blind spots — patterns the candidate keeps repeating that the JDs don't reward?

The candidate applies to MULTIPLE distinct angles (e.g. BI Engineer vs. SAP Consultant vs. Data Analyst).${archetype ? ` These applications are all from the "${archetype.name}" angle, so insights should be ${archetype.name}-specific, not general advice.` : ' These applications span different angles — only emit cross-angle wisdom that applies broadly, not angle-specific tips.'}

Output JSON: { "insights": [{"insight": "...", "category": "positioning|skill|tone|company|workflow", "confidence": 0.0-1.0}, ...] }
- 1 to 3 insights total. Each insight is a single sentence, actionable for the next CV/cover-letter generation.
- Don't restate things obvious from the resume. Insights should be earned from the patterns you see.
- If you don't see clear patterns, return an empty array.`;

  const usr = `Recent applications for ${profile.name} ${angleLabel}:\n\n${JSON.stringify(condensed, null, 2)}\n\nAnalyze and emit JSON.`;

  const res = await client.messages.create({
    model: REFLECTOR_MODEL,
    max_tokens: 1200,
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: usr }],
  });
  const text = res.content[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { skipped: true, reason: 'no JSON' };
  const parsed = JSON.parse(m[0]);
  const created = [];
  for (const i of (parsed.insights || [])) {
    if (!i.insight) continue;
    const id = brainDb.addInsight(profile.id, {
      insight: i.insight,
      category: i.category || 'general',
      source: archetypeId ? `reflection:${archetype?.name || archetypeId}` : 'reflection',
      confidence: typeof i.confidence === 'number' ? i.confidence : 0.5,
      archetype_id: archetypeId,
    });
    created.push({ id, ...i, archetype_id: archetypeId });
  }
  return { created, lookback: recent.length, archetype: archetype?.name || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function tryParse(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Match-explainability — Claude reads (source text, JD) and returns a
// structured map of which JD requirements are supported by which source
// content, plus skill matches and gaps.
//
// Source can be:
//   - the candidate's raw resume_text (default — matches the original use:
//     "what does my resume cover before I even generate a CV?")
//   - the tailored, just-generated CV (after generation: "what did the
//     tailored version add or drop vs my baseline resume?")
//
// The brain_match_explanations cache key includes a sourceLabel so the
// resume vs CV runs are stored independently and don't shadow each other.
async function explainMatch(profile, job, opts = {}) {
  const { force = false, sourceText = null, sourceLabel = 'resume' } = opts;
  // Compose the cache key. brain_match_explanations PK is (profile_id, job_id)
  // so we extend it with a synthetic suffix for non-default sources.
  const cacheKey = sourceLabel === 'resume' ? job.id : `${job.id}::${sourceLabel}`;
  if (!force) {
    const cached = brainDb.getCachedMatchExplanation(profile.id, cacheKey);
    if (cached) return cached;
  }
  const { MATCH_EXPLAIN_SYSTEM_PROMPT } = require('./prompts/cv_generation');
  const client = anthropicClient(profile);

  const sourceBlob = sourceText || profile.resume_text || '';
  const sourceHeader = sourceLabel === 'cv'
    ? "Candidate's tailored CV for this role:"
    : "Candidate's resume:";

  const userPrompt = `${sourceHeader}
${String(sourceBlob).slice(0, 8000)}

Target job:
${job.title || ''}${job.company ? ' at ' + job.company : ''}${job.location ? ' (' + job.location + ')' : ''}

Job description:
${(job.description || '').slice(0, 8000)}

Analyze and emit the JSON now.`;

  const res = await client.messages.create({
    model: ANALYZER_MODEL,
    max_tokens: 2500,
    system: [{ type: 'text', text: MATCH_EXPLAIN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = res.content[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Match explainer: no JSON in response');
  const payload = JSON.parse(m[0]);
  payload.source_label = sourceLabel;  // surface to the UI
  brainDb.saveMatchExplanation(profile.id, cacheKey, payload);
  return payload;
}

// Helper — flatten a CV JSON to the same kind of plain text the resume
// is. Used so explainMatch's prompt format stays uniform regardless of
// whether we're comparing the raw resume or the generated CV.
function cvJsonToFlatText(cv) {
  if (!cv) return '';
  const parts = [];
  if (cv.profileSummary) parts.push('PROFILE SUMMARY\n' + cv.profileSummary);
  if (cv.experience?.length) {
    parts.push('\nPROFESSIONAL EXPERIENCE');
    for (const e of cv.experience) {
      const head = `${e.title || ''}${e.company ? ', ' + e.company : ''}${e.dates ? '   ' + e.dates : ''}`;
      parts.push(head);
      for (const b of (e.bullets || [])) parts.push('• ' + b);
    }
  }
  if (cv.education?.length) {
    parts.push('\nEDUCATION');
    for (const e of cv.education) parts.push(`${e.degree || ''}${e.school ? ', ' + e.school : ''}${e.dates ? '   ' + e.dates : ''}${e.details ? '\n  ' + e.details : ''}`);
  }
  if (cv.skills && typeof cv.skills === 'object') {
    parts.push('\nSKILLS');
    for (const [cat, list] of Object.entries(cv.skills)) {
      const items = Array.isArray(list) ? list.join(', ') : String(list);
      parts.push(`${cat}: ${items}`);
    }
  }
  if (cv.languages?.length) {
    parts.push('\nLANGUAGES: ' + cv.languages.map(l => typeof l === 'string' ? l : `${l.lang}${l.level ? ' (' + l.level + ')' : ''}`).join(', '));
  }
  return parts.join('\n');
}

module.exports = {
  analyzeJobAndCompany,
  retrieveContext,
  formatContextForPrompt,
  recordGeneration,
  recordEdit,
  markApplied,
  runReflection,
  explainMatch, cvJsonToFlatText,
};
