// Template 3: Modern Single Column
// Subtle navy accent on section headings, otherwise minimal. Single column,
// good readability, slightly more breathing room than ATS Compact. Still
// ATS-safe (no tables, no text in images, linear flow).
module.exports = {
  id: 'modern_single',
  name: 'Modern Single Column',
  description: 'Single column · navy section-heading underlines · clear visual separation between sections · narrow margins. Best balance of structure, readability and density.',
  margin: { top: '12mm', bottom: '12mm', left: '14mm', right: '14mm' },
  sections: ['summary','experience','education','skills','languages','certifications'],
  css: `
    @page { size: A4; }
    * { box-sizing: border-box; }
    body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; color: #1f2937; margin: 0;
           font-size: 10pt; line-height: 1.4; }

    /* No outer page border by user request. In the browser preview the
       page still floats centered on a soft grey backdrop so it visually
       reads like a printed sheet; in the PDF (puppeteer) the @page
       margin handles outer whitespace and we render edge-to-edge inside
       it — no decorative frame. */
    @media screen {
      body { background: #e5e7eb; padding: 28px; }
      .cv-page {
        background: #ffffff;
        padding: 14mm 16mm;
        max-width: 210mm;
        margin: 0 auto;
        box-shadow: 0 6px 20px rgba(0,0,0,0.15);
      }
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .cv-page { padding: 0; }
    }

    /* Header — strong rule so the contact block is clearly separated. */
    .cv-header {
      margin-bottom: 10px; padding-bottom: 6px;
      border-bottom: 3px solid #1F4E79;
    }
    .cv-header h1 { font-size: 19pt; margin: 0 0 2px; color: #1F4E79; font-weight: 700; letter-spacing: 0.3px; }
    .cv-headline { font-size: 11pt; margin: 0 0 3px; color: #333; font-weight: 600; }
    .cv-contact  { font-size: 9.5pt; margin: 0; color: #555; }

    .cv-section { margin-top: 12px; }
    /* Section headings — plain. Just bold uppercase text with a single
       underline separating it from the section body. No backgrounds,
       no decorative bars. */
    .cv-section h2 {
      font-size: 11pt; text-transform: uppercase; letter-spacing: 0.6px;
      margin: 0 0 5px; padding: 0 0 2px;
      color: #1F4E79; font-weight: 700;
      border-bottom: 1px solid #1F4E79;
    }

    .summary { margin: 0; text-align: justify; }

    .entry { margin-bottom: 10px; }
    /* No inner separators between entries — page border + section underlines
       provide enough visual structure. Adding hairlines here stacked with
       the section header rule + page border made each entry look "boxed". */
    .entry-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .entry-title { font-size: 10.5pt; }
    .company { color: #1F4E79; font-weight: 600; }
    .entry-dates { font-size: 9.5pt; color: #555; white-space: nowrap; }
    .entry-sub   { font-size: 9.5pt; color: #555; margin: 0 0 2px; }
    ul { margin: 2px 0 4px 16px; padding: 0; }
    ul.tight { margin: 2px 0 0 16px; }
    li { margin-bottom: 1.5px; }
    .skills p { margin: 1.5px 0; font-size: 10pt; }
    .inline-list { margin: 0; }
    .lang-level { color: #555; }
  `,
};
