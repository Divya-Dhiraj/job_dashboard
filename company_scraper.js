// company_scraper.js — Scrapes company career pages directly
// Amazon Jobs has a public REST API we can call without Apify credits!
// Others use direct HTTP + HTML parsing via cheerio.
const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
};

const SEARCH_TERMS = [
  'Business Intelligence', 'Data Analyst', 'BI Developer', 'Analytics',
  'Data Engineer', 'SAP', 'Reporting',
];

// ─────────────────────────────
// Amazon Jobs (public JSON API)
// ─────────────────────────────
async function scrapeAmazonJobs() {
  const jobs = [];
  for (const term of SEARCH_TERMS.slice(0, 4)) {
    try {
      const url = `https://amazon.jobs/en/search.json?base_query=${encodeURIComponent(term)}&loc_query=Germany&radius=24km&sort=recent&result_limit=10`;
      const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const hits = res.data?.jobs || [];
      hits.forEach(item => {
        const id = `amazon_${item.id_icims || item.job_id || Math.random()}`;
        const loc = item.location;
        const locationStr = Array.isArray(loc) ? loc.join(', ') : (typeof loc === 'string' ? loc : 'Germany');
        jobs.push({
          id,
          title:          item.title || '',
          company:        'Amazon',
          location:       locationStr,
          salary:         '',
          description:    (item.description || item.basic_qualifications || '').replace(/<[^>]+>/g, '').slice(0, 3000),
          apply_url:      `https://amazon.jobs${item.job_path || ''}`,
          posted_at:      item.posted_date ? new Date(item.posted_date).toISOString() : new Date().toISOString(),
          scraped_at:     new Date().toISOString(),
          source:         'Amazon Jobs',
          match_score:    0,
          matched_skills: '[]',
        });
      });
      console.log(`[Amazon] "${term}": ${hits.length} jobs`);
    } catch (err) {
      console.error(`[Amazon] Error for "${term}": ${err.message}`);
    }
    await sleep(1500);
  }
  return jobs;
}

// ─────────────────────────────
// SAP Jobs (simple JSON API)
// ─────────────────────────────
async function scrapeSAPJobs() {
  const jobs = [];
  for (const term of SEARCH_TERMS.slice(0, 3)) {
    try {
      const url = `https://jobs.sap.com/search/?q=${encodeURIComponent(term)}&locationsearch=Germany&sortColumn=referencedate&sortDirection=desc`;
      const res = await axios.get(url, { headers: { ...HEADERS, Accept: 'text/html' }, timeout: 15000 });
      // Parse job IDs from HTML (SAP uses server-rendered links)
      const html = res.data || '';
      const matches = [...html.matchAll(/href="(\/job\/[^"]+)"/g)];
      const uniqueUrls = [...new Set(matches.map(m => `https://jobs.sap.com${m[1]}`))].slice(0, 5);
      for (const jobUrl of uniqueUrls) {
        const titleMatch = html.match(new RegExp(`href="${jobUrl.replace('https://jobs.sap.com', '')}"[^>]*>([^<]+)<`));
        const id = `sap_${jobUrl.split('/').pop()}`;
        jobs.push({
          id,
          title:          titleMatch ? titleMatch[1].trim() : `SAP ${term} Role`,
          company:        'SAP',
          location:       'Germany',
          salary:         '',
          description:    `SAP ${term} position. Visit the link to see full description.`,
          apply_url:      jobUrl,
          posted_at:      new Date().toISOString(),
          scraped_at:     new Date().toISOString(),
          source:         'SAP Careers',
          match_score:    0,
          matched_skills: '[]',
        });
      }
      console.log(`[SAP] "${term}": ${uniqueUrls.length} jobs`);
    } catch (err) {
      console.error(`[SAP] Error for "${term}": ${err.message}`);
    }
    await sleep(2000);
  }
  return jobs;
}

// ─────────────────────────────
// Siemens Jobs (SmartRecruiters JSON API)
// ─────────────────────────────
async function scrapeSiemensJobs() {
  const jobs = [];
  for (const term of SEARCH_TERMS.slice(0, 3)) {
    try {
      // Siemens now uses SmartRecruiters — public JSON API, no auth needed
      const url = `https://careers.siemens.com/api/apply/v2/jobs?domain=siemens.com&query=${encodeURIComponent(term)}&location=Germany&country=DE&pageSize=10&sortBy=relevance`;
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      const hits = res.data?.positions || res.data?.jobs || [];
      for (const item of hits.slice(0, 5)) {
        const city    = item.cityName || item.location || 'Germany';
        const country = item.countryName || item.country || '';
        const locStr  = country ? `${city}, ${country}` : city;
        const id      = `siemens_${item.id || item.positionId || Math.random().toString(36).slice(2)}`;
        jobs.push({
          id,
          title:          item.name || item.title || '',
          company:        'Siemens',
          location:       locStr,
          salary:         '',
          description:    (item.jobDescription || item.description || `Siemens ${term} position in Germany.`).replace(/<[^>]+>/g, '').slice(0, 3000),
          apply_url:      item.applyUrl || `https://careers.siemens.com/jobs/${item.id || ''}`,
          posted_at:      item.postedDate || new Date().toISOString(),
          scraped_at:     new Date().toISOString(),
          source:         'Siemens Careers',
          match_score:    0,
          matched_skills: '[]',
        });
      }
      console.log(`[Siemens] "${term}": ${hits.length} jobs`);
    } catch (err) {
      console.error(`[Siemens] Error for "${term}": ${err.message}`);
    }
    await sleep(2000);
  }
  return jobs;
}

