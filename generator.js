// generator.js — Claude API CV/Cover Letter generation + DOCX/PDF output.
// Profile-aware: name, contact, resume text, and per-profile output folders all
// come from the active profile passed in by the server. Filenames use the
// profile's slug. Layout/typography is unchanged from the original spec.
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const docx = require('docx');
const puppeteer = require('puppeteer');
const db = require('./database');
const brain = require('./brain');
const { SYSTEM_PROMPT, GERMAN_ADDENDUM, EDIT_SYSTEM_PROMPT_PREFIX, TRANSLATION_SYSTEM_PROMPT, BULLET_REWRITE_SYSTEM_PROMPT, JD_PARSE_SYSTEM_PROMPT } = require('./prompts/cv_generation');
const templates = require('./templates');

const APPS_DIR = path.join(__dirname, 'applications');

// Exact colors from the reference documents
const CLR = {
  navy:  '1F4E79',
  dark:  '333333',
  mid:   '555555',
  light: '666666',
};
// Exact sizes (half-points) from the reference documents
const SZ = {
  name:     36, // 18pt — 228600 EMU = 18pt
  subtitle: 22, // 11pt
  contact:  18, // 9pt
  section:  24, // 12pt — 152400 EMU = 12pt
  expTitle: 21, // 10.5pt — 133350 EMU
  expSub:   19, // 9.5pt — 120650 EMU
  body:     21, // 10.5pt
  bullet:   21, // 10.5pt
};

// Resolve the Anthropic API key with the same priority as elsewhere:
// profile override → app_settings → env. Profile is optional; when absent we
// fall back to settings/env so legacy callers keep working.
function getClient(profile) {
  const key = (profile && profile.anthropic_key_override)
    || db.getSetting?.('anthropic_api_key')
    || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key missing — set it in Settings or ANTHROPIC_API_KEY env');
  return new Anthropic({ apiKey: key });
}

// Returns the active profile from DB. Throws a clear error if no profile is
// configured yet — the caller should have run the setup wizard first.
function requireActiveProfile() {
  const p = db.getActiveProfile?.();
  if (!p) throw new Error('No active profile — create one via the setup wizard first');
  return p;
}

// Load the candidate's resume text. Default behavior is to use the
// profile's default resume (mirrored on profile.resume_text). Pass a
// resumeRow to use a specific resume from the profile_resumes table.
function loadResume(profile, resumeRow = null) {
  if (resumeRow && resumeRow.resume_text) return resumeRow.resume_text;
  const p = profile || requireActiveProfile();
  if (!p.resume_text) throw new Error(`Profile "${p.name}" has no resume_text saved`);
  return p.resume_text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-resume auto-picker
//
// When a profile has more than one stored resume (Tech CV vs Marketing CV
// vs Internal Recruiter CV), we ask Claude to score them against the JD
// and return the best match. The picker only sees each resume's SUMMARY
// (a one-paragraph Claude-generated digest) — we never paste full resumes
// into the picker prompt because that would cost ~10x more tokens for a
// trivial decision.
//
// If the profile only has one resume, we skip the Claude call entirely
// and return that resume.
// ─────────────────────────────────────────────────────────────────────────────
async function pickResumeForJob(profile, job, { explicitResumeId = null } = {}) {
  const profileId = profile && profile.id;
  if (!profileId) throw new Error('pickResumeForJob requires a profile with an id');

  // Explicit override beats everything.
  if (explicitResumeId) {
    const row = db.getResumeById(explicitResumeId, profileId);
    if (row) return { resume: row, reasoning: 'User-selected resume.', auto: false };
  }

  const all = db.listResumes(profileId);
  // No resumes yet — fall back to legacy profile.resume_text. This keeps
  // signups that haven't migrated yet working until the user uploads.
  if (all.length === 0) {
    if (profile.resume_text) {
      return { resume: { id: null, label: 'Default', resume_text: profile.resume_text }, reasoning: 'Single-resume profile.', auto: false };
    }
    throw new Error('Profile has no resume on file');
  }

  // Single resume — skip the picker and return it.
  if (all.length === 1) {
    const only = db.getResumeById(all[0].id, profileId);
    return { resume: only, reasoning: 'Only one resume on file.', auto: false };
  }

  // Multi-resume — ask Claude to rank. Backfill any missing summaries
  // first (one Claude call per resume, but only the first time the picker
  // ever runs against a freshly-migrated library).
  const missingSummary = all.filter(r => !r.summary || !r.summary.trim());
  if (missingSummary.length) {
    console.log(`[Generator] Backfilling ${missingSummary.length} resume summary/summaries before picker...`);
    await Promise.all(missingSummary.map(async r => {
      const full = db.getResumeById(r.id, profileId);
      if (!full) return;
      const summary = await summarizeResume(full.resume_text, profile);
      if (summary) {
        db.updateResume(r.id, profileId, { summary });
        r.summary = summary;
      }
    }));
  }
  const summaries = all.map((r, idx) => `[${idx + 1}] id=${r.id} label="${r.label}"
${r.summary || '(no summary on file)'}`).join('\n\n');

  const sys = `You match a job description against a candidate's resume library and pick the best fit.

You will see N resume summaries (one paragraph each, with id and label) and a job listing. Pick the SINGLE best resume to tailor for this job.

Output ONLY valid JSON, no markdown fences:
{"id": <number, the id field of the best resume>, "reasoning": "<one short sentence why this resume fits this job better than the others>"}

Pick by ROLE / INDUSTRY relevance first, then by skill stack. If two summaries are equally relevant, prefer the one whose label is the closer industry match. If everything ties, pick the most recently updated.`;

  const user = `Job listing:
Title: ${job.title || ''}
Company: ${job.company || ''}
Location: ${job.location || ''}
Description (truncated):
${(job.description || '').slice(0, 3500)}

Resume library:
${summaries}

Pick the best resume now.`;

  const client = getClient(profile);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: cached(sys),
    messages: [{ role: 'user', content: user }],
  });
  const raw = response.content[0]?.text || '';
  const m = raw.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  const pickedId = parsed?.id;
  let row = null;
  if (pickedId) row = db.getResumeById(pickedId, profileId);
  // Fallback: the default if Claude returned an unrecognized id.
  if (!row) row = db.getDefaultResume(profileId) || db.getResumeById(all[0].id, profileId);
  return {
    resume: row,
    reasoning: parsed?.reasoning || 'Auto-picked best match.',
    auto: true,
  };
}

// Generate a 2-sentence Claude summary of a resume for use by the picker.
// Caching this on upload (one Claude call per resume) means we never have
// to re-summarize during pick-time, which keeps the picker fast.
async function summarizeResume(resumeText, profile = null) {
  if (!resumeText || !resumeText.trim()) return '';
  const sys = `Summarize a candidate's resume in two short sentences for use by a job-matching picker. Output only the summary, no preamble. Sentence 1: their primary role + years + industry. Sentence 2: their strongest skill stack and any specialty (German market, B2B SaaS, fintech, etc.). 35 words max total. No first-person voice.`;
  try {
    const client = getClient(profile);
    const r = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: cached(sys),
      messages: [{ role: 'user', content: `Resume:\n\n${resumeText.slice(0, 12000)}\n\nSummarize now.` }],
    });
    return (r.content[0]?.text || '').trim();
  } catch (e) {
    console.warn('[Generator] summarizeResume failed:', e.message);
    return '';
  }
}

