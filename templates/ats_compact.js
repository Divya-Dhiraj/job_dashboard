// Template 1: ATS Strict Compact
// Single-column, monochrome, dense, no decorative elements. Heading uses ALL
// CAPS + a single hairline rule. ATS parsers love this layout.
module.exports = {
  id: 'ats_compact',
  name: 'ATS Strict Compact',
  description: 'Single column · monochrome · max density. Pure ATS-friendly. Best when the only goal is "get past the filter and onto the screen".',
  margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
  sections: ['summary','experience','education','skills','languages','certifications'],
  css: `
    @page { size: A4; }
    * { box-sizing: border-box; }
    body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; color: #111; margin: 0; padding: 0;
           font-size: 10pt; line-height: 1.32; }
    .cv-page { padding: 0; }
    .cv-header { margin-bottom: 8px; }
    .cv-header h1 { font-size: 18pt; margin: 0 0 2px; letter-spacing: 0.5px; font-weight: 700; }
    .cv-headline { font-size: 11pt; margin: 0 0 4px; color: #333; font-weight: 600; }
    .cv-contact  { font-size: 9.5pt; margin: 0; color: #444; }

    .cv-section { margin-top: 10px; }
    .cv-section h2 {
      font-size: 10.5pt; text-transform: uppercase; letter-spacing: 1px;
      margin: 0 0 4px; padding-bottom: 1px;
      border-bottom: 0.6pt solid #111; color: #111; font-weight: 700;
    }
    .summary { margin: 0 0 4px; text-align: justify; }
    .entry { margin-bottom: 7px; }
    .entry-head {
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 8px;
    }
    .entry-title { font-size: 10.5pt; }
    .entry-dates { font-size: 9.5pt; color: #333; white-space: nowrap; }
    .entry-sub   { font-size: 9.5pt; color: #444; margin: 0 0 2px; }
    .company     { font-weight: 600; }
    ul { margin: 2px 0 4px 16px; padding: 0; }
    ul.tight { margin: 2px 0 0 16px; }
    li { margin-bottom: 1.5px; }
    .skills p { margin: 1px 0; font-size: 10pt; }
    .inline-list { margin: 0; }
    .lang-level { color: #555; }
  `,
};
