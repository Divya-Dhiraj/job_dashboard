// Renders all CV template candidates as PDFs (and HTML for in-browser
// preview) into /Users/divya/Documents/Job Application Claude/_template_samples/.
// Used to let the user pick a default template before we wire it into the
// signup wizard.
const path = require('path');
const fs = require('fs');
const { renderHtml, renderPdf, saveHtml } = require('../templates/_render');
const sampleData = require('../templates/_sample_data');

const TEMPLATES = [
  require('../templates/ats_compact'),
  require('../templates/german_lebenslauf'),
  require('../templates/modern_single'),
  require('../templates/ultra_compact'),
];

const OUT_DIR = path.resolve(__dirname, '../../_template_samples');

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let pdfFailed = false;
  for (const tpl of TEMPLATES) {
    const html = renderHtml(sampleData, tpl);
    const htmlPath = path.join(OUT_DIR, `${tpl.id}.html`);
    const pdfPath  = path.join(OUT_DIR, `${tpl.id}.pdf`);
    saveHtml(html, htmlPath);
    if (!pdfFailed) {
      try {
        await renderPdf(html, pdfPath, { margin: tpl.margin });
        console.log(`✓ ${tpl.name}  →  ${pdfPath}`);
        continue;
      } catch (e) {
        console.warn(`⚠  PDF render failed (${e.message.split('\n')[0]}). Falling back to HTML for the rest.`);
        pdfFailed = true;
      }
    }
    console.log(`✓ ${tpl.name}  →  ${htmlPath} (HTML only)`);
  }

  // Convenience: an index page that links all four for side-by-side comparison
  const indexHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <title>CV Template Samples</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; color: #1f2937; }
      h1 { margin: 0 0 6px; }
      p.sub { color: #6b7280; margin: 0 0 24px; font-size: 14px; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
      .card h2 { margin: 0 0 4px; font-size: 17px; }
      .card p  { margin: 0 0 10px; color: #4b5563; font-size: 13px; }
      .links a { display: inline-block; padding: 6px 12px; border-radius: 6px;
                 background: #1F4E79; color: white; text-decoration: none;
                 font-size: 13px; margin-right: 6px; }
      .links a.ghost { background: transparent; color: #1F4E79; border: 1px solid #1F4E79; }
      .id { color: #9ca3af; font-family: monospace; font-size: 12px; }
    </style></head><body>
    <h1>CV Template Samples</h1>
    <p class="sub">Open each one, decide which fits best (or pick multiple — the wizard will offer all selected). Tell me the template id(s) and I'll wire it/them in.</p>
    ${TEMPLATES.map(tpl => `
      <div class="card">
        <h2>${tpl.name} <span class="id">id: ${tpl.id}</span></h2>
        <p>${tpl.description}</p>
        <div class="links">
          <a href="${tpl.id}.html" target="_blank">Open HTML preview</a>
          ${pdfFailed ? '' : `<a href="${tpl.id}.pdf" class="ghost" target="_blank">Open PDF</a>`}
        </div>
      </div>`).join('')}
    </body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf-8');

  console.log('\nIndex page:', path.join(OUT_DIR, 'index.html'));
  console.log('Open index.html in any browser to compare side-by-side, then tell me which id you want.');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