function sanitizeFolderName(str) {
  return String(str || 'unknown')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
}

// Filename helpers — derive from profile slug so generated bundles are
// clearly attributable when multiple profiles share the same disk.
//
// Filenames now carry a language suffix when the application is bilingual
// or German-only, e.g. CV_divya-dhiraj_de.pdf. Single-language English
// output keeps the unsuffixed name for backward compatibility with rows
// already saved in the applications table.
function cvFilenameFor(profile, ext, language) {
  const slug = (profile && profile.slug) ? profile.slug : 'profile';
  const langSuffix = (language && language !== 'en') ? `_${language}` : '';
  return `CV_${slug}${langSuffix}.${ext}`;
}
function coverLetterFilename(ext, language) {
  const langSuffix = (language && language !== 'en') ? `_${language}` : '';
  return `Cover_Letter${langSuffix}.${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render debouncer — coalesces rapid CV/PDF re-renders.
//
// Every bullet edit / field edit triggers a docx + pdf re-render that takes
// ~2-3s on Apple Silicon Chromium. If the user makes 5 edits in 30 seconds
// they pay 10-15s of cumulative render time, which feels janky.
//
// Solution: keep JSON saves synchronous (we never lose an edit), but
// coalesce the file-render step. After a save we schedule a render
// 800ms later; if another save arrives inside the window we cancel +
// reschedule. Key per (folderPath, language) so concurrent edits to
// English vs German render independently.
//
// pendingRenders also exposes a "flush" path so the preview-PDF endpoint
// can wait for the most recent render to land before serving stale bytes.
// ─────────────────────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 800;
const pendingRenders = new Map();   // key → { timer, fn, promise, resolve }

function scheduleRender(key, renderFn) {
  // If an existing render is queued for this key, cancel + reschedule.
  const existing = pendingRenders.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  // Reuse existing promise if there is one — callers awaiting flushRender
  // get a single promise per key that resolves after the LATEST render.
  const entry = existing || (() => {
    let resolveFn;
    const p = new Promise(r => { resolveFn = r; });
    return { timer: null, fn: renderFn, promise: p, resolve: resolveFn };
  })();
  entry.fn = renderFn;  // always run the latest function (closure over latest data)

  entry.timer = setTimeout(async () => {
    try { await entry.fn(); }
    catch (e) { console.warn('[Render] debounced render failed:', e.message); }
    finally {
      const r = entry.resolve;
      pendingRenders.delete(key);
      r?.();
    }
  }, DEBOUNCE_MS);

  pendingRenders.set(key, entry);
  return entry.promise;
}

// Stable key per (folderPath, language) so EN and DE renders for the
// same application don't trample each other in the debounce map.
function renderKeyFor(folderPath, language = 'en') {
  return `${folderPath}::${language || 'en'}`;
}

// Block until any pending render for this key has flushed. Used by the
// preview-PDF endpoint so the user never sees a stale PDF after edits.
async function flushRender(key) {
  const entry = pendingRenders.get(key);
  if (!entry) return;
  // Force the timer to fire NOW
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => entry.fn().catch(() => {}).then(() => {
      const r = entry.resolve; pendingRenders.delete(key); r?.();
    }), 0);
  }
  return entry.promise;
}

// Wrap a system-prompt string in the content-block shape that supports
// Anthropic's prompt caching. The cache_control: ephemeral marker tells
// the API to cache this prompt server-side; subsequent calls with the
// SAME system block hit the cache (90% input-token savings + 2-5s less
// latency). Cache TTL is ~5 minutes — perfect for our usage where a
// user generates several CVs in a row, or makes multiple edits.
//
// Usage: instead of `system: SYSTEM_PROMPT`, write
//        `system: cached(SYSTEM_PROMPT)`.
function cached(text) {
  return [{ type: 'text', text: String(text || ''), cache_control: { type: 'ephemeral' } }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude API — generate tailored CV + cover letter JSON
// ─────────────────────────────────────────────────────────────────────────────
// Parse a free-form paste from a job board into our normalized shape.
// The user pastes the entire job page (LinkedIn, Indeed, careers site)
// — usually 80% UI chrome around 20% actual JD — and Claude returns
// {title, company, location, apply_url, description, salary, language}.
async function parseRawJobPaste(rawText, profile) {
  if (!rawText || !rawText.trim()) throw new Error('rawText is empty');
  const client = getClient(profile);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: cached(JD_PARSE_SYSTEM_PROMPT),
    messages: [{ role: 'user', content: String(rawText).slice(0, 18000) }],
  });
  const text = response.content[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JD parser did not return JSON');
  const parsed = JSON.parse(m[0]);
  // Defensive: ensure all expected keys exist as strings
  return {
    title:       String(parsed.title || '').trim(),
    company:     String(parsed.company || '').trim(),
    location:    String(parsed.location || '').trim(),
    apply_url:   String(parsed.apply_url || '').trim(),
    description: String(parsed.description || '').trim(),
    salary:      String(parsed.salary || '').trim(),
    language:    String(parsed.language || 'en').trim(),
  };
}

// Translate a free-form chunk of text. Used by /api/translate (Paste-a-Job
// "🌐 Translate" button) — separate from the structured CV translator
// because Claude was sometimes rejecting / mangling responses when fed an
// empty CV stub. A dedicated text-only prompt is faster + more reliable.
async function translateText(text, profile, targetLanguage) {
  const client = getClient(profile);
  const target = targetLanguage === 'de' ? 'German' : 'English';
  const sys = `You are a professional translator. Translate the user's text to ${target} with these rules:

- Preserve formatting, line breaks, bullet points, and any technical terms left in English (SQL, Python, dbt, Tableau, Snowflake, etc.).
- Use formal Hochdeutsch when translating to German (Sie form, not Du).
- Use British English when translating to English.
- Translate ALL natural-language content; do not skip any sentences.
- Output ONLY the translated text. No commentary, no quotes around it, no "Here is the translation:" preamble, no markdown fences.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    // The translator prompt is small and target-language-specific, but
    // it's the same across calls within a target. Cache it anyway.
    system: cached(sys),
    messages: [{ role: 'user', content: String(text || '').slice(0, 12000) }],
  });
  const out = response.content[0]?.text || '';
  return out.trim();
}

