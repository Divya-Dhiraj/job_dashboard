// scraper.js — Calls Apify REST API for LinkedIn + Indeed.
// Search titles, target location, and the country code passed to Indeed all
// come from the active profile via applyProfile(). Apify token is read from
// settings (DB) at scrape time, falling back to APIFY_TOKEN env var.
const axios = require('axios');
const { isAllowedLocation, locationLabelFor, primaryCountryCode } = require('./location');

const APIFY_BASE = 'https://api.apify.com/v2';

// Resolved at scrape time, but exposed here as overridable defaults.
let searchTitles = [];
let allowedCountryCodes = ['de'];
let locationLabel = 'Germany';
let countryCode = 'de';

let apifyTokenOverride = null;        // optional, set by server boot
let linkedInCookieOverride = null;    // li_at cookie value for this profile

// Apify actor IDs. The public LinkedIn actor doesn't need auth (anonymous
// public scraping). When a profile provides a li_at cookie, we switch to
// the cookie-supporting actor so the scrape runs as that user — exposing
// Easy Apply jobs and gated listings the anonymous actor can't see.
//
// The "with auth" actor is configurable via app_settings.linkedin_actor_auth_id
// because (a) bebity is a paid actor — users on the free Apify tier hit 403
// on every run; (b) actors get renamed/removed on Apify; (c) different actors
// expect different input shapes, so we may need a custom shape per actor.
const LINKEDIN_ACTOR_PUBLIC_DEFAULT = 'valig~linkedin-jobs-scraper';
const LINKEDIN_ACTOR_AUTH_DEFAULT   = 'bebity~linkedin-jobs-scraper';
const INDEED_ACTOR_DEFAULT          = 'valig~indeed-jobs-scraper';

function getActorIds() {
  // Late-bound so settings changes take effect without process restart.
  // We don't import database here to avoid a hot circular import path; the
  // setLinkedInActorIds() setter below is what server.js uses to inject
  // values from the DB.
  return {
    linkedin_public: _actorOverrides.linkedin_public || LINKEDIN_ACTOR_PUBLIC_DEFAULT,
    linkedin_auth:   _actorOverrides.linkedin_auth   || LINKEDIN_ACTOR_AUTH_DEFAULT,
    indeed:          _actorOverrides.indeed          || INDEED_ACTOR_DEFAULT,
  };
}

let _actorOverrides = {};
function setActorOverrides(overrides) {
  _actorOverrides = overrides || {};
}

function applyProfile(profile) {
  if (!profile) return;
  searchTitles = Array.isArray(profile.search_titles) ? profile.search_titles : [];
  allowedCountryCodes = Array.isArray(profile.allowed_country_codes) && profile.allowed_country_codes.length
    ? profile.allowed_country_codes
    : ['de'];
  locationLabel = locationLabelFor(allowedCountryCodes);
  countryCode   = primaryCountryCode(allowedCountryCodes);
  linkedInCookieOverride = (profile.linkedin_cookie_override || '').trim() || null;
  const authMode = linkedInCookieOverride ? 'authenticated (with cookie)' : 'anonymous';
  console.log(`[Scraper] Applied profile "${profile.name}" — ${searchTitles.length} titles, location="${locationLabel}", primary country=${countryCode}, LinkedIn=${authMode}`);
}

function setApifyToken(token) { apifyTokenOverride = token || null; }
function setLinkedInCookie(cookie) { linkedInCookieOverride = (cookie || '').trim() || null; }
function getApifyToken() {
  return apifyTokenOverride || process.env.APIFY_TOKEN || '';
}
function maxJobsPerRun() {
  return parseInt(process.env.MAX_JOBS_PER_RUN || '50');
}

// Back-compat: server.js used to call setSearchTitles. Keep it as a thin shim
// that overrides only the title list.
function setSearchTitles(titles) {
  if (titles?.length) {
    searchTitles = titles;
    console.log(`[Scraper] Titles overridden: ${titles.join(', ')}`);
  }
}

