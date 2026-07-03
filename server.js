require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const OpenAI = require("openai");
const { ZodError } = require("zod");

const { fetchUSAJobs } = require("./fetchers/usajobs");
const { getAdapter, isSupportedAts } = require("./adapters/index");
const { rankJobs } = require("./ranking/heuristic");
const { scoreJobWithAI } = require("./ai/matchJob");
const { matchJobSchema } = require("./ai/schemas");
const { detectAts } = require("./discovery/detectAts");
const {
  normalizeCompany,
  migrateFromConfig,
  mergeCompanies,
} = require("./registry/companies");
const db = require("./db");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

db.initDb();

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

function migrateCompaniesIfEmpty() {
  const registry = db.companies.getAll();
  if (registry.companies.length > 0) return registry;

  const config = loadConfig();
  const migrated = migrateFromConfig(config);
  if (!migrated.length) return registry;

  db.companies.saveRegistry({ companies: migrated });
  console.log(`[registry] Migrated ${migrated.length} companies from config.json`);
  return { companies: migrated };
}

function loadCompaniesRegistry() {
  return migrateCompaniesIfEmpty();
}

function dedupeJobsById(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

function formatZodError(err) {
  return err.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
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

  const registry = loadCompaniesRegistry();
  const srCfg = config.smartrecruiters ?? {};
  const syncFilters = config.sync_filters ?? {};
  const enabledCompanies = registry.companies.filter(
    (company) => company.enabled && company.ats_identifier && company.ats_type
  );

  for (const company of enabledCompanies) {
    if (sources[company.ats_type] === false) continue;

    const adapter = getAdapter(company.ats_type);
    if (!adapter) {
      if (!isSupportedAts(company.ats_type)) {
        console.warn(
          `[sync] No fetch adapter for ${company.name} (${company.ats_type}) — discovery only`
        );
      }
      continue;
    }

    try {
      const adapterOpts = {
        displayName: company.name,
        syncFilters,
        smartrecruitersConfig: srCfg,
        detailLocationKeywords: srCfg.detail_location_keywords,
        detailTitleKeywords: srCfg.detail_title_keywords,
        applicationUrl: company.application_url ?? null,
      };
      const jobs = await adapter.fetch(company.ats_identifier, adapterOpts);
      allJobs.push(
        ...jobs.map((job) => ({
          ...job,
          company: company.name,
          registry_id: company.id,
        }))
      );
      console.log(`[sync] ${company.name} (${company.ats_type}): ${jobs.length} jobs`);
    } catch (err) {
      console.error(`[sync] ${company.name} error:`, err.message);
    }
  }

  const uniqueJobs = dedupeJobsById(allJobs);
  const freshIds = uniqueJobs.map((job) => job.id);
  db.jobs.upsertMany(uniqueJobs);
  const closedCount = db.jobs.markClosed(freshIds);
  const activeJobs = db.jobs.getAll({ activeOnly: true });

  console.log(`[sync] Done — ${activeJobs.length} active jobs (${closedCount} marked closed)`);
  return activeJobs;
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

async function aiJson(systemPrompt, userPrompt, model = "gpt-4o-mini", schema = null) {
  const res = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
  });

  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch (err) {
    throw new Error(`Invalid JSON from model: ${err.message}`);
  }

  if (schema) {
    try {
      return schema.parse(parsed);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new Error(`AI response validation failed: ${formatZodError(err)}`);
      }
      throw err;
    }
  }

  return parsed;
}

async function scoreJobWithValidation(job, profile) {
  return scoreJobWithAI(job, profile, (system, user) =>
    aiJson(system, user, "gpt-4o-mini", matchJobSchema)
  );
}

// ---------------------------------------------------------------------------
// Routes — Jobs
// ---------------------------------------------------------------------------

app.get("/api/jobs", (req, res) => {
  const jobs = db.jobs.getAll({ activeOnly: true });
  res.json(jobs);
});

app.post("/api/jobs/rank", (req, res) => {
  const profile = db.profile.get();
  if (!profile.name?.trim() || !(profile.skills ?? []).length) {
    return res.status(400).json({ error: "Profile must include name and skills before ranking jobs" });
  }

  const discoverSaved = db.discover.get();
  const discoverResult = discoverSaved?.result ?? null;
  const jobs = db.jobs.getAll({ activeOnly: true });
  const config = loadConfig();
  const topN = config.ranking?.top_n ?? 50;
  const rankedAt = new Date().toISOString();

  const ranked = rankJobs(jobs, profile, discoverResult);
  ranked.forEach((job) => {
    job.heuristic_scored_at = rankedAt;
  });
  db.jobs.updateRankings(ranked);

  const top50 = ranked.slice(0, topN).map((job) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    source: job.source,
    heuristic_score: job.heuristic_score,
    heuristic_components: job.heuristic_components,
    url: job.url,
  }));

  res.json({ ranked: ranked.length, top50, ran_at: rankedAt });
});

