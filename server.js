// server.js — Express server + cron pipeline + REST API.
// Multi-profile aware: every operation that touches jobs/applications/scrape
// runs against the active profile. Profile + settings management endpoints
// drive a setup wizard when no profile exists yet.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { scrapeAll, applyProfile: applyScraperProfile, setApifyToken, setLinkedInCookie, setActorOverrides, isValidApplyUrl, getLocationFilter, setSearchTitles } = require('./scraper');
const { setProfile: setMatcherProfile, scoreJob, getInferredTitles, getResumeKeywords } = require('./matcher');
const { sendDigestEmail, sendTestEmail, applyMailerSettings } = require('./emailer');
const db = require('./database');
const { profileFromUpload, extractResumeText } = require('./profile');
const { generateAndSave, regenerateAndSave, translateExistingApplication, translateCvAndCoverLetter, translateText, suggestBulletAlternatives, applyBulletEdit, applyFieldEdit, parseRawJobPaste, flushRender, renderKeyFor, summarizeResume, APPS_DIR, cvFilenameFor, coverLetterFilename } = require('./generator');
const { listCountries, listPresets } = require('./location');
const brain = require('./brain');
const brainDb = require('./brain_db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '4mb' }));
// Static assets are served before auth runs so the login page itself loads.
// The auth middleware below populates req.profile from the session cookie
// when present; routes decide whether they need a logged-in profile.
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => auth.loadSession(req, res, next));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

let isScraping = false;
let lastScrapeTime = null;

// ─────────────────────────────
// Settings helpers
// ─────────────────────────────
function getMinMatchScore() {
  return parseInt(db.getSetting('min_match_score') || process.env.MIN_MATCH_SCORE || '30');
}
function getScrapeIntervalHours() {
  return parseInt(db.getSetting('scrape_interval_hours') || process.env.SCRAPE_INTERVAL_HOURS || '1');
}

// Apply per-profile state to the in-process modules (matcher, scraper, mailer).
// Now called per-request — there's no global "active profile" anymore. Every
// route that runs the matcher/scraper/mailer applies the session profile's
// state on entry, since multiple users may be hitting the server at once.
function applyProfileState(profile) {
  if (!profile) return null;
  setMatcherProfile(profile);
  applyScraperProfile(profile);  // applyProfile inside scraper.js also picks up linkedin_cookie_override
  setApifyToken(profile.apify_token_override || db.getSetting('apify_token') || '');
  // applyScraperProfile already sets the cookie via applyProfile, but we
  // call setLinkedInCookie again here as a defensive belt-and-braces in
  // case applyScraperProfile gets refactored. The override fields lifecycle
  // is identical to apify_token / openai_key — settings-driven per profile.
  setLinkedInCookie(profile.linkedin_cookie_override || '');
  // Apify actor IDs — overridable via app_settings so the user can switch
  // to a different LinkedIn cookie-supporting actor without code edits if
  // bebity's free tier is unavailable for them or the actor gets renamed.
  setActorOverrides({
    linkedin_public: db.getSetting('linkedin_actor_public_id'),
    linkedin_auth:   db.getSetting('linkedin_actor_auth_id'),
    indeed:          db.getSetting('indeed_actor_id'),
  });
  applyMailerSettings({
    resendKey:   profile.resend_key_override || db.getSetting('resend_api_key') || process.env.RESEND_API_KEY || '',
    fromEmail:   db.getSetting('from_email') || 'Job Dashboard <onboarding@resend.dev>',
    notifyEmail: profile.notify_email || process.env.NOTIFY_EMAIL || '',
  });
  return profile;
}

