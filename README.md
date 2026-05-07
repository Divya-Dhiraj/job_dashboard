# Job Dashboard

A multi-profile job-application assistant. It scrapes LinkedIn + Indeed for
relevant openings, scores each one against your resume, and uses Claude to
generate a tailored CV + cover letter (English, German, or both) for any
job you want to apply to. Includes a per-profile "brain" that learns from
each application so future generations sound more like you over time.

Built for people who apply to a lot of jobs and are tired of copying the
same bullet points around with slightly different phrasings.

---

## Quick install

> **TL;DR** — clone, run the install script, open <http://localhost:3000>.

### macOS / Linux

```bash
git clone https://github.com/divyadhiraj/job-dashboard.git
cd job-dashboard
bash install.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/divyadhiraj/job-dashboard.git
cd job-dashboard
powershell -ExecutionPolicy Bypass -File install.ps1
```

The install script will:

1. Detect whether you have Docker, Node.js, or both.
2. Ask which one to run with (Docker is the recommended default).
3. Prepare `.env` from either `.env.shared` (bundled keys, see below) or
   `.env.example` (blank — fill in keys yourself).
4. Build and launch the dashboard at <http://localhost:3000>.

First Docker boot takes 60–90 seconds because it pulls a ~500 MB embeddings
model. Subsequent boots are near-instant.

---

## Two install modes

The install scripts support two distribution patterns.

### A. Shared key (friends-of-Divya distribution)

If you receive the project as a `.zip` from Divya containing a `.env.shared`
file, the install script copies that into `.env` automatically and you have
nothing to configure — Anthropic + Apify calls bill against her account.

> `.env.shared` is gitignored and will never appear on GitHub. It must be
> distributed out-of-band (DM, encrypted message, AirDrop). Do not commit it.

### B. Bring-your-own keys

If you cloned the public repo, `.env.shared` won't exist. The install
script falls back to `.env.example`, which has placeholders for:

- `ANTHROPIC_API_KEY` — get one from <https://console.anthropic.com>
- `APIFY_TOKEN` — get one from <https://console.apify.com> (free tier works)
- `RESEND_API_KEY` *(optional)* — for email digests

You can either edit `.env` directly or fill these in via the in-app
**Settings** page after first boot.

---

## What gets installed

| | Docker mode | Native mode |
|---|---|---|
| Node.js runtime | bundled (Node 22) | requires Node ≥ 18 |
| Chromium for PDF rendering | bundled | downloaded by puppeteer postinstall |
| Embeddings model | downloaded on first boot | downloaded on first boot |
| SQLite database | `./jobs.db` (bind-mounted) | `./jobs.db` |
| Generated CVs | `./applications/...` | `./applications/...` |

Native mode is slightly faster on Apple Silicon but more fragile — `sharp`
sometimes fails to build natively, and `puppeteer` insists on its own
Chromium download. Docker sidesteps both.

---

## First-run setup

1. Open <http://localhost:3000>.
2. Sign up — pick a username + password (stored locally, hashed with bcrypt).
3. Upload your resume (PDF or DOCX). Claude parses it into a structured
   profile.
4. (Optional) Upload a photo, set German address fields, choose a CV
   template, configure language preferences.
5. (Optional) Paste a LinkedIn `li_at` cookie if you want authenticated
   scraping — without it the scraper falls back to public search results.
6. Click **Scrape now** to pull your first batch of jobs, or paste a job
   URL/description in the **Paste a Job** tab to generate something
   immediately.

---

## Branch model

This repo uses two long-lived branches.

- **`main`** — stable. Only release-quality commits land here. This is what
  you should pull from if you just want a working install.
- **`working`** — active development. New features, refactors,
  half-finished work. Expect breakage; don't pull this if you actually
  need to apply to jobs today.

Day-to-day workflow:

```bash
git checkout working
# ...edit, commit...
git push origin working

# When working is stable and you want to release:
git checkout main
git merge --ff-only working   # or non-ff if you prefer a merge commit
git push origin main
```

### First push to GitHub

The repo is initialized locally but not yet pushed to a remote. To push:

```bash
# 1. Create the remote repo on GitHub (web UI — name it job-dashboard,
#    keep it PRIVATE if you plan to ship .env.shared).
# 2. Wire up the remote and push both branches:
cd job-dashboard
git remote add origin https://github.com/divyadhiraj/job-dashboard.git
git push -u origin main
git push -u origin working
```

---

## Manual install (if the script breaks)

### Docker

```bash
docker compose up -d --build
docker compose logs -f      # follow logs
docker compose down         # stop
```

### Native

```bash
# Mac (Homebrew)
brew install node@22
node --version              # confirm >= 18

# Windows
# Download Node 22 LTS from https://nodejs.org and install.

cd job-dashboard
cp .env.example .env        # then edit with your keys
npm install
npm start
```

If `npm install` fails on `sharp`, run `npm rebuild sharp` and retry. On
Apple Silicon you may also need `npm install --include=optional sharp`.

---

## Troubleshooting

**Sharp module not found** — Native install on Apple Silicon. Either
`npm rebuild sharp` or switch to the Docker mode.

**Puppeteer can't find Chromium** — Native install. Run
`npx puppeteer browsers install chrome` from the project root.

**Apify returns 403** — The default LinkedIn actor (`bebity`) requires a
paid Apify plan or your own LinkedIn cookie. Switch to the public actor
(`valig`) in **Settings → Pipeline** for free-tier scraping.

**Stale PDF after editing a bullet** — The PDF re-render is debounced 800
ms. Open the preview tab again or refresh; the latest render is forced when
the preview endpoint is hit.

**Can't log in after a fresh start** — Auth lives in `jobs.db`. If you
deleted that file you also wiped the user table; create a new account.

---

## What's inside

```
job_dashboard/
├── server.js            # Express API + cron + auth middleware
├── auth.js              # signup/login, bcrypt, signed-cookie sessions
├── database.js          # sql.js schema + CRUD (per-profile scoped)
├── brain.js             # profile-specific learning loop
├── brain_db.js          # brain tables: facts, achievements, insights
├── generator.js         # Claude → CV + cover letter docx + pdf
├── prompts/             # all system prompts in one place
├── matcher.js           # skill + title + embedding scoring
├── scraper.js           # Apify (LinkedIn + Indeed)
├── embeddings.js        # bge-base-en-v1.5 via @xenova/transformers
├── templates/           # 4 CV templates (modern_single is default)
├── public/              # frontend (vanilla JS, no framework)
├── Dockerfile
├── docker-compose.yml      # production
├── docker-compose.dev.yml  # hot-reload bind mount for editing
├── install.sh / install.ps1
└── .env.example / .env.shared.example
```

---

## License

Private to the maintainer. Do not redistribute the bundled `.env.shared`.