// ─────────────────────────────
// Apify helpers
// ─────────────────────────────
async function runActor(actorId, input) {
  const token = getApifyToken();
  if (!token) throw new Error('APIFY token missing — set APIFY_TOKEN in settings or .env');
  const res = await axios.post(
    `${APIFY_BASE}/acts/${actorId}/runs?token=${token}`,
    input,
    { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
  );
  return res.data.data.id;
}

async function waitForRun(runId, maxWaitMs = 6 * 60 * 1000) {
  const token = getApifyToken();
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(8000);
    const res = await axios.get(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`);
    const { status, defaultDatasetId } = res.data.data;
    if (status === 'SUCCEEDED') return defaultDatasetId;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Run ${runId}: ${status}`);
    console.log(`[Scraper] Run ${runId}: ${status}...`);
  }
  throw new Error(`Run ${runId} timed out`);
}

async function fetchDataset(datasetId) {
  const token = getApifyToken();
  const res = await axios.get(`${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&limit=200&clean=true`);
  return res.data || [];
}

// ─────────────────────────────
// URL Sanitizer — fixes broken apply links
// ─────────────────────────────
function safeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('javascript:') || trimmed === '#' || trimmed === '') return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return '';
  if (trimmed.includes('.')) return `https://${trimmed}`;
  return '';
}

function isValidApplyUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

// ─────────────────────────────
// Location normalizer — handles string, object, and array formats
// ─────────────────────────────
function normalizeLocation(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) return raw.filter(Boolean).join(', ');
  if (typeof raw === 'object') {
    return (
      raw.display ||
      raw.formattedAddress ||
      [raw.city || raw.addressLocality, raw.state || raw.addressRegion, raw.country || raw.addressCountry]
        .filter(Boolean).join(', ')
    ) || '';
  }
  return String(raw);
}

// ─────────────────────────────
// Normalizers
// ─────────────────────────────
function normalizeLinkedIn(item) {
  const jobId = item.id || item.jobId;
  const id = `linkedin_${jobId || encodeKey(item.jobUrl || item.url || item.title)}`;

  let applyUrl = safeUrl(
    item.applyUrl || item.externalApplyUrl || item.externalUrl ||
    item.jobUrl   || item.url             || ''
  );
  if (!applyUrl && jobId) {
    applyUrl = `https://www.linkedin.com/jobs/view/${jobId}`;
  }

  const applicants = parseInt(item.applicationsCount || item.applicantCount || item.numberOfApplicants || 0) || 0;
  const postedAt   = item.postedAt || item.publishedAt || item.postedTimeAt || item.listedAt || '';

  return {
    id,
    title:          item.title       || item.jobTitle    || '',
    company:        item.companyName || item.company     || '',
    location:       normalizeLocation(item.location || item.jobLocation),
    salary:         item.salary      || item.salaryRange || '',
    description:    cleanText(item.descriptionHtml || item.description || ''),
    apply_url:      applyUrl,
    posted_at:      postedAt || new Date().toISOString(),
    applicants,
    scraped_at:     new Date().toISOString(),
    source:         'LinkedIn',
    match_score:    0,
    matched_skills: '[]',
  };
}

function normalizeIndeed(item) {
  const id    = `indeed_${item.id || encodeKey(item.url || item.title)}`;
  const rawD  = item.description || item.jobDescription || '';
  const postedAt = item.date || item.postedAt || item.postedDate || item.datePosted || '';

  return {
    id,
    title:          item.title          || item.positionName  || '',
    company:        item.company        || item.companyName   || '',
    location:       normalizeLocation(item.location || item.jobLocation),
    salary:         item.salary         || item.salaryText    || '',
    description:    cleanText(typeof rawD === 'string' ? rawD : JSON.stringify(rawD)),
    apply_url:      safeUrl(item.url    || item.applyUrl      || item.jobUrl || ''),
    posted_at:      postedAt || new Date().toISOString(),
    applicants:     0,
    scraped_at:     new Date().toISOString(),
    source:         'Indeed',
    match_score:    0,
    matched_skills: '[]',
  };
}

