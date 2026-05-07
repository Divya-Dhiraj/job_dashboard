// _render.js — Shared HTML renderer used by all CV templates.
// Each template module exports {id, name, css, sections} where:
//   - css: a CSS string
//   - sections: ordered list of section keys to render (e.g.
//     ['summary','experience','education','skills','languages','certifications'])
//   - labels: optional override of section headings (e.g. German labels)
//   - personalDataBlock: optional renderer for the "Persönliche Daten"
//     block used by the German Lebenslauf template
//
// All templates are SINGLE-COLUMN, ATS-friendly. We render to HTML then
// puppeteer renders that to PDF; same HTML can also be saved to disk for
// preview in a browser.
const puppeteer = require('puppeteer');
const fs = require('fs');

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderSummary(cv, labels) {
  if (!cv.profileSummary) return '';
  return `<section class="cv-section">
    <h2>${esc(labels.summary || 'Profile Summary')}</h2>
    <p class="summary">${esc(cv.profileSummary)}</p>
  </section>`;
}

function renderExperience(cv, labels) {
  if (!cv.experience?.length) return '';
  let html = `<section class="cv-section"><h2>${esc(labels.experience || 'Professional Experience')}</h2>`;
  for (const e of cv.experience) {
    html += `<div class="entry">
      <div class="entry-head">
        <span class="entry-title"><strong>${esc(e.title)}</strong>${e.company ? ', <span class="company">' + esc(e.company) + '</span>' : ''}</span>
        <span class="entry-dates">${esc(e.dates || '')}</span>
      </div>`;
    if (e.location) html += `<div class="entry-sub">${esc(e.location)}</div>`;
    if (e.bullets?.length) {
      html += '<ul>';
      for (const b of e.bullets) html += `<li>${esc(b)}</li>`;
      html += '</ul>';
    }
    html += '</div>';
  }
  return html + '</section>';
}

function renderEducation(cv, labels) {
  if (!cv.education?.length) return '';
  let html = `<section class="cv-section"><h2>${esc(labels.education || 'Education')}</h2>`;
  for (const e of cv.education) {
    html += `<div class="entry">
      <div class="entry-head">
        <span class="entry-title"><strong>${esc(e.degree)}</strong>${e.school ? ', <span class="company">' + esc(e.school) + '</span>' : ''}</span>
        <span class="entry-dates">${esc(e.dates || '')}</span>
      </div>`;
    if (e.details) html += `<div class="entry-sub">${esc(e.details)}</div>`;
    html += '</div>';
  }
  return html + '</section>';
}

function renderSkills(cv, labels) {
  if (!cv.skills) return '';
  const entries = Object.entries(cv.skills).filter(([, v]) => Array.isArray(v) && v.length);
  if (!entries.length) return '';
  let html = `<section class="cv-section"><h2>${esc(labels.skills || 'Technical Skills')}</h2><div class="skills">`;
  for (const [cat, list] of entries) {
    html += `<p><strong>${esc(cat)}:</strong> ${esc(list.join(', '))}</p>`;
  }
  return html + '</div></section>';
}

function renderLanguages(cv, labels) {
  if (!cv.languages?.length) return '';
  const items = cv.languages.map(l => typeof l === 'string'
    ? esc(l)
    : `${esc(l.lang || l.language || '')}${l.level ? ' <span class="lang-level">(' + esc(l.level) + ')</span>' : ''}`);
  return `<section class="cv-section">
    <h2>${esc(labels.languages || 'Languages')}</h2>
    <p class="inline-list">${items.join(' &middot; ')}</p>
  </section>`;
}

function renderCertifications(cv, labels) {
  if (!cv.certifications?.length) return '';
  return `<section class="cv-section">
    <h2>${esc(labels.certifications || 'Certifications')}</h2>
    <ul class="tight">${cv.certifications.map(c => '<li>' + esc(c) + '</li>').join('')}</ul>
  </section>`;
}

const SECTION_RENDERERS = {
  summary:        renderSummary,
  experience:     renderExperience,
  education:      renderEducation,
  skills:         renderSkills,
  languages:      renderLanguages,
  certifications: renderCertifications,
};

function renderHeaderBlock(cv, template) {
  // Custom hook: if the template provides a header renderer, defer to it.
  if (template.renderHeader) return template.renderHeader(cv);

  // Default header: name centered, target title under, contact line, no photo.
  const contactBits = [cv.email, cv.phone, cv.address, cv.linkedin].filter(Boolean).map(esc).join(' &middot; ');
  return `<header class="cv-header">
    <h1>${esc(cv.name)}</h1>
    ${cv.targetTitle ? `<p class="cv-headline">${esc(cv.targetTitle)}</p>` : ''}
    <p class="cv-contact">${contactBits}</p>
  </header>`;
}

function renderHtml(cv, template) {
  const labels = template.labels || {};
  const sections = (template.sections || ['summary','experience','education','skills','languages','certifications'])
    .map(key => (SECTION_RENDERERS[key] ? SECTION_RENDERERS[key](cv, labels) : ''))
    .filter(Boolean)
    .join('\n');

  const personalData = template.renderPersonalData ? template.renderPersonalData(cv, labels) : '';
  const signature    = template.renderSignature    ? template.renderSignature(cv, labels)    : '';

  const body = `<!DOCTYPE html><html lang="${template.lang || 'en'}"><head><meta charset="utf-8"/>
    <title>${esc(cv.name)} — CV</title>
    <style>${template.css}</style></head>
    <body><div class="cv-page">
      ${renderHeaderBlock(cv, template)}
      ${personalData}
      ${sections}
      ${signature}
    </div></body></html>`;
  return body;
}

async function renderPdf(html, outputPath, { margin = { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' } } = {}) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: outputPath, format: 'A4', printBackground: true, margin });
  } finally {
    await browser.close();
  }
}

function saveHtml(html, outputPath) {
  fs.writeFileSync(outputPath, html, 'utf-8');
}

module.exports = { renderHtml, renderPdf, saveHtml, esc };
