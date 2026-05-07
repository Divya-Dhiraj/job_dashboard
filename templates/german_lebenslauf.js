// Template 2: German Lebenslauf Compact
// Proper Lebenslauf conventions: photo top-right, "Persönliche Daten" first,
// German section labels, signature line. Single column for body content,
// header uses a 2-column flex (text left, photo right). ATS-friendly because
// content order is linear.
const { esc } = require('./_render');

module.exports = {
  id: 'german_lebenslauf',
  name: 'German Lebenslauf (Standard)',
  description: 'Single column · German section labels · photo top-right · Persönliche Daten block · signature line. Built to the standard German CV conventions while staying ATS-readable.',
  lang: 'de',
  margin: { top: '12mm', bottom: '10mm', left: '14mm', right: '14mm' },
  labels: {
    summary:        'Profil',
    experience:     'Berufserfahrung',
    education:      'Ausbildung',
    skills:         'Kenntnisse',
    languages:      'Sprachen',
    certifications: 'Zertifizierungen',
  },
  sections: ['summary','experience','education','skills','languages','certifications'],
  renderHeader(cv) {
    const photo = cv.photoDataUrl ? `<img class="photo" src="${cv.photoDataUrl}" alt="Profile photo"/>` : '';
    const contactBits = [cv.email, cv.phone, cv.linkedin].filter(Boolean).map(esc).join(' &middot; ');
    return `<header class="cv-header">
      <div class="head-text">
        <h1>${esc(cv.name)}</h1>
        ${cv.targetTitle ? `<p class="cv-headline">${esc(cv.targetTitle)}</p>` : ''}
        ${cv.address ? `<p class="cv-addr">${esc(cv.address)}</p>` : ''}
        <p class="cv-contact">${contactBits}</p>
      </div>
      ${photo}
    </header>`;
  },
  renderPersonalData(cv) {
    const rows = [];
    if (cv.dob)             rows.push(['Geburtsdatum',     cv.dob]);
    if (cv.place_of_birth)  rows.push(['Geburtsort',       cv.place_of_birth]);
    if (cv.nationality)     rows.push(['Staatsangehörigkeit', cv.nationality]);
    if (cv.marital_status)  rows.push(['Familienstand',    cv.marital_status]);
    if (!rows.length) return '';
    return `<section class="cv-section">
      <h2>Persönliche Daten</h2>
      <table class="personal-data">${rows.map(r => `<tr><td class="pd-key">${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>
    </section>`;
  },
  renderSignature(cv) {
    const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
    const ort   = (cv.address || '').split(',')[0].trim() || 'München';
    return `<div class="signature-block">
      <div>${esc(ort)}, ${today}</div>
      <div class="sign-line">${esc(cv.name)}</div>
    </div>`;
  },
  css: `
    @page { size: A4; }
    * { box-sizing: border-box; }
    body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; color: #1a1a1a; margin: 0;
           font-size: 10pt; line-height: 1.34; }
    .cv-page { padding: 0; }

    .cv-header {
      display: flex; gap: 16px; align-items: flex-start;
      padding-bottom: 8px; margin-bottom: 8px;
      border-bottom: 0.6pt solid #1a1a1a;
    }
    .head-text { flex: 1; min-width: 0; }
    .cv-header h1 { font-size: 19pt; margin: 0 0 2px; font-weight: 700; }
    .cv-headline { font-size: 11pt; margin: 0 0 4px; color: #333; font-weight: 600; }
    .cv-addr     { font-size: 10pt;  margin: 0 0 2px; color: #444; }
    .cv-contact  { font-size: 9.5pt; margin: 0;       color: #444; }
    .photo {
      width: 32mm; height: 42mm; object-fit: cover;
      border: 0.5pt solid #999;
    }

    .cv-section { margin-top: 10px; }
    .cv-section h2 {
      font-size: 11pt; margin: 0 0 4px; color: #1a1a1a; font-weight: 700;
      letter-spacing: 0.3px;
      border-bottom: 0.4pt solid #999; padding-bottom: 1px;
    }
    .personal-data { width: 100%; border-collapse: collapse; }
    .personal-data td { font-size: 10pt; padding: 1px 0; vertical-align: top; }
    .pd-key { width: 40mm; color: #555; font-weight: 600; }

    .summary { margin: 0; text-align: justify; }
    .entry { margin-bottom: 7px; }
    .entry-head {
      display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    }
    .entry-title { font-size: 10.5pt; }
    .entry-dates { font-size: 9.5pt; color: #333; white-space: nowrap; }
    .entry-sub   { font-size: 9.5pt; color: #555; margin: 0 0 2px; }
    .company     { font-weight: 600; }
    ul { margin: 2px 0 4px 16px; padding: 0; }
    ul.tight { margin: 2px 0 0 16px; }
    li { margin-bottom: 1.5px; }
    .skills p { margin: 1px 0; font-size: 10pt; }
    .inline-list { margin: 0; }
    .lang-level  { color: #555; }

    .signature-block {
      margin-top: 18px;
      display: flex; flex-direction: column; gap: 14mm;
      font-size: 10pt;
    }
    .sign-line {
      border-top: 0.4pt solid #1a1a1a;
      padding-top: 2px;
      width: 70mm;
      font-weight: 600;
    }
  `,
};
