// templates/index.js — Template registry + rendering adapters used by
// generator.js. The generator emits a Claude-produced CV JSON; this module:
//
//   1. Applies the user's field-visibility flags (from profile.cv_field_visibility)
//      so toggled-off fields don't reach the renderer.
//   2. Embeds the user's profile photo as a data URL (so the rendered PDF
//      ships the picture inline — no localhost fetch needed at print time).
//   3. Picks the right template module by id and produces HTML.
//
// Templates only own their CSS + section list; the HTML renderer in
// _render.js does the actual layout.
const fs = require('fs');
const path = require('path');
const { renderHtml } = require('./_render');

const TEMPLATES = {
  ats_compact:       require('./ats_compact'),
  german_lebenslauf: require('./german_lebenslauf'),
  modern_single:     require('./modern_single'),
  ultra_compact:     require('./ultra_compact'),
};

function getTemplate(id) {
  return TEMPLATES[id] || TEMPLATES.modern_single;
}

function listTemplates() {
  return Object.values(TEMPLATES).map(t => ({ id: t.id, name: t.name, description: t.description }));
}

// Field visibility — defaults to "include everything" if the profile has
// no flags set yet (e.g., legacy profile from before the wizard rebuild).
function isVisible(visibility, key, defaultValue = true) {
  if (!visibility || typeof visibility !== 'object') return defaultValue;
  if (visibility[key] === false) return false;
  if (visibility[key] === true)  return true;
  return defaultValue;
}

// Strip CV fields the profile owner has hidden. We only touch contact /
// personal-data fields here. Body sections (experience, education, skills,
// languages, certifications) flow through the template's `sections` list.
function applyVisibility(cv, profile) {
  const v = profile?.cv_field_visibility || {};
  const out = { ...cv };
  // Contact line
  if (!isVisible(v, 'name'))     out.name = '';
  if (!isVisible(v, 'email'))    out.email = '';
  if (!isVisible(v, 'phone'))    out.phone = '';
  if (!isVisible(v, 'address'))  out.address = '';
  if (!isVisible(v, 'linkedin')) out.linkedin = '';
  // German personal data block
  if (!isVisible(v, 'dob', false))            out.dob = '';
  if (!isVisible(v, 'place_of_birth', false)) out.place_of_birth = '';
  if (!isVisible(v, 'nationality', false))    out.nationality = '';
  if (!isVisible(v, 'marital_status', false)) out.marital_status = '';
  // Languages section
  if (!isVisible(v, 'languages')) out.languages = [];
  // Photo: drop the data URL so the German template's renderHeader
  // doesn't draw a frame around an empty image.
  if (!isVisible(v, 'photo'))     out.photoDataUrl = null;
  return out;
}

// Read profile.photo_path and inline it as a data URL. Returns null when
// no photo is set, the file is missing, or the format is unrecognised.
function loadPhotoAsDataUrl(profile) {
  if (!profile?.photo_path) return null;
  try {
    if (!fs.existsSync(profile.photo_path)) return null;
    const buf = fs.readFileSync(profile.photo_path);
    const ext = path.extname(profile.photo_path).toLowerCase().replace('.', '') || 'jpg';
    const mime = ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' })[ext] || 'jpeg';
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('[templates] photo load failed:', e.message);
    return null;
  }
}

// Merge profile-side personal data (DOB, nationality, etc.) into the CV that
// Claude returned. Claude works from the resume text and doesn't always
// surface these fields — they live on the profile, so we splice them in
// before rendering. Visibility filters then decide what actually appears.
function mergeProfilePersonalData(cv, profile) {
  if (!profile) return cv;
  const out = { ...cv };
  out.dob            = out.dob            || profile.dob            || '';
  out.place_of_birth = out.place_of_birth || profile.place_of_birth || '';
  out.nationality    = out.nationality    || profile.nationality    || '';
  out.marital_status = out.marital_status || profile.marital_status || '';

  // Languages: prefer the curated list from the profile (CEFR levels) over
  // whatever Claude inferred. The templates render {lang, level} pairs.
  if (Array.isArray(profile.languages_cefr) && profile.languages_cefr.length) {
    out.languages = profile.languages_cefr;
  }
  return out;
}

// Build the CV ready for rendering: merge profile data, embed photo, apply
// visibility flags. Single function so the generator only calls one thing.
function prepareCv(cv, profile) {
  let out = mergeProfilePersonalData(cv, profile);
  out.photoDataUrl = loadPhotoAsDataUrl(profile);
  out = applyVisibility(out, profile);
  return out;
}

// Render the CV to HTML using the profile's chosen template.
function renderCvHtml(cv, profile) {
  const tpl = getTemplate(profile?.cv_template || 'modern_single');
  return renderHtml(cv, tpl);
}

// Margin override for puppeteer (templates know their own page margins).
function pdfMarginFor(profile) {
  const tpl = getTemplate(profile?.cv_template || 'modern_single');
  return tpl.margin || { top: '12mm', bottom: '12mm', left: '14mm', right: '14mm' };
}

module.exports = {
  TEMPLATES,
  getTemplate, listTemplates,
  isVisible, applyVisibility,
  loadPhotoAsDataUrl, mergeProfilePersonalData,
  prepareCv, renderCvHtml, pdfMarginFor,
};
