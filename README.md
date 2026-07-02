# Career Intel

A personal career intelligence app. Pulls jobs from USAJOBS, Greenhouse, Lever, and Ashby, scores them against your profile using AI, and helps you discover adjacent careers, understand your market value, and tailor your resume.

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
- Add company slugs for Greenhouse, Lever, and Ashby

### 4. Run

```bash
npm start
```

Open http://localhost:3000

## Usage

1. **Profile** tab — paste your resume, add skills, set compensation targets
2. **Jobs** tab — click "Sync Jobs" to pull from all sources
3. Click the **Score** button on any job to run AI matching
4. **Discover** tab — click "Analyze" to find adjacent careers and skill gaps
5. **My Worth** tab — click "Analyze" for market value estimate and career ROI
6. **Tailor Resume** tab — select a job and generate a tailored resume + cover letter
7. **Tracker** tab — track application status from Saved → Offer

## Data

All sensitive data stays local:
- `data/profile.json` — your profile (gitignored)
- `data/jobs.json` — fetched and scored jobs (gitignored)
- `localStorage` — tracker, discover cache, worth cache