function cleanText(raw) {
  return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 3000);
}

function encodeKey(str) {
  return Buffer.from(String(str).slice(0, 30)).toString('base64').slice(0, 16);
}

// ─────────────────────────────
// Source scrapers
// ─────────────────────────────
async function runApifySource(actorId, buildInput, normalize, sourceName) {
  const jobs  = [];
  const titles = searchTitles.slice(0, 5);
  if (!titles.length) {
    console.warn(`[${sourceName}] No search titles configured. Skipping.`);
    return jobs;
  }
  const max = maxJobsPerRun();
  for (const title of titles) {
    try {
      console.log(`[${sourceName}] "${title}"...`);
      const runId     = await runActor(actorId, buildInput(title, max));
      const datasetId = await waitForRun(runId);
      const items     = await fetchDataset(datasetId);
      items.forEach(item => jobs.push(normalize(item)));
      console.log(`[${sourceName}] "${title}": ${items.length} jobs`);
    } catch (err) {
      console.error(`[${sourceName}] Error for "${title}": ${err.message}`);
    }
    await sleep(2500);
  }
  return jobs;
}

async function scrapeLinkedIn() {
  // Two paths depending on whether the profile provided a li_at cookie:
  //   - Authenticated: bebity actor, cookie passed in the cookie array. We
  //     get jobs as if the user were browsing logged in (Easy Apply,
  //     gated listings, recommended jobs).
  //   - Anonymous: existing valig actor, public job-search results only.
  const actors = getActorIds();
  if (linkedInCookieOverride) {
    return runApifySource(
      actors.linkedin_auth,
      (title, max) => ({
        // bebity input shape — uses queries[] + location, plus the cookie
        // array. Cookie format: [{name, value, domain}].
        queries: [title],
        location: locationLabel,
        scrapeCompany: false,
        cookie: [{ name: 'li_at', value: linkedInCookieOverride, domain: '.linkedin.com' }],
        count: Math.ceil(max / 5),
      }),
      normalizeLinkedIn,
      'LinkedIn(auth)'
    );
  }
  return runApifySource(
    actors.linkedin_public,
    (title, max) => ({
      title,
      location: locationLabel,
      sort: 'recent',
      limit: Math.ceil(max / 5),
    }),
    normalizeLinkedIn,
    'LinkedIn'
  );
}

async function scrapeIndeed() {
  return runApifySource(
    getActorIds().indeed,
    (title, max) => ({
      country: countryCode,
      title,
      location: locationLabel,
      sort: 'date',
      maxAge: '7',
      limit: Math.ceil(max / 5),
    }),
    normalizeIndeed,
    'Indeed'
  );
}

// ─────────────────────────────
// Main entry point — LinkedIn + Indeed
// ─────────────────────────────
async function scrapeAll() {
  console.log(`[Scraper] Starting scrape — LinkedIn + Indeed (${locationLabel}, latest)...`);

  const [Li, In] = await Promise.allSettled([
    scrapeLinkedIn(),
    scrapeIndeed(),
  ]);

  const results = {
    LinkedIn: Li.status === 'fulfilled' ? Li.value : [],
    Indeed:   In.status === 'fulfilled' ? In.value : [],
  };

  for (const [src, jobs] of Object.entries(results)) {
    console.log(`[Scraper] ${src}: ${jobs.length} jobs`);
  }

  return Object.values(results).flat();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Export the location matcher bound to the currently-applied profile.
// server.js receives a closure so its filter logic stays profile-agnostic.
function getLocationFilter() {
  const codes = allowedCountryCodes.slice();
  return (loc) => isAllowedLocation(loc, codes);
}

module.exports = {
  scrapeAll, scrapeLinkedIn, scrapeIndeed,
  applyProfile, setSearchTitles, setApifyToken, setLinkedInCookie,
  setActorOverrides, getActorIds,
  isValidApplyUrl, getLocationFilter,
};