// ─────────────────────────────
// BMW Group Jobs
// ─────────────────────────────
async function scrapeBMWJobs() {
  const jobs = [];
  for (const term of ['Business Intelligence', 'Data Analyst']) {
    try {
      const url = `https://www.bmwgroup.jobs/de/en/jobsearch.html?q=${encodeURIComponent(term)}&country=DEU`;
      const res = await axios.get(url, { headers: { ...HEADERS, Accept: 'text/html' }, timeout: 30000 });
      const html = res.data || '';
      const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      for (const m of ldMatches.slice(0, 5)) {
        try {
          const data = JSON.parse(m[1]);
          if (data['@type'] === 'JobPosting' || (Array.isArray(data) && data[0]?.['@type'] === 'JobPosting')) {
            const posting = Array.isArray(data) ? data[0] : data;
            const id = `bmw_${posting.identifier?.value || Math.random()}`;
            jobs.push({
              id,
              title:          posting.title || `BMW ${term} Role`,
              company:        'BMW Group',
              location:       'Munich, Germany',
              salary:         '',
              description:    (posting.description || '').replace(/<[^>]+>/g, '').slice(0, 3000),
              apply_url:      posting.url || url,
              posted_at:      posting.datePosted || new Date().toISOString(),
              scraped_at:     new Date().toISOString(),
              source:         'BMW Careers',
              match_score:    0,
              matched_skills: '[]',
            });
          }
        } catch {}
      }
      console.log(`[BMW] "${term}": done`);
    } catch (err) {
      console.error(`[BMW] Error: ${err.message}`);
    }
    await sleep(2000);
  }
  return jobs;
}

// ─────────────────────────────
// Deutsche Telekom Jobs (SmartRecruiters public API)
// ─────────────────────────────
async function scrapeTelekomJobs() {
  const jobs = [];
  for (const term of ['Data Analyst', 'Business Intelligence']) {
    try {
      // Telekom migrated from Taleo to SmartRecruiters
      const url = `https://careers.telekom.com/api/apply/v2/jobs?domain=telekom.com&query=${encodeURIComponent(term)}&location=Germany&country=DE&pageSize=10`;
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      const hits = res.data?.positions || res.data?.jobs || [];
      for (const item of hits.slice(0, 5)) {
        const city   = item.cityName || item.location || 'Germany';
        const id     = `telekom_${item.id || item.positionId || Math.random().toString(36).slice(2)}`;
        jobs.push({
          id,
          title:          item.name || item.title || `Deutsche Telekom ${term}`,
          company:        'Deutsche Telekom',
          location:       city.toLowerCase().includes('germany') || city.toLowerCase().includes('deutsch')
                            ? city : `${city}, Germany`,
          salary:         '',
          description:    (item.jobDescription || item.description || `Deutsche Telekom ${term} position.`).replace(/<[^>]+>/g, '').slice(0, 3000),
          apply_url:      item.applyUrl || `https://careers.telekom.com/jobs/${item.id || ''}`,
          posted_at:      item.postedDate || new Date().toISOString(),
          scraped_at:     new Date().toISOString(),
          source:         'Telekom Careers',
          match_score:    0,
          matched_skills: '[]',
        });
      }
      console.log(`[Telekom] "${term}": ${hits.length} jobs`);
    } catch (err) {
      console.error(`[Telekom] Error for "${term}": ${err.message}`);
    }
    await sleep(2000);
  }
  return jobs;
}

// ─────────────────────────────
// All company career pages combined
// ─────────────────────────────
async function scrapeCompanyPages() {
  console.log('[CompanyScraper] Scraping company career pages...');
  const [amazon, sap, siemens, bmw, telekom] = await Promise.allSettled([
    scrapeAmazonJobs(),
    scrapeSAPJobs(),
    scrapeSiemensJobs(),
    scrapeBMWJobs(),
    scrapeTelekomJobs(),
  ]);

  const all = [
    ...(amazon.status    === 'fulfilled' ? amazon.value    : []),
    ...(sap.status       === 'fulfilled' ? sap.value       : []),
    ...(siemens.status   === 'fulfilled' ? siemens.value   : []),
    ...(bmw.status       === 'fulfilled' ? bmw.value       : []),
    ...(telekom.status   === 'fulfilled' ? telekom.value   : []),
  ];

  // Deduplicate by title+company
  const seen = new Set();
  const deduped = all.filter(j => {
    const key = `${j.title}__${j.company}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[CompanyScraper] Done. ${deduped.length} company jobs from ${[amazon,sap,siemens,bmw,telekom].filter(r=>r.status==='fulfilled').length}/5 sources.`);
  return deduped;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrapeCompanyPages, scrapeAmazonJobs };
