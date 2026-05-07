// Template 4: Ultra Compact
// Most aggressive density. 9.5pt body, 10mm margins, no borders, just bold
// section headings. Designed to fit a senior 10-year career on one page
// while staying readable on screen and through ATS.
module.exports = {
  id: 'ultra_compact',
  name: 'Ultra Compact',
  description: 'Single column · narrowest margins · 9.5pt body · no decorative borders. Squeezes the most career history onto one page. Use when you have a lot of content and want every line to count.',
  margin: { top: '8mm', bottom: '8mm', left: '10mm', right: '10mm' },
  sections: ['summary','experience','education','skills','languages','certifications'],
  css: `
    @page { size: A4; }
    * { box-sizing: border-box; }
    body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; color: #111; margin: 0;
           font-size: 9.5pt; line-height: 1.28; }
    .cv-page { padding: 0; }

    .cv-header { margin-bottom: 6px; }
    .cv-header h1 { font-size: 17pt; margin: 0 0 1px; font-weight: 700; }
    .cv-headline { font-size: 10.5pt; margin: 0 0 2px; color: #333; font-weight: 600; }
    .cv-contact  { font-size: 9pt; margin: 0; color: #444; }

    .cv-section { margin-top: 7px; }
    .cv-section h2 {
      font-size: 10pt; margin: 0 0 2px; color: #111; font-weight: 800;
      text-transform: uppercase; letter-spacing: 0.4px;
    }
    .summary { margin: 0; text-align: justify; font-size: 9.5pt; }
    .entry { margin-bottom: 5px; }
    .entry-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
    .entry-title { font-size: 10pt; }
    .entry-dates { font-size: 9pt; color: #333; white-space: nowrap; }
    .entry-sub   { font-size: 9pt; color: #444; margin: 0 0 1px; }
    .company     { font-weight: 600; }
    ul { margin: 1px 0 3px 14px; padding: 0; }
    ul.tight { margin: 1px 0 0 14px; }
    li { margin-bottom: 1px; }
    .skills p { margin: 0.5px 0; font-size: 9.5pt; }
    .inline-list { margin: 0; font-size: 9.5pt; }
    .lang-level  { color: #555; }
  `,
};
