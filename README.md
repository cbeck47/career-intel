# Career Intel

A personal career intelligence app. Pulls jobs from USAJOBS and company career pages via ATS adapters (Greenhouse, Lever, Ashby, SmartRecruiters, Oracle Recruiting Cloud), scores them against your profile using AI, and helps you discover adjacent careers, understand your market value, and tailor your resume.

## Setup

### 1. Clone and install

```bash
npm install
```

### 2. Configure API keys

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```
USAJOBS_API_KEY=your_key_here
USAJOBS_EMAIL=your_registered_email@example.com
OPENAI_API_KEY=sk-your_key_here
PORT=3000
```

- **USAJOBS key**: Register free at https://developer.usajobs.gov
- **OpenAI key**: Get at https://platform.openai.com — `gpt-4o-mini` is used by default for scoring (cheap); `gpt-4o` is used for resume tailoring and worth analysis

### 3. Configure job sources

Copy `config.example.json` to `config.json` and edit:

```bash
cp config.example.json config.json
```

- Set your search keywords, location, and radius for USAJOBS
- Add employers to the **Companies** registry (via ATS Discovery or import)

**Company Registry:** Employers are stored in `data/companies.json` with ATS type and identifier. On first run, existing config slug arrays are migrated automatically. Use the **Companies** tab to paste a careers URL — the app detects the ATS, extracts the identifier, and scores confidence. High-confidence detections (default ≥85) can be added with one click.

**Oracle Recruiting Cloud:** Identifier format is `{tenantHost}|{siteNumber}` (e.g. `efds.fa.em5.oraclecloud.com|CX_1` for Ford). Optional `application_url` builds apply links like `https://apply.ford.com/en/sites/CX_1/job/{id}`.

**Sync filters:** Set `sync_filters.enabled` to `true` in config to only sync jobs matching both location and title keyword lists. Default is `false` (sync all jobs). Applies to SmartRecruiters and Oracle Recruiting Cloud.

**SmartRecruiters detail fetching:** When sync filters are off, full job descriptions are still fetched selectively when a posting matches location/title keywords (legacy `smartrecruiters.detail_*` keys, or `sync_filters` keywords).

### 4. Run

```bash
npm start
```

Open http://localhost:3000

## Usage

1. **Profile** tab — paste your resume, add skills, set compensation targets
2. **Companies** tab — paste careers URLs to detect ATS and build your registry
3. **Jobs** tab — click "Sync Jobs" to pull from USAJOBS and registered companies
4. Click the **Score** button on any job to run AI matching
5. **Discover** tab — click "Analyze" to find adjacent careers and skill gaps
6. **My Worth** tab — click "Analyze" for market value estimate and career ROI
7. **Tailor Resume** tab — select a job and generate a tailored resume + cover letter
8. **Tracker** tab — track application status from Saved → Offer

## Data

All sensitive data stays local:
- `data/profile.json` — your profile (gitignored)
- `data/jobs.json` — fetched and scored jobs (gitignored)
- `data/companies.json` — company registry with ATS identifiers (gitignored)
- `data/discover.json` — last Career Discovery analysis (gitignored)
- `localStorage` — tracker and worth cache