// Translate a {cv, coverLetter} object between English and German. Used by
// the dual-language flow (language='both') and by the on-demand
// /api/applications/:id/translate endpoint. Costs ~1 Claude call.
async function translateCvAndCoverLetter(data, profile, targetLanguage) {
  const client = getClient(profile);
  const userPrompt = `Translate the JSON below to ${targetLanguage === 'de' ? 'German' : 'English'}.

INPUT JSON:
${JSON.stringify(data, null, 2)}

Output the translated JSON only.`;
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: cached(TRANSLATION_SYSTEM_PROMPT),
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = response.content[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Translator did not return JSON');
  return JSON.parse(m[0]);
}

// Generate 4 alternative phrasings for a single experience bullet, given
// the bullet's role context, the target JD, and the candidate's resume.
// Used by the per-bullet edit popover in the preview modal.
async function suggestBulletAlternatives({ profile, currentBullet, role, jobTitle, jobCompany, jobDescription, resumeText, language = 'en' }) {
  const client = getClient(profile);
  const userPrompt = `Current bullet:
"${currentBullet}"

Surrounding role: ${role.title || ''}${role.company ? ' at ' + role.company : ''}${role.dates ? ' (' + role.dates + ')' : ''}

Target job:
${jobTitle || ''}${jobCompany ? ' at ' + jobCompany : ''}

Job description (excerpt):
${(jobDescription || '').slice(0, 4000)}

Candidate resume (for grounding — never claim anything not in here):
${(resumeText || '').slice(0, 4000)}

${language === 'de' ? 'Output the 4 alternatives in German (formal Hochdeutsch, "Sie" form-aware verbs).' : 'Output the 4 alternatives in English.'}

Return ONLY a JSON array of 4 strings. No prose around it.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system: cached(BULLET_REWRITE_SYSTEM_PROMPT),
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = response.content[0]?.text || '';
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Bullet rewriter did not return JSON array');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error('Bullet rewriter response is not an array');
  return arr.map(s => String(s).trim()).filter(Boolean).slice(0, 4);
}

async function generateCVAndCoverLetter(job, resumeText, profile, brainContextText = '', language = 'en') {
  const client = getClient(profile);

  const userPrompt = `Generate a tailored CV and cover letter for this job application.

${brainContextText ? brainContextText + '\n\n' : ''}=== CANDIDATE'S GROUND TRUTH RESUME ===
${resumeText}

=== TARGET JOB ===
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Source: ${job.source}

Job Description:
${job.description || 'No description available.'}

Generate the JSON now. Re-read the absolute writing rules and the self-review checklist before you emit it.`;

  // German output: append the German addendum as a SEPARATE cached block.
  // Splitting like this means English and German generations both hit the
  // big SYSTEM_PROMPT cache (the addendum is its own smaller cache layer
  // for German calls). Each block carries its own ephemeral cache marker.
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  if (language === 'de') {
    systemBlocks.push({ type: 'text', text: GERMAN_ADDENDUM, cache_control: { type: 'ephemeral' } });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemBlocks,
  });

  const text = response.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude API — regenerate a section with user edit instructions
//
// Surgical-edit pipeline: send the current CV / cover letter alongside the
// instruction, but in a wrapper that asks Claude to also report which
// fields it touched. After parsing, we re-verify the diff ourselves against
// the previous version — anything Claude rewrote that wasn't in the
// touched-fields list is reverted to the original. This pins Claude to
// the user's intent even when the model is tempted to "improve" untouched
// prose.
// ─────────────────────────────────────────────────────────────────────────────
async function regenerateSection(existingData, target, instruction, resumeText, job, profile) {
  const client = getClient(profile);
  const sectionStr = target === 'cv'
    ? JSON.stringify(existingData.cv, null, 2)
    : String(existingData.coverLetter || '');

  // The wrapper schema forces Claude to declare which fields it changed.
  // For CV edits the change list is structured (path strings into the JSON);
  // for cover-letter edits we just take the user's instruction at face value
  // (the whole text is the editable scope) and rely on the diff after the fact.
  const editSystem = `${EDIT_SYSTEM_PROMPT_PREFIX}

You will receive the current ${target === 'cv' ? 'CV as JSON' : 'cover letter as plain text'} and an edit instruction.

OUTPUT FORMAT (always — no markdown fences, no commentary):
{
  "updated": <the FULL ${target === 'cv' ? 'CV JSON object' : 'cover letter string'} after applying the edit. Untouched fields must be byte-identical to the input.>,
  "changes": [
    "<one short sentence per touched field, e.g. 'Shortened bullet 2 of BMW role.' or 'Tightened cover letter paragraph 3.'>"
  ],
  "scope": "<one of: 'profileSummary', 'experience.<index>.bullets', 'experience.<index>', 'education', 'skills', 'languages', 'coverLetter.paragraph.<n>', 'coverLetter.tone', 'coverLetter.full', 'name|email|phone|address|linkedin'. Pick the SMALLEST scope that covers the instruction.>"
}

The "updated" field is the full document, NOT a diff — but only the fields named in "changes" / "scope" should differ from the input.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: cached(editSystem),
    messages: [{
      role: 'user',
      content: `Current ${target}:
${sectionStr}

Job: ${job.title} at ${job.company}
Candidate resume (for grounding — do NOT rewrite to lean on this unless the instruction asks for it):
${(resumeText || '').slice(0, 6000)}

Edit instruction: ${instruction}

Apply ONLY the requested edit. Leave every other field byte-identical. Output the JSON wrapper now.`
    }],
  });

  const raw = response.content[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Regeneration did not return valid JSON');
  const parsed = JSON.parse(jsonMatch[0]);
  if (parsed.updated === undefined) throw new Error('Regeneration response missing "updated" field');

  const changes = Array.isArray(parsed.changes) ? parsed.changes.filter(s => typeof s === 'string') : [];
  const scope = String(parsed.scope || '').trim();

  if (target === 'cv') {
    const updatedCv = parsed.updated;
    if (!updatedCv || typeof updatedCv !== 'object') throw new Error('Regeneration: updated field is not a CV object');
    // Enforce surgical edit: revert any field outside the declared scope to
    // the original. This catches cases where Claude rewrites untouched bullets
    // even with the strict prompt above.
    const guarded = enforceSurgicalCvEdit(existingData.cv, updatedCv, scope);
    return { ...existingData, cv: guarded, _changes: changes, _scope: scope };
  }
  // Cover letter: the "updated" value should be a string. Trust Claude here
  // since cover-letter edits are usually intentional rewrites.
  const updatedCl = String(parsed.updated || '').trim();
  return { ...existingData, coverLetter: updatedCl, _changes: changes, _scope: scope };
}

