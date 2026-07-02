require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const OpenAI = require("openai");

const { fetchUSAJobs } = require("./fetchers/usajobs");
const { fetchGreenhouse } = require("./fetchers/greenhouse");
const { fetchLever } = require("./fetchers/lever");
const { fetchAshby } = require("./fetchers/ashby");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  const cfgPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(cfgPath)) {
    console.warn("config.json not found — copy config.example.json to config.json");
    return {};
  }
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Job sync
// ---------------------------------------------------------------------------

async function syncJobs() {
  const config = loadConfig();
  const sources = config.sources ?? {};
  console.log("[sync] Starting job sync…");

  let allJobs = [];

  if (sources.usajobs && process.env.USAJOBS_API_KEY) {
    try {
      const jobs = await fetchUSAJobs(
        config,
        process.env.USAJOBS_API_KEY,
        process.env.USAJOBS_EMAIL
      );
      console.log(`[sync] USAJOBS: ${jobs.length} jobs`);
      allJobs.push(...jobs);
    } catch (err) {
      console.error("[sync] USAJOBS error:", err.message);
    }
  }

  if (sources.greenhouse) {
    try {
      const jobs = await fetchGreenhouse(config.greenhouse_companies ?? []);
      console.log(`[sync] Greenhouse: ${jobs.length} jobs`);
      allJobs.push(...jobs);
    } catch (err) {
      console.error("[sync] Greenhouse error:", err.message);
    }
  }

  if (sources.lever) {
    try {
      const jobs = await fetchLever(config.lever_companies ?? []);
      console.log(`[sync] Lever: ${jobs.length} jobs`);
      allJobs.push(...jobs);
    } catch (err) {
      console.error("[sync] Lever error:", err.message);
    }
  }

  if (sources.ashby) {
    try {
      const jobs = await fetchAshby(config.ashby_companies ?? []);
      console.log(`[sync] Ashby: ${jobs.length} jobs`);
      allJobs.push(...jobs);
    } catch (err) {
      console.error("[sync] Ashby error:", err.message);
    }
  }

  // Merge with existing to preserve AI scores
  const existing = readJson(JOBS_FILE, []);
  const existingById = Object.fromEntries(existing.map((j) => [j.id, j]));
  const merged = allJobs.map((j) => ({
    ...existingById[j.id],
    ...j,
    ai_score: existingById[j.id]?.ai_score ?? null,
  }));

  writeJson(JOBS_FILE, merged);
  console.log(`[sync] Done — ${merged.length} total jobs saved`);
  return merged;
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

async function aiJson(systemPrompt, userPrompt, model = "gpt-4o-mini") {
  const res = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
  });
  return JSON.parse(res.choices[0].message.content);
}

// ---------------------------------------------------------------------------
// Routes — Jobs
// ---------------------------------------------------------------------------

app.get("/api/jobs", (req, res) => {
  const jobs = readJson(JOBS_FILE, []);
  res.json(jobs);
});