// ─────────────────────────────
// Core scrape pipeline (profile-scoped)
// ─────────────────────────────
// Runs for ONE profile. The cron entrypoint runScrapeAllProfiles() loops
// over all registered profiles and calls this for each.
async function runScrapePipeline(targetProfile) {
  if (isScraping) {
    console.log('[Server] Scrape already in progress, skipping.');
    return { skipped: true };
  }

  const profile = targetProfile;
  if (!profile) {
    console.warn('[Server] runScrapePipeline called with no profile — skipped.');
    return { skipped: true, reason: 'no-profile' };
  }

  // Re-apply this profile's settings to the matcher + scraper + mailer
  // before we run. Different profiles have different titles, countries,
  // skill groups, notify emails — we can't share state across profiles
  // in one cron tick.
  applyProfileState(profile);

  isScraping = true;
  lastScrapeTime = new Date().toISOString();
  const newJobs = [];

  try {
    const allJobs = await scrapeAll();
    console.log(`[Server] Scraped ${allJobs.length} raw jobs for "${profile.name}". Applying filters...`);

    // Filter 1: Allowed countries from active profile
    const isAllowed = getLocationFilter();
    const localJobs = allJobs.filter(job => {
      if (isAllowed(job.location)) return true;
      console.log(`[Filter:Location] Dropped — outside allowed countries: "${job.title}" @ "${job.location}" (${job.source})`);
      return false;
    });
    console.log(`[Filter:Location] ${localJobs.length}/${allJobs.length} jobs in allowed countries.`);

    // Filter 2: Valid apply URL
    const validUrlJobs = localJobs.filter(job => {
      if (isValidApplyUrl(job.apply_url)) return true;
      console.log(`[Filter:URL] Dropped — no valid apply URL: "${job.title}" (${job.source})`);
      return false;
    });
    console.log(`[Filter:URL] ${validUrlJobs.length}/${localJobs.length} jobs have a valid apply link.`);

    // Score against active profile. scoreJob is now async because it awaits
    // embeddings — sequential await keeps the embedding pipeline (which
    // batches internally on bge-base) from being hammered by 240 concurrent
    // calls all racing for the same model singleton.
    for (const job of validUrlJobs) {
      const { match_score, matched_skills } = await scoreJob(job);
      job.match_score = match_score;
      job.matched_skills = matched_skills;
    }

    const minScore = getMinMatchScore();
    const relevantJobs = validUrlJobs.filter(job => {
      if (job.match_score >= minScore) return true;
      console.log(`[Filter:Score] Dropped — score ${job.match_score} < ${minScore}: "${job.title}" (${job.source})`);
      return false;
    });
    console.log(`[Filter:Score] ${relevantJobs.length}/${validUrlJobs.length} jobs meet min score (≥${minScore}).`);

    for (const job of relevantJobs) {
      const isNew = db.upsertJob(job, profile.id);
      if (isNew && !db.wasNotificationSent(profile.id, job.id)) {
        newJobs.push(job);
        db.markNotificationSent(profile.id, job.id);
      }
    }

    try { db.logScrape({ profileId: profile.id, source: 'all', jobs_found: relevantJobs.length, jobs_new: newJobs.length }); } catch {}
    console.log(`[Server] Pipeline done. ${newJobs.length} new jobs stored for profile "${profile.name}".`);

    // Email digest for new jobs above 40% match
    const notifyJobs = newJobs.filter(j => j.match_score >= 40);
    if (notifyJobs.length > 0) {
      await sendDigestEmail(notifyJobs, profile);
    }

    return { total: allJobs.length, newCount: newJobs.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.error('[Server] Scrape pipeline error:', msg, stack);
    db.logScrape({ profileId: profile.id, source: 'all', jobs_found: 0, jobs_new: 0, status: 'error', error: msg });
    throw err;
  } finally {
    isScraping = false;
  }
}

// Cron entrypoint: scrape for every registered profile in sequence.
// Sequential (not parallel) so we don't blow Apify rate limits and so each
// profile's matcher/scraper state setup doesn't race with another.
async function runScrapeAllProfiles() {
  // Honor the user's "scheduled scraping" toggle. Default is enabled (true)
  // for backward compatibility — only disabled if user explicitly flipped
  // it off in Settings. The manual /api/scrape endpoint always runs and
  // ignores this flag.
  const cronEnabled = (db.getSetting('cron_enabled') ?? 'true') !== 'false';
  if (!cronEnabled) {
    console.log('[Cron] cron_enabled=false — scheduled scrape skipped. Use "Scrape Now" to run manually.');
    return { skipped: true, reason: 'cron-disabled' };
  }
  const profiles = db.listProfiles();
  if (!profiles.length) return { skipped: true, reason: 'no-profiles' };
  console.log(`[Cron] Scraping for ${profiles.length} profile(s)...`);
  const results = [];
  for (const summary of profiles) {
    try {
      const full = db.getProfile(summary.id);
      if (!full) continue;
      const r = await runScrapePipeline(full);
      results.push({ profile: full.name, ...r });
    } catch (e) {
      results.push({ profile: summary.name, error: e.message });
    }
  }
  return { results };
}

// ─────────────────────────────
// Helper for endpoints — returns the profile from the session cookie.
// The dashboard is now login-gated; if there's no session, the frontend
// has already redirected to /login.html. We return 401 here as a safety
// net for any direct API call without a session.
// ─────────────────────────────
function requireProfile(req, res) {
  if (!req.profile) {
    res.status(401).json({ error: 'unauthorized', message: 'Login required' });
    return null;
  }
  return req.profile;
}

// ─────────────────────────────
// Auth API (login + signup + session)
// ─────────────────────────────

// Whether any profiles exist — used by the login screen to show "Create the
// first profile" instead of "Login or sign up" on a fresh install.
app.get('/api/auth/bootstrap', (req, res) => {
  const profiles = db.listProfiles();
  res.json({
    has_profiles: profiles.length > 0,
    has_session:  !!req.profile,
    profile:      req.profile ? { id: req.profile.id, username: req.profile.username, name: req.profile.name } : null,
  });
});

// Who am I? Used by the dashboard on every page load.
app.get('/api/auth/me', (req, res) => {
  if (!req.profile) return res.status(401).json({ error: 'unauthorized' });
  const { password_hash, ...safe } = req.profile;
  res.json({ profile: safe });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const r = await auth.login({ username, password });
    if (!r.ok) {
      // password_must_change initial-set flow:
      if (r.error === 'no-password-set') {
        return res.status(409).json({
          error: 'no-password-set',
          message: 'This profile exists but has no password yet. Use /api/auth/change-password with the profileId to set one.',
          profileId: r.profileId,
        });
      }
      return res.status(401).json({ error: 'invalid-credentials' });
    }
    auth.setSessionCookie(res, r.profile.id);
    const { password_hash, ...safe } = r.profile;
    res.json({ profile: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/signup', async (req, res) => {
  // Body: { username, password, profileFields: {name, email, ...} }
  // profileFields is what gets stored in the profile row beyond auth fields.
  const { username, password, profile: profileFields = {} } = req.body || {};
  try {
    const profile = await auth.signup({ username, password, profileFields });
    auth.setSessionCookie(res, profile.id);
    const { password_hash, ...safe } = profile;
    res.json({ profile: safe });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { profileId, currentPassword, newPassword } = req.body || {};
  // Three modes:
  //  - Logged in user changing their own password: req.profile.id is used,
  //    currentPassword required.
  //  - Profile in "must change password" state: profileId is passed, no
  //    currentPassword needed (initial-set flow after admin pre-creation).
  //  - Anything else: rejected.
  let targetId;
  if (req.profile) {
    targetId = req.profile.id;
  } else if (profileId) {
    const p = db.getProfile(parseInt(profileId));
    if (!p) return res.status(404).json({ error: 'profile not found' });
    if (!p.password_must_change && p.password_hash) {
      return res.status(401).json({ error: 'must be logged in to change password' });
    }
    targetId = p.id;
  } else {
    return res.status(401).json({ error: 'login required' });
  }
  try {
    await auth.changePassword(targetId, { currentPassword, newPassword });
    auth.setSessionCookie(res, targetId);  // log them in after the change
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────
// Profile / Settings API
// ─────────────────────────────
app.get('/api/profiles', (req, res) => {
  const list = db.listProfiles();
  const active = db.getSetting('active_profile_id');
  res.json({
    profiles: list.map(p => ({ ...p, is_active: String(p.id) === String(active) })),
    active_id: active ? parseInt(active) : null,
  });
});

app.get('/api/profiles/active', (req, res) => {
  const p = db.getActiveProfile();
  if (!p) return res.json({ profile: null });
  // Don't ship resume_text by default (large), unless ?full=1 is passed
  if (!req.query.full) {
    const { resume_text, ...rest } = p;
    return res.json({ profile: rest });
  }
  res.json({ profile: p });
});

app.get('/api/profiles/:id', (req, res) => {
  const p = db.getProfile(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json({ profile: p });
});

// Editing a profile is allowed only by its owner (the logged-in profile).
// In a 1-login=1-profile model, anything else is a privilege escalation.
app.put('/api/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!req.profile || req.profile.id !== id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const updated = db.updateProfile(id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Profile not found' });
  res.json({ profile: updated });
});

// /activate is gone — login is what selects the active profile now.

// Deleting your own profile (account deletion). Logs you out.
app.delete('/api/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!req.profile || req.profile.id !== id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  db.deleteProfile(id);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// List the available CV templates (used by the wizard's template-picker step)
app.get('/api/templates', (req, res) => {
  // Loaded lazily so a missing template module doesn't crash boot
  const ids = ['ats_compact', 'german_lebenslauf', 'modern_single', 'ultra_compact'];
  const out = [];
  for (const id of ids) {
    try {
      const t = require(`./templates/${id}`);
      out.push({ id: t.id, name: t.name, description: t.description });
    } catch {}
  }
  res.json({ templates: out });
});

// Profile photo upload — stored under applications/_profile_assets/{slug}.{ext}.
// Persisted per-profile in profiles.photo_path. The CV renderer embeds it
// inline (data URL) so the .docx and .pdf both ship a copy.
const PHOTO_DIR = path.join(__dirname, 'applications', '_profile_assets');
app.post('/api/profile/photo', upload.single('photo'), (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  if (!req.file) return res.status(400).json({ error: 'No file (field name "photo")' });
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const filename = `${profile.slug}.${ext}`;
  const filePath = path.join(PHOTO_DIR, filename);
  fs.writeFileSync(filePath, req.file.buffer);
  db.updateProfile(profile.id, { /* no-op via allowed list */ });
  // Use raw exec since updateProfile's allow list doesn't include photo_path
  db.brainExec('UPDATE profiles SET photo_path = ? WHERE id = ?', [filePath, profile.id]);
  res.json({ ok: true, photo_path: filePath });
});

app.delete('/api/profile/photo', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  if (profile.photo_path && fs.existsSync(profile.photo_path)) {
    try { fs.unlinkSync(profile.photo_path); } catch {}
  }
  db.brainExec('UPDATE profiles SET photo_path = NULL WHERE id = ?', [profile.id]);
  res.json({ ok: true });
});

// Serve the logged-in profile's own photo (for in-app preview)
app.get('/api/profile/photo', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  if (!profile.photo_path || !fs.existsSync(profile.photo_path)) {
    return res.status(404).json({ error: 'no photo' });
  }
  res.sendFile(profile.photo_path);
});

// Upload + parse a resume into a candidate profile object (not yet saved)
app.post('/api/profiles/upload-resume', upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No resume file uploaded (field name "resume")' });
  try {
    const allowed = req.body.allowed_country_codes
      ? JSON.parse(req.body.allowed_country_codes)
      : ['de'];
    const profile = await profileFromUpload({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      anthropicKey: db.getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY,
      allowedCountryCodes: allowed,
    });
    res.json({ profile });
  } catch (err) {
    console.error('[Profile] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// /api/profiles POST is now a thin compatibility shim — new profiles are
// created via /api/auth/signup which also sets username + password +
// returns a session cookie. Keeping this endpoint would let an attacker
// create a profile without auth, so it's gated to logged-in users only
// (e.g. an admin maintaining test profiles via curl).
app.post('/api/profiles', (req, res) => {
  if (!req.profile) return res.status(401).json({ error: 'use /api/auth/signup to create a profile' });
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name required' });
  const created = db.createProfile(body);
  res.json({ profile: created });
});

// Settings (shared key/value)
app.get('/api/settings', (req, res) => {
  const s = db.getAllSettings();
  // Don't leak full secrets — return a "configured" boolean for sensitive keys
  const reveal = req.query.reveal === '1';
  const masked = { ...s };
  ['apify_token', 'anthropic_api_key', 'resend_api_key', 'openai_api_key'].forEach(k => {
    if (masked[k] && !reveal) masked[k] = `••• (configured, ${masked[k].length} chars)`;
  });
  res.json({
    settings: masked,
    countries: listCountries(),
    presets: listPresets(),
    env_fallbacks: {
      apify_token:       !!process.env.APIFY_TOKEN,
      anthropic_api_key: !!process.env.ANTHROPIC_API_KEY,
      resend_api_key:    !!process.env.RESEND_API_KEY,
    },
  });
});

app.put('/api/settings', (req, res) => {
  if (!req.profile) return res.status(401).json({ error: 'login required' });
  const body = req.body || {};
  // Settings the user can clear back to their default by sending "". For
  // other keys (like API keys), an empty input is interpreted as "leave it
  // alone" — we don't want a blank field in the form to wipe a saved key.
  const RESETTABLE = new Set([
    'linkedin_actor_public_id', 'linkedin_actor_auth_id', 'indeed_actor_id',
    'min_match_score', 'scrape_interval_hours', 'from_email',
    'cron_enabled',
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    if (v === '' && !RESETTABLE.has(k)) continue;
    if (v === '' && RESETTABLE.has(k)) {
      // Empty value on a resettable key → delete the row entirely so
      // db.getSetting returns null and the code's default kicks in.
      db.brainExec('DELETE FROM app_settings WHERE key = ?', [k]);
      continue;
    }
    db.setSetting(k, v);
  }
  res.json({ ok: true });
});

// ─────────────────────────────
// Jobs API (profile-scoped)
// ─────────────────────────────
// Match-explain: returns a structured map of JD requirements ↔ CV
// support, skill matches (with how-they-match weights), gaps, and a
// summary. Cached per (profile, job); pass ?refresh=1 to force a new
// Claude call. UI surfaces this as the "🔍 Why N%?" modal.
app.get('/api/jobs/:jobId/match-explain', async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const job = db.getJobById(req.params.jobId, profile.id);
  if (!job) return res.status(404).json({ error: 'Job not found for this profile' });
  try {
    applyProfileState(profile);
    const payload = await brain.explainMatch(profile, job, { force: req.query.refresh === '1' });
    res.json({ ...payload, job: { id: job.id, title: job.title, company: job.company, match_score: job.match_score } });
  } catch (e) {
    console.error('[MatchExplain] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const { limit = 200, offset = 0, minScore = 0, source, search, sortBy = 'match_score', sortDir = 'DESC' } = req.query;
  const jobs = db.getJobs({ profileId: profile.id, limit: +limit, offset: +offset, minScore: +minScore, source, search, sortBy, sortDir });
  const parsed = jobs.map(j => ({
    ...j,
    matched_skills: (() => { try { return JSON.parse(j.matched_skills); } catch { return []; } })(),
  }));
  res.json({ jobs: parsed, total: parsed.length });
});

app.get('/api/stats', (req, res) => {
  // Use the session profile, not the deprecated active_profile_id setting.
  // Pre-auth code path called db.getActiveProfile() which returns the row
  // pointed to by app_settings.active_profile_id — that setting still
  // existed in legacy DBs and would shadow the actual logged-in user.
  const profile = req.profile;
  if (!profile) return res.json({ total: 0, isScraping, lastScrapeTime });
  res.json({ ...db.getStats(profile.id), isScraping, lastScrapeTime, profile: { id: profile.id, name: profile.name, slug: profile.slug } });
});

app.get('/api/timeline', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  res.json(db.getTimeline(profile.id));
});

app.post('/api/scrape', async (req, res) => {
  if (isScraping) return res.status(409).json({ error: 'Scrape already in progress' });
  const profile = requireProfile(req, res);
  if (!profile) return;
  res.json({ message: 'Scrape started', startedAt: new Date().toISOString(), profile: profile.name });
  // Manual scrape only runs for the logged-in user, not all profiles —
  // matches the user's intent (they hit "Scrape Now" on their dashboard).
  runScrapePipeline(profile).catch(console.error);
});

app.get('/api/status', (req, res) => {
  res.json({ isScraping, lastScrapeTime, nextRun: getNextRunTime() });
});

app.post('/api/test-email', async (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  try {
    applyProfileState(profile);  // load this user's notify_email + Resend key
    await sendTestEmail(profile);
    res.json({ message: `Test email sent to ${profile.notify_email || process.env.NOTIFY_EMAIL}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resume', (req, res) => {
  // Make sure the matcher's activeProfile is the logged-in user's profile.
  // On a freshly-booted server (e.g. just-restarted Docker container) no
  // scrape has run yet, so matcher.activeProfile is null. Without this
  // applyProfileState call, the sidebar's "Your Skills" panel renders
  // "No skills yet" even when the profile has skills configured.
  const profile = requireProfile(req, res); if (!profile) return;
  applyProfileState(profile);
  res.json({ keywords: getResumeKeywords(), titles: getInferredTitles() });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-resume library — list / add / update / delete / set-default.
// Backed by the profile_resumes table; the default resume is also mirrored
// onto profiles.resume_text so legacy readers (matcher, brain) keep working.
// ─────────────────────────────────────────────────────────────────────────────

// List the logged-in profile's resumes (without the full text — that's heavy).
app.get('/api/resumes', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  res.json({ resumes: db.listResumes(profile.id) });
});

// Get a single resume's full text (used by Settings when the user wants to
// view / edit the actual content).
app.get('/api/resumes/:id', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const row = db.getResumeById(+req.params.id, profile.id);
  if (!row) return res.status(404).json({ error: 'Resume not found' });
  res.json({ resume: row });
});

// Add a new resume — accepts EITHER a multipart file upload (field "resume")
// OR a JSON body with { label, resume_text }. After insert, kicks off a
// non-blocking summarize call so the picker has a digest to rank against.
app.post('/api/resumes', upload.single('resume'), async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  try {
    const label = String(req.body?.label || '').trim() || 'Resume';
    const makeDefault = req.body?.make_default === '1' || req.body?.make_default === true;
    let resumeText = '';
    if (req.file) {
      resumeText = (await extractResumeText(req.file.buffer, req.file.originalname || '')).trim();
      if (!resumeText) return res.status(400).json({ error: 'Could not extract any text from that file' });
    } else if (req.body?.resume_text) {
      resumeText = String(req.body.resume_text).trim();
    } else {
      return res.status(400).json({ error: 'Provide either a file upload (field "resume") or a JSON body with resume_text' });
    }
    const created = db.addResume(profile.id, { label, resume_text: resumeText, makeDefault });

    // Async: generate the picker-summary in the background. We respond
    // immediately so the UI feels snappy; the summary lands on a follow-up
    // refresh of the resumes list.
    summarizeResume(resumeText, profile)
      .then(summary => { if (summary) db.updateResume(created.id, profile.id, { summary }); })
      .catch(e => console.warn('[Resumes] summarize failed:', e.message));

    res.json({ resume: created });
  } catch (err) {
    console.error('[Resumes] add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a resume's label and/or text. If the text changes we re-summarize.
app.patch('/api/resumes/:id', async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  try {
    const fields = {};
    if (req.body?.label !== undefined) fields.label = String(req.body.label || '').trim() || 'Resume';
    if (req.body?.resume_text !== undefined) fields.resume_text = String(req.body.resume_text || '');
    const updated = db.updateResume(+req.params.id, profile.id, fields);
    if (!updated) return res.status(404).json({ error: 'Resume not found' });
    if (fields.resume_text) {
      summarizeResume(fields.resume_text, profile)
        .then(summary => { if (summary) db.updateResume(updated.id, profile.id, { summary }); })
        .catch(e => console.warn('[Resumes] resummarize failed:', e.message));
    }
    res.json({ resume: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promote a resume to the profile default. Mirrors the text onto
// profiles.resume_text so the matcher / brain pick it up immediately.
app.post('/api/resumes/:id/default', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  try {
    const updated = db.setDefaultResume(+req.params.id, profile.id);
    res.json({ resume: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a resume. Refuses to delete the only remaining one.
app.delete('/api/resumes/:id', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  try {
    const ok = db.deleteResume(+req.params.id, profile.id);
    if (!ok) return res.status(404).json({ error: 'Resume not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────
// Manual job entry — paste a JD that wasn't found via scraping.
// Builds a synthetic Job row, runs the same brain analyze + matcher
// scoring as a scraped job, stores it under the active profile so the
// dashboard / brain treat it identically to scraped jobs.
// ─────────────────────────────
app.post('/api/jobs/manual', async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  let { title, company, location, description, apply_url, salary, raw_text } = req.body || {};

  applyProfileState(profile);  // make sure matcher + scraper state are correct

  // If the user pasted a raw blob (the new "paste anything from LinkedIn"
  // flow), let Claude extract the structured fields. Manual structured
  // fields submitted alongside override Claude's parse so power users
  // can correct mistakes.
  let parsed = null;
  if (raw_text && String(raw_text).trim()) {
    try {
      parsed = await parseRawJobPaste(raw_text, profile);
      title       = title       || parsed.title;
      company     = company     || parsed.company;
      location    = location    || parsed.location;
      apply_url   = apply_url   || parsed.apply_url;
      salary      = salary      || parsed.salary;
      description = description || parsed.description;
    } catch (e) {
      console.warn('[Manual] parseRawJobPaste failed:', e.message);
      return res.status(500).json({ error: 'Could not parse the pasted text: ' + e.message });
    }
  }

  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'description (job description text) is required' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  // Synthesize a stable id so the same JD pasted twice doesn't double-store.
  // Uses a short hash of (title+company+description prefix) — collision-safe
  // enough for a single user's manual entries.
  const crypto = require('crypto');
  const hashKey = `${title}|${company || ''}|${description.slice(0, 200)}`;
  const id = 'manual_' + crypto.createHash('sha256').update(hashKey).digest('hex').slice(0, 16);

  const job = {
    id,
    title:       title.trim(),
    company:     (company || '').trim(),
    location:    (location || '').trim() || 'Manual entry',
    salary:      (salary || '').trim(),
    description: description.trim().slice(0, 8000),
    apply_url:   (apply_url || '').trim(),
    posted_at:   new Date().toISOString(),
    applicants:  0,
    scraped_at:  new Date().toISOString(),
    source:      'Manual',
    match_score: 0,
    matched_skills: '[]',
  };

  try {
    // Score it the same way scraped jobs are scored (semantic + keyword).
    const { scoreJob } = require('./matcher');
    const { match_score, matched_skills } = await scoreJob(job);
    job.match_score = match_score;
    job.matched_skills = matched_skills;

    // Brain pre-pass — extract company/dept/archetype/skill_demand from this JD.
    // Fire-and-forget but await so we don't block the user too long.
    try { await brain.analyzeJobAndCompany(profile, job); }
    catch (e) { console.warn('[Manual] brain.analyzeJobAndCompany failed:', e.message); }

    const isNew = db.upsertJob(job, profile.id);
    res.json({
      id: job.id,
      job: { ...job, matched_skills: (() => { try { return JSON.parse(job.matched_skills); } catch { return []; } })() },
      stored: isNew,
      parsed,    // surfaces what Claude extracted so the UI can show "I parsed: title=X, company=Y, …"
      message: isNew ? 'Job stored. Click Generate to produce CV + cover letter.' : 'Job already in your DB (same hash). Open it to generate.',
    });
  } catch (err) {
    console.error('[Manual] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────
// Application / CV Generation Routes
// ─────────────────────────────

app.use('/files', express.static(path.join(__dirname, 'applications')));

app.post('/api/generate', async (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const { jobId, language, resumeId } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  // language is optional. When omitted or invalid we fall through to the
  // generator's default of 'en' (preserves backward compatibility).
  const lang = ['en', 'de', 'both'].includes(language) ? language : 'en';
  // resumeId is optional — when present, the picker uses that resume; when
  // absent (or null), the picker auto-selects the best match.
  const explicitResumeId = (resumeId && Number.isFinite(+resumeId)) ? +resumeId : null;
  const job = db.getJobById(jobId, profile.id);
  if (!job) return res.status(404).json({ error: 'Job not found for this profile' });

  try {
    applyProfileState(profile);  // ensure matcher + scraper state matches the request's profile
    const { folderPath, folderName, cvPdfName, data, brain: brainAnalysis, languages, resume_used } = await generateAndSave(job, profile, { language: lang, resumeId: explicitResumeId });
    const appId = db.createApplication({
      profileId:         profile.id,
      job_id:            job.id,
      company:           job.company,
      role:              job.title,
      location:          job.location,
      job_url:           job.apply_url,
      job_description:   job.description,
      folder_path:       folderPath,
      cv_path:           `${folderName}/${cvPdfName}`,
      cover_letter_path: `${folderName}/${coverLetterFilename('pdf')}`,
      match_score:       job.match_score,
    });

    // Brain post-pass: record this generation. Done after the application
    // row exists so brain_application_log can FK to applications.id.
    // Best-effort: a brain failure must not fail the user's generate.
    brain.recordGeneration(profile, {
      applicationId: appId,
      companyId:     brainAnalysis?.companyId,
      departmentId:  brainAnalysis?.departmentId,
      archetypeId:   brainAnalysis?.archetypeId,
      job,
      cv:            data.cv,
      coverLetter:   data.coverLetter,
    }).catch(e => console.warn('[Brain] recordGeneration failed:', e.message));

    res.json({ id: appId, folderName, resume_used });
  } catch (err) {
    console.error('[Generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/applications', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  res.json(db.getApplications(profile.id));
});

app.get('/api/applications/export', async (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const ExcelJS = require('exceljs');
  const apps = db.getApplications(profile.id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Applications');
  ws.columns = [
    { header: 'Company', key: 'company', width: 20 },
    { header: 'Role', key: 'role', width: 30 },
    { header: 'Location', key: 'location', width: 20 },
    { header: 'Job URL', key: 'job_url', width: 40 },
    { header: 'Match %', key: 'match_score', width: 10 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Applied', key: 'applied', width: 10 },
    { header: 'Applied Date', key: 'applied_at', width: 18 },
    { header: 'Generated Date', key: 'created_at', width: 18 },
    { header: 'CV Path', key: 'cv_path', width: 40 },
    { header: 'Cover Letter Path', key: 'cover_letter_path', width: 40 },
    { header: 'Notes', key: 'notes', width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const app of apps) {
    ws.addRow({
      ...app,
      applied: app.applied ? 'Yes' : 'No',
      match_score: `${Math.round(app.match_score || 0)}%`,
    });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=applications_${profile.slug}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/applications/:id', (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const jsonPath = path.join(app.folder_path, 'generated.json');
  let data = null;
  try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch {}
  // Surface the languages the preview endpoint can serve. UI uses this to
  // decide whether to show the language toggle vs. the "Translate to other"
  // button.
  const languages_available = data?.languages_available || (data?.languages ? Object.keys(data.languages) : ['en']);
  const primary_language    = data?.primary_language    || 'en';
  res.json({ ...app, generatedData: data, languages_available, primary_language });
});

// Preview PDF — supports ?lang=en|de query param. When the application
// was generated bilingually, the same folder holds CV_<slug>_en.pdf,
// CV_<slug>_de.pdf, etc. When it wasn't, we fall back to the unsuffixed
// file (the original primary-language English render).
app.get('/api/applications/:id/preview/:type', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const folder = app.folder_path;
  const lang = req.query.lang === 'de' ? 'de' : (req.query.lang === 'en' ? 'en' : null);

  // Flush any pending debounced render for this folder+language so the
  // preview never serves stale bytes after a rapid burst of edits.
  try {
    await flushRender(renderKeyFor(folder, lang || 'en'));
  } catch (e) {
    console.warn('[Preview] flushRender failed:', e.message);
  }

  // Look up the profile's slug for filename construction. Fall back to
  // discovering CV_*.pdf in the folder (handles legacy bundles).
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  const slug = profile?.slug || 'profile';

  let fileName;
  if (req.params.type === 'cv') {
    if (lang) {
      // Try language-suffixed first, then unsuffixed
      const candidates = [
        `CV_${slug}_${lang}.pdf`,
        ...(lang === 'en' ? [`CV_${slug}.pdf`] : []),
      ];
      fileName = candidates.find(f => fs.existsSync(path.join(folder, f)));
    }
    if (!fileName) fileName = path.basename(app.cv_path || '') || guessCvFileInFolder(folder);
  } else {
    if (lang) {
      const candidates = [
        `Cover_Letter_${lang}.pdf`,
        ...(lang === 'en' ? ['Cover_Letter.pdf'] : []),
      ];
      fileName = candidates.find(f => fs.existsSync(path.join(folder, f)));
    }
    if (!fileName) fileName = 'Cover_Letter.pdf';
  }
  if (!fileName) return res.status(404).json({ error: 'CV file not found in folder' });
  const filePath = path.join(folder, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${fileName}` });
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(filePath);
});

function guessCvFileInFolder(folder) {
  try {
    const files = fs.readdirSync(folder);
    return files.find(f => /^CV_.*\.pdf$/i.test(f)) || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk download — one ZIP containing CV + cover letter (PDF + DOCX, all
// languages) plus the job description, in a structured folder layout:
//
//   <CompanyName>/<Role>_<YYYY-MM-DD>/
//     CV_<slug>[_<lang>].pdf
//     CV_<slug>[_<lang>].docx
//     Cover_Letter[_<lang>].pdf
//     Cover_Letter[_<lang>].docx
//     job_description.txt
//
// Used both by the auto-trigger after a fresh generation (so the user has a
// local copy regardless of server uptime) and by the "Download all" button
// in the preview modal for re-downloading anytime.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/applications/:id/download', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  // Flush any debounced render so the ZIP captures the latest bytes after
  // a burst of edits.
  try { await flushRender(renderKeyFor(app.folder_path, 'en')); } catch {}
  try { await flushRender(renderKeyFor(app.folder_path, 'de')); } catch {}

  if (!app.folder_path || !fs.existsSync(app.folder_path)) {
    return res.status(404).json({ error: 'Application folder is missing on disk' });
  }

  // Build the inside-zip folder path: "<Company>/<Role>_<Date>/"
  const safe = (s) => String(s || 'unknown')
    .replace(/[\\/:*?"<>|]+/g, '')   // ZIP-illegal chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'unknown';
  const dateStr = (app.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const innerCompany = safe(app.company);
  const innerRole    = `${safe(app.role)}_${dateStr}`;

  // Pick all interesting files in the application folder. We include every
  // CV + Cover_Letter file (handles bilingual outputs), the job description,
  // and skip the internal generated.json.
  let entries = [];
  try {
    entries = fs.readdirSync(app.folder_path);
  } catch (e) {
    return res.status(500).json({ error: 'Could not read application folder: ' + e.message });
  }
  const wanted = entries.filter(f =>
    /^CV_.+\.(pdf|docx)$/i.test(f) ||
    /^Cover_Letter.*\.(pdf|docx)$/i.test(f) ||
    f === 'job_description.txt'
  );
  if (wanted.length === 0) {
    return res.status(404).json({ error: 'No deliverable files found in the application folder' });
  }

  try {
    const JSZip = require('jszip');
    const zip = new JSZip();
    const innerDir = zip.folder(innerCompany).folder(innerRole);
    for (const f of wanted) {
      const abs = path.join(app.folder_path, f);
      const buf = fs.readFileSync(abs);
      innerDir.file(f, buf);
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const downloadName = `${innerCompany}_${innerRole}.zip`.replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('[Download] ZIP build failed:', err);
    res.status(500).json({ error: 'ZIP build failed: ' + err.message });
  }
});

app.post('/api/applications/:id/edit', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const { target, instruction } = req.body;
  if (!target || !instruction) return res.status(400).json({ error: 'target and instruction required' });

  // Use the application's own profile (might differ from current active)
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  const job = db.getJobById(app.job_id, app.profile_id) ||
    { title: app.role, company: app.company, location: app.location, description: app.job_description };
  try {
    const updatedData = await regenerateAndSave(app.folder_path, target, instruction, job, profile);
    // Brain: capture this edit pattern so future generations learn from it
    if (profile) {
      try { brain.recordEdit(profile.id, app.id, { target, instruction }); }
      catch (e) { console.warn('[Brain] recordEdit failed:', e.message); }
    }
    res.json({
      success: true,
      cv: updatedData.cv,
      coverLetter: updatedData.coverLetter,
      changes: updatedData.changes || [],
      scope: updatedData.scope || '',
    });
  } catch (err) {
    console.error('[Edit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Match-explain for a generated APPLICATION — uses the tailored CV
// instead of the raw resume_text. Lets the user see how the tailored
// version covers JD requirements, not just the baseline resume.
//
// Frontend opens the same explainer modal as the job-row badge but
// passes ?source=cv to get this view; pass ?source=resume to compare
// the resume side-by-side.
app.get('/api/applications/:id/match-explain', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  if (!profile) return res.status(401).json({ error: 'no profile' });

  const job = db.getJobById(app.job_id, app.profile_id) ||
    { id: app.job_id, title: app.role, company: app.company, location: app.location, description: app.job_description };
  const source = req.query.source === 'cv' ? 'cv' : 'resume';
  const language = ['en', 'de'].includes(req.query.lang) ? req.query.lang : null;

  try {
    let sourceText = null;
    let sourceLabel = 'resume';
    if (source === 'cv') {
      // Read the saved generation and use the active language's CV
      const fsLocal = require('fs');
      const pathLocal = require('path');
      const jsonPath = pathLocal.join(app.folder_path, 'generated.json');
      if (fsLocal.existsSync(jsonPath)) {
        const data = JSON.parse(fsLocal.readFileSync(jsonPath, 'utf-8'));
        const lang = language || data.primary_language || 'en';
        const payload = (data.languages && data.languages[lang]) || { cv: data.cv };
        sourceText = brain.cvJsonToFlatText(payload?.cv);
        sourceLabel = `cv:${lang}`;
      }
      if (!sourceText) return res.status(404).json({ error: 'No CV content found for this application' });
    }
    const payload = await brain.explainMatch(profile, job, {
      force: req.query.refresh === '1',
      sourceText, sourceLabel,
    });
    res.json({ ...payload, job: { id: job.id, title: job.title, company: job.company, match_score: job.match_score }, source: sourceLabel });
  } catch (e) {
    console.error('[MatchExplain/App] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-bullet alternatives + past uses for click-to-edit. POST is used
// (not GET) because the cost is non-trivial — one Claude call per request
// — and we want browsers/proxies to never cache the response.
app.post('/api/applications/:id/bullet-suggestions', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  if (!profile) return res.status(401).json({ error: 'no profile resolvable for this application' });

  const language        = ['en', 'de'].includes(req.body?.language) ? req.body.language : 'en';
  const experienceIndex = parseInt(req.body?.experience_index);
  const bulletIndex     = parseInt(req.body?.bullet_index);
  if (!Number.isFinite(experienceIndex) || !Number.isFinite(bulletIndex)) {
    return res.status(400).json({ error: 'experience_index and bullet_index required (numbers)' });
  }

  // Read the saved generation
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const jsonPath = pathLocal.join(app.folder_path, 'generated.json');
  if (!fsLocal.existsSync(jsonPath)) return res.status(404).json({ error: 'generated.json not found' });
  const data = JSON.parse(fsLocal.readFileSync(jsonPath, 'utf-8'));
  const langs = data.languages || {};
  const payload = langs[language] || (language === (data.primary_language || 'en') ? { cv: data.cv, coverLetter: data.coverLetter } : null);
  if (!payload?.cv) return res.status(404).json({ error: `No content for language ${language}` });
  const exp = payload.cv.experience?.[experienceIndex];
  if (!exp) return res.status(400).json({ error: 'experience_index out of range' });
  const currentBullet = exp.bullets?.[bulletIndex];
  if (!currentBullet) return res.status(400).json({ error: 'bullet_index out of range' });

  const job = db.getJobById(app.job_id, app.profile_id) ||
    { title: app.role, company: app.company, location: app.location, description: app.job_description };

  // Run Claude alternatives + brain past-bullets fetch in parallel — both
  // are independent and we want the popover to feel snappy.
  const [alternatives, pastUses] = await Promise.all([
    suggestBulletAlternatives({
      profile, currentBullet, role: exp,
      jobTitle: job.title, jobCompany: job.company, jobDescription: job.description,
      resumeText: profile.resume_text || '', language,
    }).catch(e => { console.warn('[Bullet] alts failed:', e.message); return []; }),
    Promise.resolve().then(() => {
      // brain_achievements stores every bullet generated for this profile.
      // We want the "best" recent ones from similar contexts (same archetype
      // ideally) — the brain's archetype_id link is on application_log, not
      // the achievements table directly, so we just take the most recent
      // 30 and let the UI show variety.
      return db.brainAll(
        'SELECT variation, context, was_kept, was_applied, created_at FROM brain_achievements WHERE profile_id = ? ORDER BY id DESC LIMIT 30',
        [profile.id]
      );
    }),
  ]);

  res.json({
    current_bullet: currentBullet,
    alternatives,                                              // Claude rewrites
    past_uses: pastUses.map(p => ({                            // brain history
      text: p.variation,
      context: p.context,
      applied: !!p.was_applied,
      kept: !!p.was_kept,
      created_at: p.created_at,
    })),
  });
});

// Find the original passage(s) in the candidate's resume that a tailored
// bullet was derived from. The generator routinely shortens the source
// resume (a 3-line accomplishment becomes a 12-word bullet); this lets
// the user recover the unabridged version when the trim went too far.
//
// Body: { bullet: "<the tailored bullet text>" }
// Returns: { excerpts: [string], reasoning: "<short>" }
app.post('/api/applications/:id/bullet-source', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  const bullet = String(req.body?.bullet || '').trim();
  if (!bullet) return res.status(400).json({ error: 'bullet text is required' });

  const resumeText = String(profile?.resume_text || '').trim();
  if (!resumeText) return res.status(400).json({ error: 'No resume on file for this profile' });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const MODELS = require('./models');
    const anthropicKey = (profile && profile.anthropic_key_override) ||
      db.getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error('Anthropic API key not configured');
    const client = new Anthropic({ apiKey: anthropicKey });

    const sys = `You match a tailored CV bullet back to the candidate's original resume to recover its source.

Output ONLY valid JSON, no markdown fences:
{
  "excerpts": ["<verbatim sentence or paragraph from the resume that this bullet was derived from>", "..."],
  "reasoning": "<one short sentence explaining the connection>"
}

RULES:
- Quote the resume verbatim. Do NOT paraphrase.
- Return 1-3 excerpts. Prefer one strong match over many weak ones.
- Each excerpt should be a complete sentence or short paragraph (~15-60 words). Don't return bare fragments.
- If nothing in the resume clearly maps to this bullet, return excerpts: [] and explain in reasoning.
- Don't include the role title / company name unless they were the part that was shortened.`;

    const r = await client.messages.create({
      model: MODELS.auxiliary,        // source recovery — straightforward extraction, Haiku
      max_tokens: 1000,
      system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Candidate's full resume:
${resumeText}

Tailored bullet to find the source for:
"${bullet}"

Return the JSON now.`,
      }],
    });
    const raw = r.content[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ excerpts: [], reasoning: 'Source-finder returned no JSON.' });
    const parsed = JSON.parse(m[0]);
    res.json({
      excerpts: Array.isArray(parsed.excerpts) ? parsed.excerpts.filter(s => typeof s === 'string').slice(0, 5) : [],
      reasoning: String(parsed.reasoning || '').trim(),
    });
  } catch (err) {
    console.error('[Bullet-source] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generic field updater — used by the inline edit affordance in the
// draft view. Body: {language, path, value}. Path is a dotted-segment
// path into the CV payload (e.g. "cv.name", "cv.experience.0.title",
// "cv.skills.Languages.0", "coverLetter"). Strings, arrays and the
// whole skills object can all be replaced.
app.post('/api/applications/:id/update-field', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();

  const language = ['en', 'de'].includes(req.body?.language) ? req.body.language : 'en';
  const path     = String(req.body?.path || '').trim();
  const value    = req.body?.value;
  if (!path) return res.status(400).json({ error: 'path required' });
  if (value === undefined) return res.status(400).json({ error: 'value required (use empty string to clear)' });

  // Light path safety — only allow paths starting with "cv." or
  // "coverLetter" so callers can't reach into other JSON keys
  // (primary_language, languages_available, etc.).
  if (!path.startsWith('cv.') && path !== 'cv' && path !== 'coverLetter' && !path.startsWith('coverLetter.')) {
    return res.status(400).json({ error: 'path must target cv.* or coverLetter' });
  }

  const job = db.getJobById(app.job_id, app.profile_id) ||
    { title: app.role, company: app.company, location: app.location, description: app.job_description };

  try {
    const r = await applyFieldEdit({ folderPath: app.folder_path, language, path, value, job, profile });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[Field] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply a bullet change to the saved CV + re-render that language's docx/pdf.
app.post('/api/applications/:id/update-bullet', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();

  const language        = ['en', 'de'].includes(req.body?.language) ? req.body.language : 'en';
  const experienceIndex = parseInt(req.body?.experience_index);
  const bulletIndex     = parseInt(req.body?.bullet_index);
  const newText         = String(req.body?.new_text || '').trim();
  if (!Number.isFinite(experienceIndex) || !Number.isFinite(bulletIndex) || !newText) {
    return res.status(400).json({ error: 'experience_index, bullet_index and new_text required' });
  }

  const job = db.getJobById(app.job_id, app.profile_id) ||
    { title: app.role, company: app.company, location: app.location, description: app.job_description };

  try {
    const r = await applyBulletEdit({ folderPath: app.folder_path, language, experienceIndex, bulletIndex, newText, job, profile });
    // Save the new bullet variant into the achievement bank so it shows up
    // as a "past use" suggestion in future bullet popovers.
    try {
      brainDb.addAchievement(profile.id, {
        source_bullet: r.oldText,
        variation: newText,
        context: `${job.title || ''} @ ${job.company || ''}`,
        was_kept: 1,   // user explicitly chose / typed this — strong "kept" signal
      });
    } catch (e) { console.warn('[Brain] addAchievement failed:', e.message); }
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[Bullet] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Translate an existing application into another language (en ↔ de).
// Reads the saved generated.json, calls Claude to translate, writes
// CV_<slug>_<lang>.{docx,pdf} + Cover_Letter_<lang>.{docx,pdf} to the
// existing application folder, and updates the JSON so the preview
// endpoint can serve both languages.
app.post('/api/applications/:id/translate', async (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const target = (req.body?.target_language || '').toLowerCase();
  if (!['en', 'de'].includes(target)) return res.status(400).json({ error: 'target_language must be "en" or "de"' });

  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  const job = db.getJobById(app.job_id, app.profile_id) ||
    { title: app.role, company: app.company, location: app.location, description: app.job_description };

  try {
    const r = await translateExistingApplication(app.folder_path, target, job, profile);
    res.json({ ok: true, target_language: target, files: r.files });
  } catch (e) {
    console.error('[Translate] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generic translation endpoint — translates a free-form chunk of text.
// Used by the Paste-a-Job UI to translate a German JD to English (or
// vice versa) so the user can verify what's in it. Doesn't touch any
// DB state — pure transform.
app.post('/api/translate', async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const { text, target_language } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const target = (target_language || '').toLowerCase();
  if (!['en', 'de'].includes(target)) return res.status(400).json({ error: 'target_language must be "en" or "de"' });

  try {
    const translated = await translateText(text, profile, target);
    res.json({ translated, target_language: target });
  } catch (e) {
    console.error('[Translate] Generic error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/applications/:id/apply', (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  db.markAsApplied(+req.params.id);

  // Brain: mark applied + fire reflection async. Reflection is the slow,
  // expensive step (calls Claude); don't make the user wait.
  const profile = app.profile_id ? db.getProfile(app.profile_id) : db.getActiveProfile();
  if (profile) {
    try { brain.markApplied(profile.id, app.id); } catch (e) { console.warn('[Brain] markApplied failed:', e.message); }

    // Look up the archetype this application landed in, so reflection scopes
    // its insights to the right angle (SAP applications produce SAP insights,
    // not generic cross-angle ones).
    const log = db.brainOne('SELECT role_archetype_id FROM brain_application_log WHERE application_id = ? ORDER BY id DESC LIMIT 1', [app.id]);
    const archetypeId = log?.role_archetype_id || null;
    if (archetypeId) {
      try { brainDb.bumpArchetypeApplied(archetypeId); } catch {}
    }

    brain.runReflection(profile, { archetypeId }).then(r => {
      if (r?.created?.length) console.log(`[Brain] Reflection (${r.archetype || 'global'}) produced ${r.created.length} new insight(s) for ${profile.name}.`);
      else if (r?.skipped) console.log(`[Brain] Reflection skipped: ${r.reason}`);
    }).catch(e => console.warn('[Brain] runReflection failed:', e.message));
  }

  res.json({ success: true });
});

app.get('/api/applications/:id/open', (req, res) => {
  const app = db.getApplicationById(+req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  res.json({ folderPath: app.folder_path });
});

// ─────────────────────────────
// LinkedIn cookie observability
// ─────────────────────────────
// Quick read-only check: does the active profile have a cookie set, does
// it look right, which actor will scrape with it?
app.get('/api/profile/linkedin-status', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const raw = (profile.linkedin_cookie_override || '').trim();
  const cookie_set = !!raw;
  // li_at cookies are base64-ish, ~150-220 chars, typically start with AQED.
  // We only do a *format* check here — actual validity requires a real call.
  const format_valid = cookie_set && raw.length >= 80 && raw.length <= 400 && /^[A-Za-z0-9_\-]+$/.test(raw);
  res.json({
    cookie_set,
    format_valid,
    cookie_length: raw.length,
    cookie_starts_with: cookie_set ? raw.slice(0, 4) : '',
    mode: cookie_set ? 'authenticated' : 'anonymous',
    actor_id: cookie_set ? 'bebity~linkedin-jobs-scraper' : 'valig~linkedin-jobs-scraper',
  });
});

// Live test: kick off the smallest possible Apify scrape using this profile's
// cookie + first search title, return whether anything came back. Costs a
// tiny amount of Apify credit per call. Frontend should warn the user.
app.post('/api/profile/linkedin-test', async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const cookie = (profile.linkedin_cookie_override || '').trim();
  if (!cookie) return res.status(400).json({ error: 'no cookie set on this profile' });

  const title = (profile.search_titles && profile.search_titles[0]) || 'Software Engineer';
  const apifyToken = profile.apify_token_override || db.getSetting('apify_token') || process.env.APIFY_TOKEN;
  if (!apifyToken) return res.status(400).json({ error: 'Apify token missing — set in Settings or .env' });

  // We bypass the normal scraper.js wrapper because we want a single-title,
  // single-result run that finishes in <60s instead of the full pipeline.
  const axios = require('axios');
  const { locationLabelFor } = require('./location');
  const locationLabel = locationLabelFor(profile.allowed_country_codes || ['de']);

  try {
    const start = await axios.post(
      `https://api.apify.com/v2/acts/bebity~linkedin-jobs-scraper/runs?token=${apifyToken}`,
      {
        queries: [title],
        location: locationLabel,
        scrapeCompany: false,
        cookie: [{ name: 'li_at', value: cookie, domain: '.linkedin.com' }],
        count: 1,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    const runId = start.data.data.id;

    // Poll for completion (max 90s)
    const startedAt = Date.now();
    let status = 'RUNNING', datasetId = null;
    while (Date.now() - startedAt < 90000) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      status = poll.data.data.status;
      datasetId = poll.data.data.defaultDatasetId;
      if (['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status)) break;
    }
    if (status !== 'SUCCEEDED') {
      return res.json({ ok: false, status, message: `Run ended with status ${status}. Cookie may be invalid or rate-limited.` });
    }
    const items = (await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&limit=3`)).data || [];
    const sample = items[0] ? {
      title: items[0].title || items[0].jobTitle,
      company: items[0].companyName || items[0].company,
      location: items[0].location || items[0].jobLocation,
    } : null;
    return res.json({
      ok: true,
      mode: 'authenticated',
      actor_id: 'bebity~linkedin-jobs-scraper',
      query: title,
      location: locationLabel,
      jobs_found: items.length,
      sample,
      duration_ms: Date.now() - startedAt,
    });
  } catch (e) {
    return res.json({
      ok: false,
      error: e.response?.data?.error?.message || e.message,
      hint: 'Common causes: invalid Apify token, expired li_at cookie, or LinkedIn rate-limited the cookie. Re-copy from Chrome DevTools and retry.',
    });
  }
});

// ─────────────────────────────
// Brain API (per active profile)
// ─────────────────────────────
app.get('/api/brain', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const skills     = brainDb.listSkills(profile.id, { limit: 200 });
  const companies  = brainDb.listCompanies(profile.id);
  const insights   = brainDb.listInsights(profile.id);
  const facts      = brainDb.listFacts(profile.id);
  const stats      = brainDb.applicationLogStats(profile.id);
  const archetypes = brainDb.listArchetypes(profile.id);
  res.json({
    profile: { id: profile.id, name: profile.name, slug: profile.slug },
    stats: {
      generations:     stats.total,
      applied:         stats.applied,
      companies_seen:  companies.length,
      insights_active: insights.filter(i => i.is_active).length,
      facts:           facts.length,
      angles:          archetypes.length,
    },
    top_demand: [...skills].sort((a,b)=>b.demand_count-a.demand_count).slice(0,15),
    top_emphasis: [...skills].sort((a,b)=>b.emphasis_count-a.emphasis_count).slice(0,15),
    recent_companies: companies.slice(0, 10),
    archetypes,
    insights, facts,
  });
});

app.get('/api/brain/companies', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  res.json(brainDb.listCompanies(profile.id));
});

app.get('/api/brain/skills', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  res.json(brainDb.listSkills(profile.id, { limit: parseInt(req.query.limit) || 100 }));
});

app.get('/api/brain/archetypes', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  res.json(brainDb.listArchetypes(profile.id));
});

app.get('/api/brain/insights', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  // Optional ?archetypeId=NN — if provided, returns angle-specific + global
  // (cross-angle) insights together. ?archetypeId=null returns global only.
  const opts = { activeOnly: req.query.active === '1' };
  if (req.query.archetypeId === 'null') opts.archetypeId = null;
  else if (req.query.archetypeId) {
    opts.archetypeId = parseInt(req.query.archetypeId);
    opts.includeGlobal = req.query.includeGlobal !== '0';
  }
  res.json(brainDb.listInsights(profile.id, opts));
});

app.put('/api/brain/insights/:id', (req, res) => {
  brainDb.updateInsight(parseInt(req.params.id), req.body || {});
  res.json({ ok: true });
});

app.delete('/api/brain/insights/:id', (req, res) => {
  brainDb.deleteInsight(parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('/api/brain/facts', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const opts = {};
  if (req.query.archetypeId === 'null') opts.archetypeId = null;
  else if (req.query.archetypeId) {
    opts.archetypeId = parseInt(req.query.archetypeId);
    opts.includeGlobal = req.query.includeGlobal !== '0';
  }
  res.json(brainDb.listFacts(profile.id, opts));
});

app.post('/api/brain/facts', (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  const { fact, tag, archetype_id } = req.body || {};
  if (!fact || !fact.trim()) return res.status(400).json({ error: 'fact required' });
  const id = brainDb.addFact(profile.id, {
    fact: fact.trim(),
    tag: (tag || '').trim(),
    archetype_id: archetype_id ? parseInt(archetype_id) : null,
  });
  res.json({ id });
});

app.put('/api/brain/facts/:id', (req, res) => {
  brainDb.updateFact(parseInt(req.params.id), req.body || {});
  res.json({ ok: true });
});

app.delete('/api/brain/facts/:id', (req, res) => {
  brainDb.deleteFact(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/brain/reflect', async (req, res) => {
  const profile = requireProfile(req, res); if (!profile) return;
  try {
    const archetypeId = req.body?.archetypeId ? parseInt(req.body.archetypeId) : null;
    const r = await brain.runReflection(profile, { lookback: parseInt(req.body?.lookback) || 5, archetypeId });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────
// Cron Scheduler
// ─────────────────────────────
function getNextRunTime() {
  const interval = getScrapeIntervalHours();
  const next = new Date();
  next.setHours(next.getHours() + interval, 0, 0, 0);
  return next.toISOString();
}

function startCron() {
  const interval = getScrapeIntervalHours();
  let cronExpr;
  if (interval >= 24) {
    cronExpr = '0 9 * * *';
    console.log(`[Cron] Scheduled daily at 9:00 AM. Expression: "${cronExpr}"`);
  } else {
    cronExpr = `0 */${interval} * * *`;
    console.log(`[Cron] Scheduled every ${interval} hour(s). Expression: "${cronExpr}"`);
  }
  cron.schedule(cronExpr, () => {
    console.log('[Cron] Scheduled scrape triggered (all profiles).');
    runScrapeAllProfiles().catch(console.error);
  });
}

// ─────────────────────────────
// Startup
// ─────────────────────────────
async function start() {
  await db.getDb();
  console.log('[Server] Database initialized.');

  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║          🎯  Job Dashboard               ║');
    console.log(`║   Dashboard: http://localhost:${PORT}       ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  });

  // After the auth refactor, "active profile" is whoever is logged in. The
  // server boot doesn't have a session, so we don't auto-scrape on startup.
  // Cron runs but iterates over all profiles — each profile gets its own
  // scrape using its own titles + countries.
  const profiles = db.listProfiles();
  if (!profiles.length) {
    console.warn('[Server] No profiles yet. Open http://localhost:' + PORT + '/login.html and create one.');
    return;
  }
  console.log(`[Server] ${profiles.length} profile(s) registered. Cron will scrape for each.`);
  startCron();
}

start().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