// Walk the new CV against the old one, reverting any field whose path is
// NOT in the declared scope. The scope strings come back from Claude as
// "experience.0.bullets", "profileSummary", "skills", etc.
//
// We're conservative: if the scope is unrecognized or empty, we trust
// Claude's output (no surgical guard). If the scope is recognized, we
// allow changes ONLY to fields beneath that path — every other field
// gets snapped back to the original.
function enforceSurgicalCvEdit(oldCv, newCv, scope) {
  if (!scope || scope === 'coverLetter.full' || scope.startsWith('coverLetter.')) {
    // No CV-side scope declared — return Claude's output as-is.
    return newCv;
  }
  // Build the result by deep-copying the old CV, then overwriting only the
  // scoped path with the new value.
  const result = JSON.parse(JSON.stringify(oldCv || {}));
  const segs = scope.split('.');
  // Walk into both old and new in lockstep, copying the new branch into the result at the scope.
  let oldNode = oldCv, newNode = newCv, target = result;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (newNode == null || target == null) return newCv;     // give up, return Claude's
    if (Array.isArray(newNode)) {
      const idx = parseInt(seg, 10);
      if (!Number.isFinite(idx)) return newCv;
      newNode = newNode[idx];
      target  = target[idx];
      oldNode = oldNode?.[idx];
    } else {
      newNode = newNode[seg];
      target  = target[seg];
      oldNode = oldNode?.[seg];
    }
  }
  const last = segs[segs.length - 1];
  if (newNode == null || target == null) return newCv;
  if (Array.isArray(newNode) && /^\d+$/.test(last)) {
    target[parseInt(last, 10)] = newNode[parseInt(last, 10)];
  } else {
    target[last] = newNode[last];
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Folder management
// ─────────────────────────────────────────────────────────────────────────────
function createApplicationFolder(job, profile) {
  if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

  // New applications live under applications/{profile_slug}/. Existing
  // pre-multi-profile folders (the original 4 Divya bundles) remain at the
  // APPS_DIR root and are still served via their absolute paths in the DB.
  const profileSlug = (profile && profile.slug) ? profile.slug : 'profile';
  const profileDir  = path.join(APPS_DIR, profileSlug);
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const folderName = `${sanitizeFolderName(job.company)}_${sanitizeFolderName(job.title)}_${date}`;
  const folderPath = path.join(profileDir, folderName);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const desc = `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\nURL: ${job.apply_url}\nSource: ${job.source}\nMatch Score: ${job.match_score}%\n\n--- Description ---\n${job.description || 'N/A'}`;
  fs.writeFileSync(path.join(folderPath, 'job_description.txt'), desc, 'utf-8');
  // folderName includes profile slug so server.js can build a relative URL
  // that's unambiguous across profiles.
  return { folderPath, folderName: `${profileSlug}/${folderName}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX helpers — match Divya_Dhiraj_CV.docx format exactly
// ─────────────────────────────────────────────────────────────────────────────
const { Document, Packer, Paragraph, TextRun, AlignmentType, TabStopType, BorderStyle, convertInchesToTwip } = docx;

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 190, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: CLR.navy } },
    children: [new TextRun({ text, bold: true, size: SZ.section, font: 'Calibri', color: CLR.navy })],
  });
}

function expTitleLine(exp) {
  const children = [
    new TextRun({ text: `${exp.title}, `, bold: true, size: SZ.expTitle, font: 'Calibri', color: CLR.dark }),
    new TextRun({ text: exp.company, bold: true, size: SZ.expTitle, font: 'Calibri', color: CLR.navy }),
  ];
  if (exp.dates) {
    children.push(new TextRun({ text: `\t${exp.dates}`, size: SZ.expSub, font: 'Calibri', color: CLR.light }));
  }
  return new Paragraph({
    spacing: { before: 100 },
    tabStops: [{ type: TabStopType.RIGHT, position: convertInchesToTwip(6.5) }],
    children,
  });
}

function subLine(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: SZ.expSub, font: 'Calibri', color: CLR.light })],
  });
}

function bulletPara(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 30 },
    children: [new TextRun({ text, size: SZ.bullet, font: 'Calibri', color: CLR.dark })],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CV DOCX — exact replica of Divya_Dhiraj_CV.docx layout
// ─────────────────────────────────────────────────────────────────────────────
async function saveCVAsDocx(cv, job, outputPath) {
  const children = [];

  // Name (18pt, bold, navy, centered)
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    children: [new TextRun({ text: cv.name || 'Candidate', bold: true, size: SZ.name, font: 'Calibri', color: CLR.navy })],
  }));

  // Target title (11pt, dark, centered)
  const headline = cv.targetTitle || job.title || '';
  if (headline) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: headline, size: SZ.subtitle, font: 'Calibri', color: CLR.dark })],
    }));
  }

  // Contact line (9pt, #555, centered)
  const contactParts = [cv.email, cv.phone, cv.address, cv.linkedin].filter(Boolean);
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 160 },
    children: [new TextRun({ text: contactParts.join('  |  '), size: SZ.contact, font: 'Calibri', color: CLR.mid })],
  }));

  // PROFILE SUMMARY
  if (cv.profileSummary) {
    children.push(sectionHeading('PROFILE SUMMARY'));
    children.push(new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: cv.profileSummary, size: SZ.body, font: 'Calibri', color: CLR.dark })],
    }));
  }

  // PROFESSIONAL EXPERIENCE
  if (cv.experience?.length) {
    children.push(sectionHeading('PROFESSIONAL EXPERIENCE'));
    for (const exp of cv.experience) {
      children.push(expTitleLine(exp));
      if (exp.location) children.push(subLine(exp.location));
      for (const b of (exp.bullets || [])) children.push(bulletPara(b));
    }
  }

  // RESEARCH EXPERIENCE (if present)
  if (cv.researchExperience?.length) {
    children.push(sectionHeading('RESEARCH EXPERIENCE'));
    for (const r of cv.researchExperience) {
      const rChildren = [
        new TextRun({ text: `${r.title}, `, bold: true, size: SZ.expTitle, font: 'Calibri', color: CLR.dark }),
        new TextRun({ text: r.institution || '', bold: true, size: SZ.expTitle, font: 'Calibri', color: CLR.navy }),
      ];
      if (r.dates) rChildren.push(new TextRun({ text: `\t${r.dates}`, size: SZ.expSub, font: 'Calibri', color: CLR.light }));
      children.push(new Paragraph({
        spacing: { before: 100 },
        tabStops: [{ type: TabStopType.RIGHT, position: convertInchesToTwip(6.5) }],
        children: rChildren,
      }));
      for (const b of (r.bullets || [])) children.push(bulletPara(b));
    }
  }

  // EDUCATION
  if (cv.education?.length) {
    children.push(sectionHeading('EDUCATION'));
    for (const edu of cv.education) {
      const edChildren = [
        new TextRun({ text: `${edu.degree}, `, bold: true, size: SZ.expTitle, font: 'Calibri', color: CLR.dark }),
        new TextRun({ text: edu.school || '', bold: false, size: SZ.expTitle, font: 'Calibri', color: CLR.dark }),
      ];
      if (edu.dates) edChildren.push(new TextRun({ text: `\t${edu.dates}`, size: SZ.expSub, font: 'Calibri', color: CLR.light }));
      children.push(new Paragraph({
        spacing: { before: 60 },
        tabStops: [{ type: TabStopType.RIGHT, position: convertInchesToTwip(6.5) }],
        children: edChildren,
      }));
      if (edu.details) {
        children.push(new Paragraph({
          children: [new TextRun({ text: edu.details, size: SZ.expSub, font: 'Calibri', color: CLR.mid })],
        }));
      }
    }
  }

  // TECHNICAL SKILLS
  if (cv.skills && typeof cv.skills === 'object') {
    children.push(sectionHeading('TECHNICAL SKILLS'));
    for (const [cat, list] of Object.entries(cv.skills)) {
      const skillsStr = Array.isArray(list) ? list.join(', ') : String(list);
      children.push(new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({ text: `${cat}: `, bold: true, size: SZ.body, font: 'Calibri', color: CLR.dark }),
          new TextRun({ text: skillsStr, size: SZ.body, font: 'Calibri', color: CLR.dark }),
        ],
      }));
    }
  }

  // CERTIFICATIONS & LANGUAGES
  if (cv.certifications?.length || cv.languages?.length) {
    children.push(sectionHeading('CERTIFICATIONS & LANGUAGES'));
    if (cv.certifications?.length) {
      children.push(new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({ text: 'Certification: ', bold: true, size: SZ.body, font: 'Calibri', color: CLR.dark }),
          new TextRun({ text: cv.certifications.join('; '), size: SZ.body, font: 'Calibri', color: CLR.dark }),
        ],
      }));
    }
    if (cv.languages?.length) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: 'Languages: ', bold: true, size: SZ.body, font: 'Calibri', color: CLR.dark }),
          new TextRun({ text: cv.languages.join(', '), size: SZ.body, font: 'Calibri', color: CLR.dark }),
        ],
      }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 540, bottom: 540, left: 720, right: 720 } } },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cover Letter DOCX — original layout, contact info now from active profile
// ─────────────────────────────────────────────────────────────────────────────
async function saveCoverLetterAsDocx(coverLetter, job, cv, outputPath, profile) {
  const children = [];
  // Fallback chain: explicit cv field → profile → empty.
  // This means even if Claude's CV JSON drops a contact field, the profile
  // we have on record still fills it in.
  const name     = cv?.name     || profile?.name     || 'Candidate';
  const email    = cv?.email    || profile?.email    || '';
  const phone    = cv?.phone    || profile?.phone    || '';
  const address  = cv?.address  || profile?.address  || '';
  const linkedin = cv?.linkedin || profile?.linkedin || '';

  // Sender header block
  children.push(new Paragraph({
    spacing: { after: 20 },
    children: [new TextRun({ text: name, bold: true, size: 24, font: 'Calibri', color: CLR.navy })],
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: address, size: SZ.expSub, font: 'Calibri', color: CLR.mid })],
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `${email}  |  ${phone}`, size: SZ.expSub, font: 'Calibri', color: CLR.mid })],
  }));
  children.push(new Paragraph({
    spacing: { after: 200 },
    children: [new TextRun({ text: linkedin, size: SZ.expSub, font: 'Calibri', color: CLR.mid })],
  }));

  // Date (right-aligned)
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const loc = (cv?.address || address || '').split(',')[0].trim() || '';
  children.push(new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { after: 160 },
    children: [new TextRun({ text: `${loc}, ${dateStr}`, size: SZ.body, font: 'Calibri', color: CLR.dark })],
  }));

  // Recipient
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Hiring Manager', bold: true, size: SZ.body, font: 'Calibri', color: CLR.dark })],
  }));
  children.push(new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text: job.company || '', size: SZ.body, font: 'Calibri', color: CLR.dark })],
  }));

  // Subject line
  children.push(new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text: `Application for: ${job.title}`, bold: true, size: 22, font: 'Calibri', color: CLR.dark })],
  }));

  // Body paragraphs
  const paragraphs = coverLetter.split(/\n\n+/).filter(p => p.trim());
  for (const para of paragraphs) {
    children.push(new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: para.trim(), size: SZ.body, font: 'Calibri', color: CLR.dark })],
    }));
  }

  // Signature
  children.push(new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: 'Best Regards', size: SZ.body, font: 'Calibri', color: CLR.dark })] }));
  children.push(new Paragraph({ spacing: { before: 60 }, children: [new TextRun({ text: name, bold: true, size: SZ.body, font: 'Calibri', color: CLR.dark })] }));

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF generation via Puppeteer — styled to match the DOCX
// ─────────────────────────────────────────────────────────────────────────────
function cvToHtml(cv, job) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const contact = [cv.email, cv.phone, cv.address, cv.linkedin].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');
  const headline = cv.targetTitle || (job && job.title) || '';

  let html = `<div class="cv">
    <h1>${esc(cv.name)}</h1>
    ${headline ? `<p class="headline">${esc(headline)}</p>` : ''}
    <p class="contact">${contact}</p>`;

  if (cv.profileSummary) html += `<h2>PROFILE SUMMARY</h2><p>${esc(cv.profileSummary)}</p>`;

  if (cv.experience?.length) {
    html += `<h2>PROFESSIONAL EXPERIENCE</h2>`;
    for (const exp of cv.experience) {
      html += `<div class="entry"><div class="entry-head"><span><strong>${esc(exp.title)},</strong> <span class="company">${esc(exp.company)}</span></span><span class="dates">${esc(exp.dates || '')}</span></div>`;
      if (exp.location) html += `<div class="sub">${esc(exp.location)}</div>`;
      html += `<ul>`;
      for (const b of (exp.bullets || [])) html += `<li>${esc(b)}</li>`;
      html += `</ul></div>`;
    }
  }

  if (cv.researchExperience?.length) {
    html += `<h2>RESEARCH EXPERIENCE</h2>`;
    for (const r of cv.researchExperience) {
      html += `<div class="entry"><div class="entry-head"><span><strong>${esc(r.title)},</strong> <span class="company">${esc(r.institution || '')}</span></span><span class="dates">${esc(r.dates || '')}</span></div><ul>`;
      for (const b of (r.bullets || [])) html += `<li>${esc(b)}</li>`;
      html += `</ul></div>`;
    }
  }

  if (cv.education?.length) {
    html += `<h2>EDUCATION</h2>`;
    for (const edu of cv.education) {
      html += `<div class="entry"><div class="entry-head"><span><strong>${esc(edu.degree)},</strong> ${esc(edu.school)}</span><span class="dates">${esc(edu.dates || '')}</span></div>`;
      if (edu.details) html += `<p class="sub">${esc(edu.details)}</p>`;
      html += `</div>`;
    }
  }

  if (cv.skills && typeof cv.skills === 'object') {
    html += `<h2>TECHNICAL SKILLS</h2><div class="skills">`;
    for (const [cat, list] of Object.entries(cv.skills)) {
      const str = Array.isArray(list) ? list.join(', ') : String(list);
      html += `<p><strong>${esc(cat)}:</strong> ${esc(str)}</p>`;
    }
    html += `</div>`;
  }

  if (cv.certifications?.length || cv.languages?.length) {
    html += `<h2>CERTIFICATIONS & LANGUAGES</h2>`;
    if (cv.certifications?.length) html += `<p><strong>Certification:</strong> ${cv.certifications.map(esc).join('; ')}</p>`;
    if (cv.languages?.length) html += `<p><strong>Languages:</strong> ${cv.languages.map(esc).join(', ')}</p>`;
  }

  html += `</div>`;
  return html;
}

function coverLetterToHtml(coverLetter, job, cv, profile) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const name     = cv?.name     || profile?.name     || 'Candidate';
  const email    = cv?.email    || profile?.email    || '';
  const phone    = cv?.phone    || profile?.phone    || '';
  const address  = cv?.address  || profile?.address  || '';
  const linkedin = cv?.linkedin || profile?.linkedin || '';
  const loc = (cv?.address || profile?.address || '').split(',')[0].trim();
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const paragraphs = coverLetter.split(/\n\n+/).filter(p => p.trim());

  return `<div class="cover-letter">
    <div class="cl-header">
      <div class="cl-name">${esc(name)}</div>
      <div class="cl-contact">${esc(address)}</div>
      <div class="cl-contact">${esc(email)} &nbsp;|&nbsp; ${esc(phone)}</div>
      <div class="cl-contact">${esc(linkedin)}</div>
    </div>
    <p class="cl-date">${esc(loc)}, ${dateStr}</p>
    <p><strong>Hiring Manager</strong><br>${esc(job.company)}</p>
    <p><strong>Application for: ${esc(job.title)}</strong></p>
    ${paragraphs.map(p => `<p>${esc(p.trim())}</p>`).join('\n')}
    <p class="cl-sign">Best Regards<br><strong>${esc(name)}</strong></p>
  </div>`;
}

const PDF_STYLE = `
  body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; color: #333; margin: 0; padding: 35px 45px; font-size: 10.5pt; line-height: 1.45; }
  h1 { font-size: 18pt; text-align: center; margin-bottom: 0; color: #1F4E79; font-weight: 700; }
  .headline { text-align: center; color: #333; font-size: 11pt; margin: 2px 0 4px; }
  .contact { text-align: center; color: #555; font-size: 9pt; margin-bottom: 14px; }
  h2 { font-size: 12pt; text-transform: uppercase; color: #1F4E79; border-bottom: 1.5px solid #1F4E79; padding-bottom: 2px; margin-top: 14px; margin-bottom: 6px; font-weight: 700; letter-spacing: 0.3px; }
  .entry { margin-bottom: 8px; }
  .entry-head { display: flex; justify-content: space-between; align-items: baseline; }
  .company { color: #1F4E79; font-weight: 700; }
  .dates { color: #666; font-size: 9.5pt; white-space: nowrap; }
  .sub { color: #666; font-size: 9.5pt; margin: 1px 0; }
  ul { margin: 3px 0 6px 16px; padding: 0; }
  li { margin-bottom: 2px; }
  .skills p { margin: 1px 0; }
  p { margin: 5px 0; }
  .cover-letter { }
  .cl-header { margin-bottom: 14px; }
  .cl-name { font-size: 14pt; font-weight: 700; color: #1F4E79; }
  .cl-contact { font-size: 9.5pt; color: #555; }
  .cl-date { text-align: right; color: #333; margin-bottom: 14px; }
  .cl-sign { margin-top: 24px; }
`;

async function saveAsPdf(htmlInput, outputPath, marginOverride) {
  // The template-driven CV path passes a full HTML document (includes
  // <!DOCTYPE>); the legacy cover-letter path passes bare body markup.
  // Detect which we got and only wrap when needed.
  const isFullDoc = /^<!doctype html/i.test(String(htmlInput || '').trimStart());
  const fullHtml = isFullDoc
    ? htmlInput
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PDF_STYLE}</style></head><body>${htmlInput}</body></html>`;
  const margin = marginOverride || { top: '12mm', bottom: '12mm', left: '14mm', right: '14mm' };
  // First Chromium launch after a fresh install is slow (browser
  // initializes profile dirs etc.). 'networkidle0' was overkill for the
  // pure-inline HTML we render — switch to 'load' which fires when DOM +
  // inline resources are ready, and bump the timeout so first-run latency
  // doesn't blow up the generate pipeline.
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120000);
    await page.setContent(fullHtml, { waitUntil: 'load', timeout: 120000 });
    await page.pdf({ path: outputPath, format: 'A4', printBackground: true, margin });
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// Per-language render: takes a {cv, coverLetter} payload and writes
// CV_<slug>[_<lang>].docx, .pdf and Cover_Letter[_<lang>].docx, .pdf into
// the application folder. Returns the relative filenames for the DB row.
async function renderOneLanguage(folderPath, job, profile, payload, language) {
  // Language suffix only on non-English files so single-language English
  // applications keep their original filenames.
  const cvDocxName = cvFilenameFor(profile, 'docx', language);
  const cvPdfName  = cvFilenameFor(profile, 'pdf',  language);
  const clDocxName = coverLetterFilename('docx', language);
  const clPdfName  = coverLetterFilename('pdf',  language);

  // prepareCv merges profile-side personal data, embeds photo, applies
  // visibility flags. We do this AFTER translation (if any) so the
  // visibility flags + photo apply identically to both languages.
  const renderCv = templates.prepareCv(payload.cv, profile);

  // Parallelize the four file writes — DOCX renders are CPU-bound (no I/O
  // contention), PDF renders spawn separate Chromium contexts. Saves
  // ~2-3s per language vs the old sequential await chain.
  const cvHtml = templates.renderCvHtml(renderCv, profile);
  const clHtml = coverLetterToHtml(payload.coverLetter, job, renderCv, profile);
  const cvMargin = templates.pdfMarginFor(profile);
  await Promise.all([
    saveCVAsDocx(renderCv, job, path.join(folderPath, cvDocxName)),
    saveCoverLetterAsDocx(payload.coverLetter, job, renderCv, path.join(folderPath, clDocxName), profile),
    saveAsPdf(cvHtml, path.join(folderPath, cvPdfName), cvMargin),
    saveAsPdf(clHtml, path.join(folderPath, clPdfName)),
  ]);

  return { cvDocxName, cvPdfName, clDocxName, clPdfName };
}

async function generateAndSave(job, profile, options = {}) {
  const p = profile || requireActiveProfile();
  // language: 'en' | 'de' | 'both'  (default 'en' — backward-compatible)
  const language = ['en', 'de', 'both'].includes(options.language) ? options.language : 'en';

  // Resume selection: caller may pass options.resumeId to force a specific
  // resume from the library; otherwise the picker auto-selects the best
  // match (or returns the only resume on file when there's just one).
  const picked = await pickResumeForJob(p, job, { explicitResumeId: options.resumeId || null });
  const resumeText = loadResume(p, picked.resume);
  console.log(`[Generator] Resume selected: "${picked.resume?.label || 'Default'}" (${picked.auto ? 'auto' : 'manual'}) — ${picked.reasoning}`);

  // ── Brain pre-pass: analyze the JD AND assemble retrieval context ──
  // We run them in parallel. analyzeJobAndCompany is a Claude call (~3-5s).
  // retrieveContext is mostly DB + embedding cosine work — its only soft
  // dependency on analyze is the archetypeId (used to filter angle-specific
  // insights). On a true cold start retrieve runs without an archetype and
  // returns the global slice; from the second generation onward the cached
  // archetype is already there, so retrieveContext picks it up via lookup.
  // Net: we shave 3-5s off every generation.
  console.log(`[Brain] Analyzing JD + assembling context (parallel) for "${job.title}" @ ${job.company}...`);
  let brainAnalysis = null;
  let brainCtxText = '';
  const [analyzeResult, retrieveResult] = await Promise.allSettled([
    brain.analyzeJobAndCompany(p, job),
    brain.retrieveContext(p, job, { archetypeId: null }),
  ]);
  if (analyzeResult.status === 'fulfilled') brainAnalysis = analyzeResult.value;
  else console.warn(`[Brain] analyzeJobAndCompany failed: ${analyzeResult.reason?.message || analyzeResult.reason}`);
  if (retrieveResult.status === 'fulfilled') {
    const ctx = retrieveResult.value;
    brainCtxText = brain.formatContextForPrompt(ctx);
    console.log(`[Brain] Context — angle="${ctx.angle?.name || '(none, ran in parallel)'}", ${ctx.similar_past_applications.length} similar apps, ${ctx.angle_insights.length} angle insights, ${ctx.global_insights.length} global insights, ${ctx.angle_facts.length + ctx.global_facts.length} facts.`);
  } else {
    console.warn(`[Brain] retrieveContext failed: ${retrieveResult.reason?.message || retrieveResult.reason}`);
  }

  // ── Decide what to generate ──
  // For 'both', generate the primary in English (better Claude quality on
  // English source resume) then translate to German. Cheaper than two full
  // generations and the German output stays consistent with the English.
  // For 'de' only, generate directly in German from the start.
  const primaryLang = (language === 'de') ? 'de' : 'en';
  console.log(`[Generator] Calling Claude API for "${job.title}" at ${job.company} (profile: ${p.name}, language=${language}, primary=${primaryLang})...`);
  const primaryData = await generateCVAndCoverLetter(job, resumeText, p, brainCtxText, primaryLang);
  console.log(`[Generator] Claude returned ${primaryLang} CV + cover letter.`);

  const languages = { [primaryLang]: primaryData };

  if (language === 'both') {
    // Translate the English to German via the dedicated translation prompt.
    // Cheaper + more consistent than running the full generator twice.
    console.log(`[Generator] Translating to German...`);
    languages.de = await translateCvAndCoverLetter(primaryData, p, 'de');
    console.log(`[Generator] German translation done.`);
  }

  const { folderPath, folderName } = createApplicationFolder(job, p);

  // generated.json schema — keeps the raw Claude output for every language
  // saved so /api/applications/:id/edit can regenerate any single language
  // without re-running the whole pipeline.
  const generatedJson = {
    primary_language: primaryLang,
    languages_available: Object.keys(languages),
    languages,
    // Backward-compat aliases — legacy code paths read .cv and .coverLetter
    // directly from the JSON. Mirror the primary language's content here.
    cv: primaryData.cv,
    coverLetter: primaryData.coverLetter,
  };
  fs.writeFileSync(path.join(folderPath, 'generated.json'), JSON.stringify(generatedJson, null, 2), 'utf-8');

  // Render every requested language to disk. For single-language English
  // requests, the helper writes files without a language suffix (preserves
  // existing on-disk paths in older application rows).
  const renderedFiles = {};
  for (const [lang, payload] of Object.entries(languages)) {
    const useSuffix = (language === 'both') ? lang : (lang === 'en' ? null : lang);
    renderedFiles[lang] = await renderOneLanguage(folderPath, job, p, payload, useSuffix);
  }

  console.log(`[Generator] All files saved to ${folderPath} (languages: ${Object.keys(languages).join(', ')})`);

  // The application row stores the *primary* language's PDF path — UI
  // surfaces additional languages by checking generated.json.
  const primaryFiles = renderedFiles[primaryLang];
  return {
    folderPath, folderName, data: primaryData, profile: p,
    cvDocxName: primaryFiles.cvDocxName,
    cvPdfName:  primaryFiles.cvPdfName,
    languages,
    renderedFiles,
    brain: brainAnalysis,
    resume_used: picked.resume ? {
      id: picked.resume.id,
      label: picked.resume.label || 'Default',
      auto: picked.auto,
      reasoning: picked.reasoning || '',
    } : null,
  };
}

async function regenerateAndSave(folderPath, target, instruction, job, profile) {
  const p = profile || requireActiveProfile();
  const resumeText = loadResume(p);
  const jsonPath = path.join(folderPath, 'generated.json');
  const existingData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  console.log(`[Generator] Regenerating ${target} with instruction: "${instruction.slice(0, 60)}..."`);
  const updatedData = await regenerateSection(existingData, target, instruction, resumeText, job, p);
  // _changes / _scope are runtime metadata for the UI — strip before persisting.
  const { _changes, _scope, ...persistable } = updatedData;
  fs.writeFileSync(jsonPath, JSON.stringify(persistable, null, 2), 'utf-8');

  if (target === 'cv') {
    const cvDocxName = cvFilenameFor(p, 'docx');
    const cvPdfName  = cvFilenameFor(p, 'pdf');
    const renderCv   = templates.prepareCv(updatedData.cv, p);
    await saveCVAsDocx(renderCv, job, path.join(folderPath, cvDocxName));
    await saveAsPdf(templates.renderCvHtml(renderCv, p), path.join(folderPath, cvPdfName), templates.pdfMarginFor(p));
  } else {
    const renderCv = templates.prepareCv(updatedData.cv, p);
    await saveCoverLetterAsDocx(updatedData.coverLetter, job, renderCv, path.join(folderPath, coverLetterFilename('docx')), p);
    await saveAsPdf(coverLetterToHtml(updatedData.coverLetter, job, renderCv, p), path.join(folderPath, coverLetterFilename('pdf')));
  }

  console.log(`[Generator] ${target} regenerated and saved. Scope: ${_scope || '(unspecified)'}; ${(_changes || []).length} change(s).`);
  // Return the runtime metadata so the API can surface it to the UI.
  return { ...persistable, changes: _changes || [], scope: _scope || '' };
}

// Add a translation of an existing application. Reads the saved
// generated.json, runs the translator, writes new docx/pdf with the
// language suffix, updates generated.json with the new language entry.
// Used by /api/applications/:id/translate when the user opens an
// English-only application and wants the German version too.
async function translateExistingApplication(folderPath, targetLanguage, job, profile) {
  if (!['en', 'de'].includes(targetLanguage)) throw new Error('targetLanguage must be en or de');
  const p = profile || requireActiveProfile();
  const jsonPath = path.join(folderPath, 'generated.json');
  if (!fs.existsSync(jsonPath)) throw new Error('generated.json not found in folder');
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  // Find a source language — prefer the one that's NOT the target.
  const have = data.languages || {};
  const sourceLang = (targetLanguage === 'de')
    ? (have.en ? 'en' : Object.keys(have)[0])
    : (have.de ? 'de' : Object.keys(have)[0]);
  if (!sourceLang) throw new Error('No source content found in generated.json');
  const sourcePayload = have[sourceLang] || { cv: data.cv, coverLetter: data.coverLetter };

  console.log(`[Generator] Translating ${sourceLang} → ${targetLanguage} for ${folderPath}...`);
  const translated = await translateCvAndCoverLetter(sourcePayload, p, targetLanguage);

  // Save into the JSON
  data.languages = { ...have, [targetLanguage]: translated };
  data.languages_available = Object.keys(data.languages);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

  // Render the new language's files (always with suffix, since we're
  // adding a non-primary language to an existing application).
  const files = await renderOneLanguage(folderPath, job, p, translated, targetLanguage);
  console.log(`[Generator] Translation rendered: ${files.cvPdfName}, ${files.clPdfName}`);
  return { translated, files };
}

// Patch a single bullet inside generated.json + re-render that language's
// CV docx + pdf. Re-rendering is fast (~2s on Apple Silicon Chromium)
// because no Claude calls happen — we just rebuild the static docs.
async function applyBulletEdit({ folderPath, language = 'en', experienceIndex, bulletIndex, newText, job, profile }) {
  const p = profile || requireActiveProfile();
  const jsonPath = path.join(folderPath, 'generated.json');
  if (!fs.existsSync(jsonPath)) throw new Error('generated.json not found');
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  // Locate the right CV payload — multi-language schema vs. legacy single
  // language. Both code paths should produce a usable cv object.
  const langs = data.languages || {};
  let payload = langs[language];
  if (!payload && language === (data.primary_language || 'en')) {
    // Legacy: pre-bilingual schema only had top-level cv + coverLetter.
    payload = { cv: data.cv, coverLetter: data.coverLetter };
  }
  if (!payload || !payload.cv) throw new Error(`No CV content found for language ${language}`);

  const exp = payload.cv.experience?.[experienceIndex];
  if (!exp || !Array.isArray(exp.bullets)) throw new Error('experience entry not found');
  if (bulletIndex < 0 || bulletIndex >= exp.bullets.length) throw new Error('bullet index out of range');

  const oldText = exp.bullets[bulletIndex];
  exp.bullets[bulletIndex] = String(newText).trim();

  // Persist the change. Mirror to the legacy top-level cv when this is
  // the primary language so legacy readers see the new text too.
  if (data.languages) {
    data.languages[language] = payload;
  }
  if (language === (data.primary_language || 'en')) {
    data.cv = payload.cv;
    data.coverLetter = payload.coverLetter;
  }
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

  // Re-render this language's CV. We don't touch the cover letter (a
  // bullet edit doesn't affect it) — saves ~2 seconds. The actual
  // file-write is debounced, so multiple rapid edits collapse into a
  // single render at the end.
  const useSuffix = (data.languages_available?.length > 1) ? language : (language === 'en' ? null : language);
  const cvDocxName = cvFilenameFor(p, 'docx', useSuffix);
  const cvPdfName  = cvFilenameFor(p, 'pdf',  useSuffix);
  const renderCv   = templates.prepareCv(payload.cv, p);
  const renderKey  = renderKeyFor(folderPath, language);
  scheduleRender(renderKey, async () => {
    await Promise.all([
      saveCVAsDocx(renderCv, job, path.join(folderPath, cvDocxName)),
      saveAsPdf(templates.renderCvHtml(renderCv, p), path.join(folderPath, cvPdfName), templates.pdfMarginFor(p)),
    ]);
  });

  return { oldText, newText: exp.bullets[bulletIndex], cvDocxName, cvPdfName, renderKey };
}

// Apply a generic field edit at an arbitrary path into the saved CV
// JSON. Used by the inline editor in the draft view to update names,
// titles, dates, summaries, skills, education entries, cover letter
// paragraphs — anything that's a string/array inside the CV payload.
//
// Path syntax:
//   "cv.name"                    → cv.name
//   "cv.targetTitle"             → cv.targetTitle
//   "cv.profileSummary"          → cv.profileSummary
//   "cv.experience.0.title"      → cv.experience[0].title
//   "cv.experience.0.bullets.2"  → cv.experience[0].bullets[2] (also works,
//                                  but applyBulletEdit is preferred for bullets
//                                  because it logs to brain_achievements)
//   "cv.education.1.school"      → cv.education[1].school
//   "cv.skills"                  → cv.skills (whole object — value must be a JSON object)
//   "cv.skills.Languages"        → cv.skills.Languages (must be an array)
//   "coverLetter"                → the cover letter text as a single string
//
// Re-renders the CV docx + pdf for the affected language. The cover
// letter is also re-rendered when the path is "coverLetter".
async function applyFieldEdit({ folderPath, language = 'en', path, value, job, profile }) {
  const p = profile || requireActiveProfile();
  if (!path || typeof path !== 'string') throw new Error('path required');

  const jsonPath = require('path').join(folderPath, 'generated.json');
  const fsLocal = require('fs');
  if (!fsLocal.existsSync(jsonPath)) throw new Error('generated.json not found');
  const data = JSON.parse(fsLocal.readFileSync(jsonPath, 'utf-8'));

  const langs = data.languages || {};
  let payload = langs[language];
  if (!payload && language === (data.primary_language || 'en')) {
    payload = { cv: data.cv, coverLetter: data.coverLetter };
  }
  if (!payload) throw new Error(`No content for language ${language}`);

  // Walk the path, mutating in place.
  const segments = path.split('.');
  let target = payload;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (target == null) throw new Error(`Path "${path}" hits null at segment "${seg}"`);
    target = target[seg];
  }
  if (target == null) throw new Error(`Path "${path}" hits null before final segment`);
  const lastSeg = segments[segments.length - 1];
  target[lastSeg] = value;

  // Persist back to JSON. Mirror to the legacy top-level cv/coverLetter
  // when this is the primary language, so legacy readers see the change.
  if (data.languages) data.languages[language] = payload;
  if (language === (data.primary_language || 'en')) {
    data.cv = payload.cv;
    data.coverLetter = payload.coverLetter;
  }
  fsLocal.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

  // Decide what to re-render. If the path touched the cover letter, also
  // re-render the cover letter PDF. CV-side changes always re-render the
  // CV. Renders are debounced — a burst of edits collapses to a single
  // render at the end of the burst.
  const useSuffix = (data.languages_available?.length > 1) ? language : (language === 'en' ? null : language);
  const renderCv = templates.prepareCv(payload.cv, p);
  const cvDocxName = cvFilenameFor(p, 'docx', useSuffix);
  const cvPdfName  = cvFilenameFor(p, 'pdf',  useSuffix);
  const touchesCoverLetter = path === 'coverLetter' || path.startsWith('coverLetter.');
  const clDocxName = touchesCoverLetter ? coverLetterFilename('docx', useSuffix) : null;
  const clPdfName  = touchesCoverLetter ? coverLetterFilename('pdf',  useSuffix) : null;
  const renderKey  = renderKeyFor(folderPath, language);
  const pathJoin   = require('path').join;
  scheduleRender(renderKey, async () => {
    const tasks = [
      saveCVAsDocx(renderCv, job, pathJoin(folderPath, cvDocxName)),
      saveAsPdf(templates.renderCvHtml(renderCv, p), pathJoin(folderPath, cvPdfName), templates.pdfMarginFor(p)),
    ];
    if (touchesCoverLetter) {
      tasks.push(saveCoverLetterAsDocx(payload.coverLetter, job, renderCv, pathJoin(folderPath, clDocxName), p));
      tasks.push(saveAsPdf(coverLetterToHtml(payload.coverLetter, job, renderCv, p), pathJoin(folderPath, clPdfName)));
    }
    await Promise.all(tasks);
  });

  return { path, applied_value: value, renderKey };
}

module.exports = {
  generateAndSave, regenerateAndSave,
  translateExistingApplication, translateCvAndCoverLetter, translateText,
  suggestBulletAlternatives, applyBulletEdit, applyFieldEdit,
  parseRawJobPaste,
  flushRender, renderKeyFor,
  pickResumeForJob, summarizeResume,
  APPS_DIR, cvFilenameFor, coverLetterFilename,
};