app.post("/api/jobs/sync", async (req, res) => {
  try {
    const jobs = await syncJobs();
    res.json({ ok: true, count: jobs.length });
  } catch (err) {
    console.error("[/api/jobs/sync]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — Profile
// ---------------------------------------------------------------------------

app.get("/api/profile", (req, res) => {
  res.json(readJson(PROFILE_FILE, {}));
});

app.post("/api/profile", (req, res) => {
  const profile = req.body;
  writeJson(PROFILE_FILE, profile);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routes — AI match (Skill Graph)
// ---------------------------------------------------------------------------

app.post("/api/ai/match", async (req, res) => {
  const { job_id } = req.body;
  const jobs = readJson(JOBS_FILE, []);
  const profile = readJson(PROFILE_FILE, {});
  const job = jobs.find((j) => j.id === job_id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: "OpenAI key not configured" });

  try {
    const system = `You are a career intelligence engine. Given a candidate profile and a job description, return a JSON object with exactly these keys:
{
  "role_fit": <0-100 integer>,
  "sector_fit": <0-100 integer>,
  "comp_fit": <0-100 integer or null if salary unknown>,
  "growth_score": <0-100 integer>,
  "overall_score": <0-100 integer>,
  "top_matching_skills": [<up to 5 skill strings from the profile that match the JD>],
  "missing_skills": [<up to 5 skill strings present in JD but absent from profile>],
  "adjacent_titles": [<up to 5 alternative job titles this candidate would qualify for>],
  "recommendation": <one sentence plain-text recommendation>,
  "summary": <two sentence plain-text summary of the fit>
}`;
    const user = `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nJOB TITLE: ${job.title}\nCOMPANY: ${job.company}\nLOCATION: ${job.location}\nSALARY: ${job.salary_min ?? "?"} - ${job.salary_max ?? "?"} ${job.salary_interval ?? ""}\n\nJOB DESCRIPTION:\n${job.description_clean?.slice(0, 3000) ?? "(no description)"}`;

    const score = await aiJson(system, user);
    job.ai_score = score;
    writeJson(JOBS_FILE, jobs);
    res.json(score);
  } catch (err) {
    console.error("[/api/ai/match]", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — AI Career Discovery
// ---------------------------------------------------------------------------

app.post("/api/ai/discover", async (req, res) => {
  const profile = readJson(PROFILE_FILE, {});
  const jobs = readJson(JOBS_FILE, []);
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: "OpenAI key not configured" });

  const scoredJobs = jobs.filter((j) => j.ai_score);
  const adjacentTitles = scoredJobs.flatMap(
    (j) => j.ai_score?.adjacent_titles ?? []
  );
  const missingSkills = scoredJobs.flatMap(
    (j) => j.ai_score?.missing_skills ?? []
  );

  try {
    const system = `You are a career discovery engine. Given a candidate profile, scored jobs, and aggregated skill data, return a JSON object with exactly these keys:
{
  "adjacent_roles": [{ "title": string, "frequency": number, "avg_fit": number, "description": string }],
  "top_skill_gaps": [{ "skill": string, "frequency": number, "impact": string }],
  "sector_heatmap": [{ "sector": string, "job_count": number, "avg_fit": number }],
  "career_insights": [<up to 5 plain-text insight strings about career opportunities>],
  "pivot_paths": [{ "from": string, "to": string, "skills_needed": [string], "difficulty": "Low"|"Medium"|"High" }]
}`;
    const user = `PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nSCORED JOBS COUNT: ${scoredJobs.length}\nALL ADJACENT TITLES MENTIONED: ${[...new Set(adjacentTitles)].join(", ")}\nFREQUENT MISSING SKILLS: ${[...new Set(missingSkills)].join(", ")}\nSECTORS IN JOB POOL: ${[...new Set(jobs.map((j) => j.sector))].join(", ")}`;

    const result = await aiJson(system, user);
    res.json(result);
  } catch (err) {
    console.error("[/api/ai/discover]", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — AI What's My Worth
// ---------------------------------------------------------------------------

app.post("/api/ai/worth", async (req, res) => {
  const { market_context, scenarios } = req.body;
  const profile = readJson(PROFILE_FILE, {});
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: "OpenAI key not configured" });

  try {
    const system = `You are a compensation intelligence engine. Given a candidate profile and optional market context, return a JSON object with exactly these keys:
{
  "current_percentile": <0-100 integer>,
  "market_value": {
    "conservative": number,
    "expected": number,
    "competitive": number,
    "exceptional": number
  },
  "underpaid": boolean,
  "top_skills_in_demand": [<up to 5 skill strings>],
  "sector_premiums": [{ "sector": string, "premium_pct": number }],
  "scenarios": [{ "label": string, "delta_pct": number, "explanation": string }],
  "career_roi": [{ "action": string, "cost_estimate": string, "time_estimate": string, "salary_increase": number, "payback_period": string }],
  "summary": <two sentence plain-text market value summary>
}`;

    const user = `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nMARKET CONTEXT (user-provided salary data):\n${market_context ?? "None provided"}\n\nADDITIONAL SCENARIOS TO ANALYZE:\n${JSON.stringify(scenarios ?? [])}`;

    const result = await aiJson(system, user, "gpt-4o");
    res.json(result);
  } catch (err) {
    console.error("[/api/ai/worth]", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — AI Resume Tailor
// ---------------------------------------------------------------------------

app.post("/api/ai/resume", async (req, res) => {
  const { job_id } = req.body;
  const jobs = readJson(JOBS_FILE, []);
  const profile = readJson(PROFILE_FILE, {});
  const job = jobs.find((j) => j.id === job_id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: "OpenAI key not configured" });

  try {
    const system = `You are an expert resume writer and career coach. Given a candidate profile and a target job, return a JSON object with exactly these keys:
{
  "tailored_summary": <2-3 sentence professional summary tailored to this specific role>,
  "tailored_bullets": [{ "company": string, "title": string, "bullets": [string] }],
  "keywords_added": [<ATS keywords woven into the resume naturally>],
  "cover_letter": <full cover letter text, plain text, ~300 words>,
  "application_qa": [{ "question": string, "suggested_answer": string }],
  "tips": [<up to 3 tips specific to this application>]
}
Write in first person for the summary and cover letter. Bullets should start with strong action verbs. Add ATS keywords from the JD naturally — never keyword-stuff.`;

    const user = `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nTARGET ROLE: ${job.title} at ${job.company}\nLOCATION: ${job.location}\nSALARY RANGE: ${job.salary_min ?? "?"} - ${job.salary_max ?? "?"}\n\nJOB DESCRIPTION:\n${job.description_clean?.slice(0, 4000) ?? "(no description)"}`;

    const result = await aiJson(system, user, "gpt-4o");
    res.json(result);
  } catch (err) {
    console.error("[/api/ai/resume]", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Scheduled sync
// ---------------------------------------------------------------------------

function scheduleSyncIfConfigured() {
  const config = loadConfig();
  const hours = config.sync_interval_hours ?? 4;
  const cronExpr = `0 */${hours} * * *`;
  cron.schedule(cronExpr, () => {
    console.log(`[cron] Scheduled sync (every ${hours}h)`);
    syncJobs().catch((err) => console.error("[cron] sync error:", err.message));
  });
  console.log(`[cron] Sync scheduled every ${hours} hours`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Career Intel running at http://localhost:${PORT}`);
  scheduleSyncIfConfigured();
});