app.post("/api/jobs/deep-score", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OpenAI key not configured" });
  }

  const profile = db.profile.get();
  const config = loadConfig();
  const topN = config.ranking?.top_n ?? 50;
  const jobs = db.jobs.getAll({ activeOnly: true });
  const candidates = [...jobs]
    .sort((a, b) => (b.heuristic_score ?? -1) - (a.heuristic_score ?? -1))
    .slice(0, topN);

  if (!candidates.length) {
    return res.status(400).json({ error: "Rank jobs first to select top candidates for deep scoring" });
  }

  let scored = 0;
  let errors = 0;

  for (const job of candidates) {
    try {
      const score = await scoreJobWithValidation(job, profile);
      db.jobs.updateAiScore(job.id, score);
      scored += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (err) {
      console.error(`[/api/jobs/deep-score] ${job.id}:`, err.message);
      errors += 1;
    }
  }

  res.json({ scored, errors, total: candidates.length });
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
// Routes — Company Registry
// ---------------------------------------------------------------------------

app.get("/api/companies", (req, res) => {
  const registry = loadCompaniesRegistry();
  const config = loadConfig();
  res.json({
    ...registry,
    discovery_min_confidence: config.discovery?.auto_add_min_confidence ?? 85,
  });
});

app.post("/api/companies", (req, res) => {
  const registry = loadCompaniesRegistry();
  const company = normalizeCompany(req.body ?? {});

  if (!company.ats_type || !company.ats_identifier) {
    return res.status(400).json({ error: "ats_type and ats_identifier are required" });
  }

  let idx = registry.companies.findIndex((item) => item.id === company.id);
  if (idx < 0) {
    idx = registry.companies.findIndex(
      (item) =>
        item.ats_type === company.ats_type &&
        item.ats_identifier.toLowerCase() === company.ats_identifier.toLowerCase()
    );
  }

  if (idx >= 0) {
    registry.companies[idx] = {
      ...registry.companies[idx],
      ...company,
      id: registry.companies[idx].id,
      added_at: registry.companies[idx].added_at,
    };
    company.id = registry.companies[idx].id;
  } else {
    registry.companies.push(company);
  }

  registry.companies.sort((a, b) => a.name.localeCompare(b.name));
  db.companies.saveRegistry(registry);
  res.json(registry.companies.find((item) => item.id === company.id) ?? company);
});

app.delete("/api/companies/:id", (req, res) => {
  const registry = loadCompaniesRegistry();
  const before = registry.companies.length;
  registry.companies = registry.companies.filter((item) => item.id !== req.params.id);
  if (registry.companies.length === before) {
    return res.status(404).json({ error: "Company not found" });
  }
  db.companies.saveRegistry(registry);
  res.json({ ok: true });
});

app.post("/api/companies/discover", async (req, res) => {
  const { url } = req.body ?? {};
  if (!url?.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const result = await detectAts(url.trim());
    if (result.error && !result.ats_type) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error("[/api/companies/discover]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/companies/import", (req, res) => {
  const incoming = req.body?.companies ?? req.body;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "Expected { companies: [...] }" });
  }

  const registry = loadCompaniesRegistry();
  registry.companies = mergeCompanies(registry.companies, incoming);
  db.companies.saveRegistry(registry);
  res.json({ imported: incoming.length, total: registry.companies.length, companies: registry.companies });
});

// ---------------------------------------------------------------------------
// Routes — Profile
// ---------------------------------------------------------------------------

app.get("/api/profile", (req, res) => {
  res.json(db.profile.get());
});

app.post("/api/profile", (req, res) => {
  const profile = req.body;
  db.profile.save(profile);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routes — AI resume parser
// ---------------------------------------------------------------------------

app.post("/api/ai/parse-resume", async (req, res) => {
  const { resume_text } = req.body ?? {};
  if (!resume_text?.trim()) {
    return res.status(400).json({ error: "resume_text is required" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OpenAI key not configured" });
  }

  try {
    const system = `You are a resume parser. Extract structured profile data from the resume text. Return a JSON object with exactly these keys:
{
  "name": string or null,
  "headline": string or null,
  "location": string or null,
  "email": string or null,
  "years_experience": number or null,
  "skills": [string],
  "certifications": [string],
  "education": string or null,
  "work_history": [{
    "title": string,
    "company": string,
    "years": number or null,
    "team_size": number or null,
    "sector": string or null
  }]
}
Rules:
- Extract only information explicitly present or clearly inferable from the resume.
- Use null for missing scalar fields and [] for missing arrays.
- headline should be the candidate's current or most recent professional title.
- years_experience is total professional years if stated or reasonably inferable.
- skills should include technical skills, tools, frameworks, leadership competencies, and domain expertise.
- work_history should be ordered most recent first.
- sector values should be short labels like tech, finance, automotive, healthcare, government, consulting.`;

    const user = `RESUME TEXT:\n${resume_text.slice(0, 12000)}`;
    const result = await aiJson(system, user);
    res.json(result);
  } catch (err) {
    console.error("[/api/ai/parse-resume]", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — AI match (Skill Graph)
// ---------------------------------------------------------------------------

app.post("/api/ai/match", async (req, res) => {
  const { job_id } = req.body;
  const job = db.jobs.getById(job_id);
  const profile = db.profile.get();
  if (!job || job.closed_at) return res.status(404).json({ error: "Job not found" });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OpenAI key not configured" });
  }

  try {
    const score = await scoreJobWithValidation(job, profile);
    db.jobs.updateAiScore(job.id, score);
    res.json(score);
  } catch (err) {
    console.error("[/api/ai/match]", err);
    const status = err.message.includes("validation failed") ? 422 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — Career Discovery (persisted)
// ---------------------------------------------------------------------------

app.get("/api/discover", (req, res) => {
  const saved = db.discover.get();
  if (!saved?.result) {
    return res.json({ result: null, analyzed_at: null });
  }
  res.json(saved);
});

app.post("/api/discover", (req, res) => {
  const { result, analyzed_at } = req.body ?? {};
  if (!result || typeof result !== "object") {
    return res.status(400).json({ error: "result is required" });
  }
  const saved = {
    result,
    analyzed_at: analyzed_at ?? new Date().toISOString(),
  };
  db.discover.save(saved);
  res.json(saved);
});

app.post("/api/ai/discover", async (req, res) => {
  const profile = db.profile.get();
  const jobs = db.jobs.getAll({ activeOnly: true });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OpenAI key not configured" });
  }

  const scoredJobs = jobs.filter((j) => j.ai_score);
  const adjacentTitles = scoredJobs.flatMap(
    (j) => j.ai_score?.adjacent_titles ?? []
  );
  const missingSkills = scoredJobs.flatMap(
    (j) => j.ai_score?.missing_skills ?? []
  );

  const sectorCounts = {};
  for (const job of jobs) {
    const sector = job.sector || "other";
    sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
  }
  const sampleTitles = [...new Set(jobs.map((j) => j.title).filter(Boolean))].slice(0, 80);
  const scoredSummaries = scoredJobs.slice(0, 25).map((j) => ({
    title: j.title,
    company: j.company,
    sector: j.sector,
    overall_score: j.ai_score?.overall_score ?? null,
    adjacent_titles: j.ai_score?.adjacent_titles ?? [],
    missing_skills: j.ai_score?.missing_skills ?? [],
  }));

  try {
    const system = `You are a career discovery engine. Given a candidate profile, job pool data, and optional scored job matches, return a JSON object with exactly these keys:
{
  "adjacent_roles": [{ "title": string, "frequency": number, "avg_fit": number, "description": string }],
  "top_skill_gaps": [{ "skill": string, "frequency": number, "impact": string }],
  "sector_heatmap": [{ "sector": string, "job_count": number, "avg_fit": number }],
  "career_insights": [<up to 5 plain-text insight strings about career opportunities>],
  "pivot_paths": [{ "from": string, "to": string, "skills_needed": [string], "difficulty": "Low"|"Medium"|"High" }]
}
Rules:
- Even when SCORED JOBS COUNT is 0, still infer adjacent_roles, top_skill_gaps, and pivot_paths from the profile, skills, work history, and sample job titles.
- Return at least 5 adjacent_roles and 3 top_skill_gaps when profile data is present.
- avg_fit should be an integer 0-100 estimate based on profile fit, not job_count.
- Use provided JOBS BY SECTOR counts for sector_heatmap job_count values.`;

    const user = `PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nJOB POOL TOTAL: ${jobs.length}\nJOBS BY SECTOR: ${JSON.stringify(sectorCounts)}\nSAMPLE JOB TITLES IN POOL:\n${sampleTitles.join("\n")}\n\nSCORED JOBS COUNT: ${scoredJobs.length}\nSCORED JOB DETAILS:\n${JSON.stringify(scoredSummaries, null, 2)}\nALL ADJACENT TITLES MENTIONED: ${[...new Set(adjacentTitles)].join(", ") || "(none)"}\nFREQUENT MISSING SKILLS: ${[...new Set(missingSkills)].join(", ") || "(none)"}`;

    const result = await aiJson(system, user);

    const aiHeatmap = result.sector_heatmap ?? [];
    result.sector_heatmap = Object.entries(sectorCounts)
      .map(([sector, job_count]) => {
        const aiEntry = aiHeatmap.find((s) => s.sector === sector);
        const sectorScored = scoredJobs.filter((j) => j.sector === sector);
        const avgFit = sectorScored.length
          ? Math.round(
              sectorScored.reduce((sum, j) => sum + (j.ai_score?.overall_score ?? 0), 0) /
                sectorScored.length
            )
          : (aiEntry?.avg_fit ?? null);
        return { sector, job_count, avg_fit: avgFit };
      })
      .filter((s) => s.job_count > 0)
      .sort((a, b) => b.job_count - a.job_count);

    const saved = { result, analyzed_at: new Date().toISOString() };
    db.discover.save(saved);
    res.json(saved);
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
  const profile = db.profile.get();
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OpenAI key not configured" });
  }

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
  const job = db.jobs.getById(job_id);
  const profile = db.profile.get();
  if (!job || job.closed_at) return res.status(404).json({ error: "Job not found" });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OpenAI key not configured" });
  }

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
