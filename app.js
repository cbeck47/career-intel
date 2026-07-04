/* ============================================================
   Career Intel — app.js
   All frontend logic. Talks to the local Express server at /api/*.
   ============================================================ */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE_KEY = "career_intel_v1";

function defaultState() {
  return {
    tracker: [],       // application records
    worth: null,       // cached worth result
  };
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) ?? defaultState();
  } catch {
    return defaultState();
  }
}

function saveState(s) {
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
}

async function migrateDiscoverFromLocalStorage() {
  if (discoverResult) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}");
    const legacy = parsed.discover;
    if (!legacy || typeof legacy !== "object") return;

    const saved = await POST("/api/discover", {
      result: legacy,
      analyzed_at: parsed.discover_analyzed_at ?? new Date().toISOString(),
    });
    discoverResult = saved.result ?? null;
    discoverAnalyzedAt = saved.analyzed_at ?? null;

    delete parsed.discover;
    delete parsed.discover_analyzed_at;
    localStorage.setItem(STATE_KEY, JSON.stringify(parsed));
    console.info("Migrated Career Discovery results from localStorage to server.");
  } catch (err) {
    console.warn("Discover migration failed:", err.message);
  }
}

let state = loadState();

// In-memory job + profile cache (loaded from server on boot)
let allJobs = [];
let profile = {};
let discoverResult = null;
let discoverAnalyzedAt = null;
let companiesRegistry = [];
let discoveryMinConfidence = 85;
let lastDiscoveryResult = null;
const charts = {};

// ---------------------------------------------------------------------------
// DOM shortcuts
// ---------------------------------------------------------------------------

function qs(sel, ctx = document) { return ctx.querySelector(sel); }
function qsa(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function setHidden(el, hidden) { el.classList.toggle("hidden", hidden); }
function fmtSalary(min, max) {
  if (!min && !max) return "—";
  const f = (n) => n ? "$" + Math.round(n / 1000) + "k" : "";
  if (min && max) return `${f(min)} – ${f(max)}`;
  return f(min) || f(max);
}
function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    const isHtml = /^\s*</.test(text);
    if (isHtml) {
      const cannotPost = text.match(/Cannot (GET|POST|PUT|DELETE) ([^<\s]+)/);
      if (cannotPost) {
        throw new Error(
          `API route not found (${cannotPost[0]}). Restart Career Intel with "npm start" so the server loads the latest routes.`
        );
      }
      throw new Error(
        `Server returned HTML instead of JSON for ${path}. Restart Career Intel with "npm start".`
      );
    }
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 80)}`);
  }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function GET(path) { return api("GET", path); }
function POST(path, body) { return api("POST", path, body); }
function DELETE(path) { return api("DELETE", path); }

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function showAlert(containerId, msg, type = "info", duration = 4000) {
  const el = qs(`#${containerId}`);
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  setHidden(el, false);
  if (duration) setTimeout(() => setHidden(el, true), duration);
}

// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------

function scoreClass(n) {
  if (n == null) return "";
  if (n >= 75) return "score-high";
  if (n >= 50) return "score-mid";
  return "score-low";
}
function sourceBadge(src) {
  return `<span class="source-badge src-${escHtml(src)}">${escHtml(src)}</span>`;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function activateTab(tabId) {
  qsa(".tabBtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  qsa(".tabPanel").forEach((p) => p.classList.toggle("visible", p.id === `tab-${tabId}`));
  if (tabId === "discover" && discoverResult) {
    requestAnimationFrame(() => drawCareerNetwork(discoverResult.adjacent_roles ?? []));
  }
  if (tabId === "packs") loadPacksList();
  if (tabId === "companies") loadVerificationQueue();
}

// ---------------------------------------------------------------------------
// PROFILE TAB
// ---------------------------------------------------------------------------

function loadProfileToForm(p) {
  qs("#profName").value = p.name ?? "";
  qs("#profHeadline").value = p.headline ?? "";
  qs("#profLocation").value = p.location ?? "";
  qs("#profEmail").value = p.email ?? "";
  qs("#profResume").value = p.resume_text ?? "";
  qs("#profCurrentBase").value = p.preferences?.current_comp?.base ?? "";
  qs("#profCurrentBonus").value = p.preferences?.current_comp?.bonus ?? "";
  qs("#prof401k").value = p.preferences?.current_comp?.match_401k ?? "";
  qs("#profTargetBase").value = p.preferences?.target_comp?.base ?? "";
  qs("#profTargetTitles").value = (p.preferences?.target_titles ?? []).join(", ");
  qs("#profTargetSectors").value = (p.preferences?.target_sectors ?? []).join(", ");
  qs("#profRemotePref").value = p.preferences?.remote ?? "hybrid";
  qs("#profYOE").value = p.years_experience ?? "";
  qs("#profCerts").value = (p.certifications ?? []).join(", ");
  qs("#profEducation").value = p.education ?? "";
  renderSkillTags(p.skills ?? []);
  renderWorkHistory(p.work_history ?? []);
}

function collectProfileFromForm() {
  return {
    name: qs("#profName").value.trim(),
    headline: qs("#profHeadline").value.trim(),
    location: qs("#profLocation").value.trim(),
    email: qs("#profEmail").value.trim(),
    resume_text: qs("#profResume").value.trim(),
    skills: collectSkillTags(),
    work_history: collectWorkHistory(),
    years_experience: parseFloat(qs("#profYOE").value) || null,
    certifications: qs("#profCerts").value.split(",").map((s) => s.trim()).filter(Boolean),
    education: qs("#profEducation").value.trim(),
    preferences: {
      current_comp: {
        base: parseFloat(qs("#profCurrentBase").value) || null,
        bonus: parseFloat(qs("#profCurrentBonus").value) || null,
        match_401k: parseFloat(qs("#prof401k").value) || null,
      },
      target_comp: {
        base: parseFloat(qs("#profTargetBase").value) || null,
      },
      target_titles: qs("#profTargetTitles").value.split(",").map((s) => s.trim()).filter(Boolean),
      target_sectors: qs("#profTargetSectors").value.split(",").map((s) => s.trim()).filter(Boolean),
      remote: qs("#profRemotePref").value,
    },
  };
}

// -- Skills tag manager
let skillTagsData = [];

function renderSkillTags(skills) {
  skillTagsData = [...skills];
  const wrap = qs("#skillTags");
  wrap.innerHTML = skillTagsData.map((s, i) =>
    `<span class="tag">${escHtml(s)}<span class="remove" data-idx="${i}">×</span></span>`
  ).join("");
  qsa(".tag .remove", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      skillTagsData.splice(parseInt(btn.dataset.idx), 1);
      renderSkillTags(skillTagsData);
    });
  });
}
function collectSkillTags() { return [...skillTagsData]; }

// -- Work history
let workHistoryData = [];

function renderWorkHistory(wh) {
  workHistoryData = [...wh];
  const wrap = qs("#workHistoryList");
  if (!workHistoryData.length) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:13px">No roles added yet.</p>`;
    return;
  }
  wrap.innerHTML = workHistoryData.map((w, i) => `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;background:var(--surface2);padding:10px;border-radius:7px;border:1px solid var(--border)">
      <div style="flex:1">
        <strong style="font-size:13px">${escHtml(w.title)}</strong>
        <span style="color:var(--muted);font-size:12px"> @ ${escHtml(w.company)}</span>
        <span style="color:var(--muted);font-size:11px;margin-left:8px">${escHtml(String(w.years ?? ""))}yr · ${escHtml(String(w.team_size ?? "?"))} reports · ${escHtml(w.sector ?? "")}</span>
      </div>
      <button class="btn btn-secondary btn-sm remove-work" data-idx="${i}">Remove</button>
    </div>
  `).join("");
  qsa(".remove-work", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      workHistoryData.splice(parseInt(btn.dataset.idx), 1);
      renderWorkHistory(workHistoryData);
    });
  });
}
function collectWorkHistory() { return [...workHistoryData]; }

function promptAddWork() {
  const title = prompt("Job title:");
  if (!title) return;
  const company = prompt("Company:") ?? "";
  const years = parseFloat(prompt("Years in this role:") ?? "0") || 0;
  const team = parseInt(prompt("Team size (direct reports):") ?? "0") || 0;
  const sector = prompt("Sector (tech / finance / automotive / etc.):") ?? "tech";
  workHistoryData.push({ title: title.trim(), company: company.trim(), years, team_size: team, sector: sector.trim() });
  renderWorkHistory(workHistoryData);
}

async function saveProfile() {
  profile = collectProfileFromForm();
  try {
    await POST("/api/profile", profile);
    showAlert("profileSaveAlert", "Profile saved.", "success");
  } catch (err) {
    showAlert("profileSaveAlert", `Error: ${err.message}`, "error");
  }
}

function hasValue(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function applyParsedProfileToForm(parsed) {
  if (hasValue(parsed.name)) qs("#profName").value = parsed.name.trim();
  if (hasValue(parsed.headline)) qs("#profHeadline").value = parsed.headline.trim();
  if (hasValue(parsed.location)) qs("#profLocation").value = parsed.location.trim();
  if (hasValue(parsed.email)) qs("#profEmail").value = parsed.email.trim();
  if (parsed.years_experience != null && !Number.isNaN(parsed.years_experience)) {
    qs("#profYOE").value = parsed.years_experience;
  }
  if (hasValue(parsed.certifications)) {
    qs("#profCerts").value = parsed.certifications.join(", ");
  }
  if (hasValue(parsed.education)) qs("#profEducation").value = parsed.education.trim();
  if (hasValue(parsed.skills)) renderSkillTags(parsed.skills);
  if (hasValue(parsed.work_history)) renderWorkHistory(parsed.work_history);
}

async function parseResume() {
  const resumeText = qs("#profResume").value.trim();
  if (!resumeText) {
    showAlert("profileSaveAlert", "Paste your resume text first.", "error");
    return;
  }

  const btn = qs("#btnExtractSkills");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Parsing…';

  try {
    const parsed = await POST("/api/ai/parse-resume", { resume_text: resumeText });
    applyParsedProfileToForm(parsed);

    const filled = [
      hasValue(parsed.name) && "name",
      hasValue(parsed.headline) && "headline",
      hasValue(parsed.location) && "location",
      hasValue(parsed.email) && "email",
      parsed.years_experience != null && "experience",
      hasValue(parsed.skills) && "skills",
      hasValue(parsed.certifications) && "certifications",
      hasValue(parsed.education) && "education",
      hasValue(parsed.work_history) && "work history",
    ].filter(Boolean);

    showAlert(
      "profileSaveAlert",
      `Resume parsed. Filled: ${filled.join(", ") || "no fields"}. Review and click Save Profile.`,
      "success",
      6000
    );
    btn.innerHTML = "&#10024; Parse Full Resume";
  } catch (err) {
    showAlert("profileSaveAlert", `Parse error: ${err.message}`, "error", 6000);
    btn.innerHTML = "&#10024; Parse Full Resume";
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// JOBS TAB
// ---------------------------------------------------------------------------

function jobLocationText(job) {
  return (job.location ?? "").toLowerCase();
}

function jobIsRemote(job) {
  return job.remote === true || jobLocationText(job).includes("remote");
}

function jobMatchesRemoteFilter(job, remoteFilter) {
  if (!remoteFilter) return true;
  if (remoteFilter === "remote") return jobIsRemote(job);
  if (remoteFilter === "onsite") return !jobIsRemote(job);
  return true;
}

function jobMatchesLocationFilter(job, query) {
  if (!query) return true;
  return jobLocationText(job).includes(query.toLowerCase());
}

function populateJobCompanyFilter() {
  const select = qs("#jobCompanyFilter");
  if (!select) return;
  const prev = select.value;
  const companies = [...new Set(allJobs.map((j) => j.company).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  select.innerHTML =
    '<option value="">All companies</option>' +
    companies.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("");
  if (prev && companies.includes(prev)) select.value = prev;
}

function filteredJobs() {
  const search = qs("#jobSearch").value.toLowerCase();
  const source = qs("#jobSourceFilter").value;
  const company = qs("#jobCompanyFilter").value;
  const sector = qs("#jobSectorFilter").value;
  const location = qs("#jobLocationFilter").value.trim();
  const remoteFilter = qs("#jobRemoteFilter").value;
  const sort = qs("#jobSortSelect").value;

  let jobs = allJobs.filter((j) => {
    if (source && j.source !== source) return false;
    if (company && j.company !== company) return false;
    if (sector && j.sector !== sector) return false;
    if (search && !`${j.title} ${j.company}`.toLowerCase().includes(search)) return false;
    if (!jobMatchesLocationFilter(j, location)) return false;
    if (!jobMatchesRemoteFilter(j, remoteFilter)) return false;
    return true;
  });

  if (sort === "heuristic") {
    jobs.sort((a, b) => (b.heuristic_score ?? -1) - (a.heuristic_score ?? -1));
  } else if (sort === "score") {
    jobs.sort((a, b) => (b.ai_score?.overall_score ?? -1) - (a.ai_score?.overall_score ?? -1));
  } else if (sort === "recent") {
    jobs.sort((a, b) => new Date(b.posted_at ?? 0) - new Date(a.posted_at ?? 0));
  } else if (sort === "salary") {
    jobs.sort((a, b) => (b.salary_max ?? 0) - (a.salary_max ?? 0));
  }
  return jobs;
}

function formatHeuristicBreakdown(components) {
  if (!components) return "";
  const pct = (value) => Math.round((value ?? 0) * 100);
  return [
    `Skills ${pct(components.skills)}%`,
    `Title ${pct(components.title)}%`,
    `Sector ${pct(components.sector)}%`,
    `Remote ${pct(components.remote)}%`,
    `Salary ${pct(components.salary)}%`,
    `Location ${pct(components.location)}%`,
  ].join(" · ");
}

function fitScorePill(job) {
  const aiScore = job.ai_score?.overall_score;
  if (aiScore != null) {
    return `<span class="score-pill ${scoreClass(aiScore)}">${aiScore}%</span>`;
  }
  if (job.heuristic_score != null) {
    const tip = formatHeuristicBreakdown(job.heuristic_components);
    const titleAttr = tip ? ` title="${escHtml(tip)}"` : "";
    return `<span class="score-pill score-heuristic score-heuristic-detail"${titleAttr}>${job.heuristic_score}%</span>`;
  }
  return `<button class="btn btn-secondary btn-sm score-job" data-id="${escHtml(job.id)}">Score</button>`;
}

function renderJobsTable() {
  const jobs = filteredJobs();
  const tbody = qs("#jobsTableBody");
  qs("#jobCount").textContent = `${jobs.length} jobs`;
  setHidden(qs("#jobsEmpty"), jobs.length > 0);

  if (!jobs.length) { tbody.innerHTML = ""; return; }

  tbody.innerHTML = jobs.map((j) => {
    const scorePill = fitScorePill(j);
    return `<tr>
      <td><a href="${escHtml(j.url)}" target="_blank">${escHtml(j.title)}</a></td>
      <td>${escHtml(j.company)}</td>
      <td>${escHtml(j.location)}${j.remote ? ' <span style="color:var(--green);font-size:11px">Remote</span>' : ""}</td>
      <td>${fmtSalary(j.salary_min, j.salary_max)}</td>
      <td>${sourceBadge(j.source)}</td>
      <td>${scorePill}</td>
      <td>
        <button class="btn btn-secondary btn-sm tailor-job" data-id="${escHtml(j.id)}" title="Tailor resume">&#9997;</button>
        <button class="btn btn-secondary btn-sm track-job" data-id="${escHtml(j.id)}" title="Add to tracker">+Track</button>
      </td>
    </tr>`;
  }).join("");

  qsa(".score-job", tbody).forEach((btn) => {
    btn.addEventListener("click", () => scoreJob(btn.dataset.id, btn));
  });
  qsa(".tailor-job", tbody).forEach((btn) => {
    btn.addEventListener("click", () => {
      qs("#tailorJobSelect").value = btn.dataset.id;
      activateTab("tailor");
    });
  });
  qsa(".track-job", tbody).forEach((btn) => {
    btn.addEventListener("click", () => addJobToTracker(btn.dataset.id));
  });
}

async function scoreJob(jobId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const score = await POST("/api/ai/match", { job_id: jobId });
    const job = allJobs.find((j) => j.id === jobId);
    if (job) job.ai_score = score;
    renderJobsTable();
    renderDashboard();
  } catch (err) {
    alert("Scoring error: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Score"; }
  }
}

async function rankAllJobs() {
  const btn = qs("#btnRank");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Ranking…';
  try {
    const res = await POST("/api/jobs/rank");
    allJobs = await GET("/api/jobs");
    qs("#jobSortSelect").value = "heuristic";
    renderJobsTable();
    renderDashboard();
    btn.innerHTML = `&#10003; Ranked (${res.ranked})`;
  } catch (err) {
    alert("Rank error: " + err.message);
    btn.innerHTML = "Rank Jobs";
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.innerHTML = "Rank Jobs"; }, 4000);
  }
}

async function deepScoreTop50() {
  if (!allJobs.some((j) => j.heuristic_score != null)) {
    alert("Rank jobs first to select top candidates for deep scoring.");
    return;
  }
  if (!confirm("Deep score will analyze up to 50 jobs via OpenAI (~2 min, small API cost). Continue?")) {
    return;
  }

  const btn = qs("#btnDeepScore");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scoring…';
  try {
    const res = await POST("/api/jobs/deep-score");
    allJobs = await GET("/api/jobs");
    populateJobCompanyFilter();
    renderJobsTable();
    renderDashboard();
    btn.innerHTML = `&#10003; Scored (${res.scored}/${res.total})`;
    if (res.errors) alert(`${res.errors} jobs failed to score.`);
  } catch (err) {
    alert("Deep score error: " + err.message);
    btn.innerHTML = "Deep Score Top 50";
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.innerHTML = "Deep Score Top 50"; }, 4000);
  }
}

async function syncJobs() {
  const btn = qs("#btnSync");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing…';
  try {
    const res = await POST("/api/jobs/sync");
    allJobs = await GET("/api/jobs");
    populateJobCompanyFilter();
    renderJobsTable();
    renderDashboard();
    populateTailorSelect();
    btn.innerHTML = `&#8635; Synced (${res.count})`;
  } catch (err) {
    alert("Sync error: " + err.message);
    btn.innerHTML = "&#8635; Sync Jobs";
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.innerHTML = "&#8635; Sync Jobs"; }, 4000);
  }
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------

function isFollowUpDue(followUp) {
  if (!followUp) return false;
  const d = new Date(followUp);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d <= today;
}

function buildDashboardActions() {
  const scored = allJobs.filter((j) => j.ai_score);
  const ranked = allJobs.filter((j) => j.heuristic_score != null);
  const actions = [];

  if (!profile.name?.trim() || !(profile.skills ?? []).length) {
    actions.push({ label: "Complete your profile — add name, skills, and resume", tab: "profile" });
  }
  if (!discoverResult) {
    actions.push({ label: "Run Career Discovery to find adjacent roles", tab: "discover" });
  }
  if (!companiesRegistry.length) {
    actions.push({ label: "Add companies to your registry", tab: "companies" });
  }
  if (allJobs.length === 0) {
    actions.push({ label: "Sync jobs from your configured sources", tab: "jobs" });
  } else if (ranked.length === 0) {
    actions.push({ label: "Rank jobs against your profile", action: "rank", tab: "jobs" });
  } else if (scored.length === 0) {
    actions.push({ label: "Deep score top 50 for AI fit analysis", action: "deep-score", tab: "jobs" });
  }

  state.tracker
    .filter((t) => isFollowUpDue(t.follow_up))
    .slice(0, 3)
    .forEach((t) => {
      actions.push({
        label: `Follow up on ${t.title} at ${t.company}`,
        tab: "tracker",
      });
    });

  return actions.slice(0, 5);
}

function renderDashboardActions() {
  const actions = buildDashboardActions();
  const wrap = qs("#dashActionList");
  if (!actions.length) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:13px">You're caught up — check back after syncing or scoring jobs.</p>`;
    return;
  }
  wrap.innerHTML = actions.map((a, i) =>
    `<div class="insight-item dash-action-item" data-action-idx="${i}">${escHtml(a.label)}</div>`
  ).join("");
  qsa(".dash-action-item", wrap).forEach((el) => {
    el.addEventListener("click", () => {
      const action = actions[parseInt(el.dataset.actionIdx, 10)];
      if (action?.action === "rank") {
        activateTab("jobs");
        rankAllJobs();
        return;
      }
      if (action?.action === "deep-score") {
        activateTab("jobs");
        deepScoreTop50();
        return;
      }
      if (action?.tab) activateTab(action.tab);
    });
  });
}

function buildDashboardOpportunities(scored) {
  const opportunities = [];
  const minHeuristic = 30;
  const topScored = [...scored]
    .sort((a, b) => (b.ai_score?.overall_score ?? 0) - (a.ai_score?.overall_score ?? 0))
    .slice(0, 5);

  topScored.forEach((j) => {
    opportunities.push({
      source: "scored",
      title: j.title,
      subtitle: `${j.company} · ${j.source}`,
      score: j.ai_score?.overall_score,
      url: j.url,
    });
  });

  if (opportunities.length < 5) {
    const topHeuristic = [...allJobs]
      .filter((j) => !j.ai_score && (j.heuristic_score ?? 0) >= minHeuristic)
      .sort((a, b) => (b.heuristic_score ?? 0) - (a.heuristic_score ?? 0))
      .slice(0, 5 - opportunities.length);

    topHeuristic.forEach((j) => {
      opportunities.push({
        source: "heuristic",
        title: j.title,
        subtitle: `${j.company} · ${j.source}`,
        score: j.heuristic_score,
        url: j.url,
      });
    });
  }

  if (opportunities.length < 5 && discoverResult?.adjacent_roles?.length) {
    const used = new Set(opportunities.map((o) => o.title.toLowerCase()));
    const adjacent = [...discoverResult.adjacent_roles]
      .sort((a, b) => (b.avg_fit ?? 0) - (a.avg_fit ?? 0));
    for (const role of adjacent) {
      if (opportunities.length >= 5) break;
      if (used.has(role.title.toLowerCase())) continue;
      opportunities.push({
        source: "discover",
        title: role.title,
        subtitle: role.description ?? "Adjacent role from Career Discovery",
        score: role.avg_fit,
        tab: "discover",
      });
      used.add(role.title.toLowerCase());
    }
  }

  return opportunities;
}

function renderDashboard() {
  const scored = allJobs.filter((j) => j.ai_score);
  const ranked = allJobs.filter((j) => j.heuristic_score != null);
  const topScoredFit = scored.length
    ? Math.max(...scored.map((j) => j.ai_score?.overall_score ?? 0))
    : 0;
  const topHeuristicFit = ranked.length
    ? Math.max(...ranked.map((j) => j.heuristic_score ?? 0))
    : 0;
  const topDiscoverFit = discoverResult?.adjacent_roles?.length
    ? Math.max(...discoverResult.adjacent_roles.map((r) => r.avg_fit ?? 0))
    : 0;
  const bestMatch = topScoredFit || topHeuristicFit || topDiscoverFit;
  const interviewing = state.tracker.filter((t) => ["Phone Screen", "Interview"].includes(t.status)).length;
  const unscored = allJobs.length - scored.length;
  const discoverStatus = discoverAnalyzedAt
    ? new Date(discoverAnalyzedAt).toLocaleDateString()
    : "Not run";

  const kpis = [
    { v: allJobs.length, l: "Total Jobs" },
    { v: scored.length, l: "Jobs Scored" },
    { v: unscored, l: "Unscored" },
    { v: bestMatch ? bestMatch + "%" : "—", l: "Best Match" },
    { v: state.tracker.length, l: "Applications" },
    { v: interviewing, l: "Interviewing" },
    { v: discoverStatus, l: "Discover" },
  ];

  if (state.worth?.market_value?.expected) {
    kpis.push({
      v: "$" + Math.round(state.worth.market_value.expected / 1000) + "k",
      l: "Est. Worth",
    });
  }

  qs("#dashKpis").innerHTML = kpis
    .map((k) => `<div class="kpi"><div class="kpi-value">${escHtml(String(k.v))}</div><div class="kpi-label">${escHtml(k.l)}</div></div>`)
    .join("");

  const opportunities = buildDashboardOpportunities(scored);
  if (opportunities.length) {
    qs("#dashTopJobs").innerHTML = opportunities.map((o) => {
      const badge = o.source === "discover"
        ? `<span class="dash-source-badge dash-source-discover">Discover</span>`
        : o.source === "heuristic"
          ? `<span class="dash-source-badge dash-source-heuristic">Ranked</span>`
          : `<span class="dash-source-badge dash-source-scored">Scored</span>`;
      const pillClass = o.source === "heuristic" ? "score-heuristic" : scoreClass(o.score);
      const titleHtml = o.url
        ? `<a href="${escHtml(o.url)}" target="_blank" style="color:var(--text);font-weight:600;font-size:13px">${escHtml(o.title)}</a>${badge}`
        : `<span class="dash-opportunity-link" data-tab="${escHtml(o.tab ?? "discover")}" style="color:var(--text);font-weight:600;font-size:13px;cursor:pointer">${escHtml(o.title)}</span>${badge}`;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            ${titleHtml}
            <div style="font-size:11px;color:var(--muted)">${escHtml(o.subtitle)}</div>
          </div>
          <span class="score-pill ${pillClass}">${o.score ?? "—"}%</span>
        </div>`;
    }).join("");
    qsa(".dash-opportunity-link", qs("#dashTopJobs")).forEach((el) => {
      el.addEventListener("click", () => activateTab(el.dataset.tab));
    });
  } else {
    const cta = !discoverResult
      ? "Run Analyze on the Discover tab to find adjacent roles."
      : allJobs.length
        ? allJobs.some((j) => j.heuristic_score != null)
          ? "Deep score top matches for AI fit analysis."
          : "Rank jobs to surface your best local matches."
        : "Sync jobs to build your opportunity pool.";
    qs("#dashTopJobs").innerHTML = `<p style="color:var(--muted);font-size:13px">${escHtml(cta)}</p>`;
  }

  const allMissing = scored.flatMap((j) => j.ai_score?.missing_skills ?? []);
  const freq = {};
  allMissing.forEach((s) => { freq[s] = (freq[s] ?? 0) + 1; });
  let skillGapEntries = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!skillGapEntries.length && discoverResult?.top_skill_gaps?.length) {
    skillGapEntries = discoverResult.top_skill_gaps
      .slice(0, 8)
      .map((g) => [g.skill, g.frequency ?? 1]);
  }

  destroyChart("skillGap");
  const skillCanvas = qs("#skillGapChart");
  const skillEmpty = qs("#skillGapEmpty");
  if (skillGapEntries.length) {
    setHidden(skillCanvas, false);
    setHidden(skillEmpty, true);
    charts.skillGap = new Chart(skillCanvas, {
      type: "bar",
      data: {
        labels: skillGapEntries.map(([s]) => s),
        datasets: [{ data: skillGapEntries.map(([, c]) => c), backgroundColor: "#6c8cff88", borderColor: "#6c8cff", borderWidth: 1 }],
      },
      options: {
        indexAxis: "y",
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" } },
          y: { ticks: { color: "#e2e8f0", font: { size: 11 } }, grid: { color: "#2e3154" } },
        },
      },
    });
  } else {
    setHidden(skillCanvas, true);
    setHidden(skillEmpty, false);
    skillEmpty.textContent = discoverResult
      ? "No skill gaps identified yet."
      : "Run Discover Analyze to identify skill gaps.";
  }

  renderDashboardActions();

  const scoredInsights = scored.flatMap((j) => {
    const r = [];
    if ((j.ai_score?.overall_score ?? 0) >= 85) {
      r.push(`Strong match (${j.ai_score.overall_score}%) for ${j.title} at ${j.company}.`);
    }
    if (j.ai_score?.missing_skills?.length) {
      r.push(`Learning ${j.ai_score.missing_skills[0]} could improve your fit for ${j.title}.`);
    }
    return r;
  });
  const insights = [
    ...(discoverResult?.career_insights ?? []).slice(0, 3),
    ...scoredInsights.slice(0, 2),
  ].slice(0, 5);

  qs("#dashInsights").innerHTML = insights.length
    ? insights.map((i) => `<div class="insight-item">${escHtml(i)}</div>`).join("")
    : `<p style="color:var(--muted);font-size:13px">Run Discover Analyze, rank jobs, or deep score top matches to generate insights.</p>`;
}

// ---------------------------------------------------------------------------
// DISCOVER TAB
// ---------------------------------------------------------------------------

async function runDiscover() {
  const btn = qs("#btnDiscover");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  try {
    const saved = await POST("/api/ai/discover");
    discoverResult = saved.result ?? null;
    discoverAnalyzedAt = saved.analyzed_at ?? null;
    renderDiscoverTab(discoverResult);
    renderDashboard();
  } catch (err) {
    alert("Discovery error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#10024; Analyze";
  }
}

function renderDiscoverTab(d) {
  const analyzedEl = qs("#discoverAnalyzedAt");
  if (analyzedEl) {
    analyzedEl.textContent = discoverAnalyzedAt
      ? `Last analyzed: ${new Date(discoverAnalyzedAt).toLocaleString()}`
      : "";
  }

  if (!d) {
    qs("#discoverKpis").innerHTML = "";
    qs("#adjacentRolesList").innerHTML = `<p style="color:var(--muted);font-size:13px">Click "Analyze" to discover career opportunities.</p>`;
    return;
  }

  // KPIs
  qs("#discoverKpis").innerHTML = [
    { v: (d.adjacent_roles ?? []).length, l: "Adjacent Roles" },
    { v: (d.top_skill_gaps ?? []).length, l: "Skill Gaps" },
    { v: (d.pivot_paths ?? []).length, l: "Pivot Paths" },
    { v: (d.sector_heatmap ?? []).length, l: "Sectors Analyzed" },
  ].map((k) => `<div class="kpi"><div class="kpi-value">${k.v}</div><div class="kpi-label">${k.l}</div></div>`).join("");

  // Adjacent roles
  qs("#adjacentRolesList").innerHTML = (d.adjacent_roles ?? []).map((r) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600;font-size:13px">${escHtml(r.title)}</div>
        <div style="font-size:11px;color:var(--muted)">${escHtml(r.description ?? "")}</div>
      </div>
      <span class="score-pill ${scoreClass(r.avg_fit)}">${r.avg_fit ?? "—"}%</span>
    </div>`).join("") || `<p style="color:var(--muted);font-size:13px">No data yet.</p>`;

  // Sector heatmap
  destroyChart("sector");
  const hm = d.sector_heatmap ?? [];
  if (hm.length) {
    try {
      charts.sector = new Chart(qs("#sectorChart"), {
        type: "bar",
        data: {
          labels: hm.map((s) => s.sector),
          datasets: [{
            label: "Jobs in pool",
            data: hm.map((s) => s.job_count),
            backgroundColor: "#a78bfa88",
            borderColor: "#a78bfa",
            borderWidth: 1,
          }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" } },
            y: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" }, beginAtZero: true },
          },
        },
      });
    } catch (chartErr) {
      console.warn("Sector chart render failed:", chartErr.message);
    }
  }

  // Career network canvas — defer until layout is ready
  requestAnimationFrame(() => drawCareerNetwork(d.adjacent_roles ?? []));

  // Skill gaps
  const gaps = d.top_skill_gaps ?? [];
  qs("#skillGapList").innerHTML = gaps.map((g) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600;font-size:13px">${escHtml(g.skill)}</div>
        <div style="font-size:11px;color:var(--muted)">${escHtml(g.impact ?? "")}</div>
      </div>
      <span style="font-size:11px;background:var(--surface);border:1px solid var(--border);padding:2px 8px;border-radius:4px">${g.frequency}×</span>
    </div>`).join("") || `<p style="color:var(--muted);font-size:13px">No gaps identified.</p>`;

  // Populate what-if select
  const sel = qs("#whatIfSkill");
  sel.innerHTML = `<option value="">What if I learn…</option>` +
    gaps.map((g) => `<option value="${escHtml(g.skill)}">${escHtml(g.skill)}</option>`).join("");

  // Pivot paths
  qs("#pivotPathsList").innerHTML = (d.pivot_paths ?? []).map((p) => `
    <div style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:13px;font-weight:600">${escHtml(p.from)} → ${escHtml(p.to)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">
        Difficulty: <span style="color:${p.difficulty === 'Low' ? 'var(--green)' : p.difficulty === 'High' ? 'var(--red)' : 'var(--yellow)'}">${escHtml(p.difficulty)}</span>
        · Skills needed: ${(p.skills_needed ?? []).join(", ")}
      </div>
    </div>`).join("") || `<p style="color:var(--muted);font-size:13px">No pivot paths identified.</p>`;

  // Insights
  qs("#discoverInsights").innerHTML = (d.career_insights ?? []).map((i) =>
    `<div class="insight-item">${escHtml(i)}</div>`
  ).join("") || `<p style="color:var(--muted);font-size:13px">No insights yet.</p>`;
}

function setupDiscoveryCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(Math.round(rect.width || canvas.clientWidth || 700), 320);
  const H = Math.max(Math.round(rect.height || canvas.clientHeight || 420), 280);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

function wrapCanvasLabel(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 3 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    if (words.join(" ").length > lines.join(" ").length) {
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines;
}

function drawCareerNetwork(adjacentRoles) {
  const canvas = qs("#discoveryCanvas");
  if (!canvas) return;
  const { ctx, W, H } = setupDiscoveryCanvas(canvas);
  ctx.clearRect(0, 0, W, H);

  if (!adjacentRoles.length) {
    ctx.fillStyle = "#8892b0";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      discoverResult ? "No adjacent roles identified yet — score jobs for richer results" : "Run Analyze to see your career network",
      W / 2,
      H / 2
    );
    return;
  }

  const padX = 90;
  const padTop = 50;
  const padBottom = 70;
  const cx = W / 2;
  const cy = padTop + (H - padTop - padBottom) / 2;
  const R = Math.min(W - padX * 2, H - padTop - padBottom) * 0.34;
  const count = Math.min(adjacentRoles.length, 8);

  const nodes = [
    { label: profile.headline || "Your Role", x: cx, y: cy, r: 28, isCenter: true, fit: 100 },
    ...adjacentRoles.slice(0, count).map((role, i) => {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const fit = role.avg_fit ?? 70;
      const dist = R * (0.85 + (100 - fit) / 400);
      return {
        label: role.title,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        r: 10 + (fit / 100) * 12,
        isCenter: false,
        fit,
      };
    }),
  ];

  nodes.slice(1).forEach((n) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(n.x, n.y);
    ctx.strokeStyle = "#2e3154";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  nodes.forEach((n) => {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = n.isCenter ? "#6c8cff" : n.fit >= 75 ? "#34d399" : n.fit >= 50 ? "#fbbf24" : "#f87171";
    ctx.fill();
    ctx.strokeStyle = "#1a1d2e";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    if (!n.isCenter) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`${n.fit}%`, n.x, n.y + 4);
    }

    ctx.fillStyle = "#e2e8f0";
    ctx.font = `${n.isCenter ? "bold " : ""}11px sans-serif`;
    const labelWidth = n.isCenter ? 160 : 120;
    const lines = wrapCanvasLabel(ctx, n.label, labelWidth, n.isCenter ? 3 : 2);
    const lineHeight = 13;
    const labelStartY = n.y + n.r + 14;
    lines.forEach((line, wi) => {
      ctx.fillText(line, n.x, labelStartY + wi * lineHeight);
    });
  });
}

// ---------------------------------------------------------------------------
// WHAT'S MY WORTH
// ---------------------------------------------------------------------------

let worthScenarios = [];

function renderWorthScenarios() {
  const wrap = qs("#worthScenarioList");
  wrap.innerHTML = worthScenarios.map((s, i) => `
    <div style="display:flex;gap:8px;align-items:center">
      <input type="text" value="${escHtml(s)}" data-idx="${i}" class="scenario-input" placeholder="e.g. Move to Chicago, Learn Kubernetes…" style="flex:1" />
      <button class="btn btn-secondary btn-sm remove-scenario" data-idx="${i}">✕</button>
    </div>`).join("");
  qsa(".remove-scenario", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      worthScenarios.splice(parseInt(btn.dataset.idx), 1);
      renderWorthScenarios();
    });
  });
  qsa(".scenario-input", wrap).forEach((inp) => {
    inp.addEventListener("change", () => {
      worthScenarios[parseInt(inp.dataset.idx)] = inp.value;
    });
  });
}

async function analyzeWorth() {
  const btn = qs("#btnAnalyzeWorth");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  try {
    // Collect any edits to scenario inputs
    qsa(".scenario-input").forEach((inp) => {
      worthScenarios[parseInt(inp.dataset.idx)] = inp.value;
    });
    const result = await POST("/api/ai/worth", {
      market_context: qs("#marketContext").value.trim(),
      scenarios: worthScenarios.filter(Boolean),
    });
    state.worth = result;
    saveState(state);
    renderWorthResults(result);
  } catch (err) {
    alert("Worth analysis error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#128200; Analyze";
  }
}

function renderWorthResults(d) {
  setHidden(qs("#worthResults"), false);

  qs("#worthSummaryText").textContent = d.summary ?? "";

  // Bands
  const mv = d.market_value ?? {};
  qs("#worthBands").innerHTML = [
    { label: "Conservative", key: "conservative", cls: "band-conservative" },
    { label: "Expected",     key: "expected",     cls: "band-expected" },
    { label: "Competitive",  key: "competitive",  cls: "band-competitive" },
    { label: "Exceptional",  key: "exceptional",  cls: "band-exceptional" },
  ].map((b) => `
    <div class="worth-band">
      <div class="worth-band-label">${b.label}</div>
      <div class="worth-band-value ${b.cls}">${mv[b.key] ? "$" + Math.round(mv[b.key] / 1000) + "k" : "—"}</div>
    </div>`).join("");

  // Percentile
  const pct = d.current_percentile ?? 0;
  qs("#worthPercentileBar").style.width = pct + "%";
  qs("#worthPercentileLabel").textContent = pct + "th percentile";
  const underpaid = d.underpaid;
  const badge = qs("#worthUnderpaidBadge");
  badge.textContent = underpaid ? "Underpaid" : "Market Rate";
  badge.className = `score-pill ${underpaid ? "score-low" : "score-high"}`;

  // Skills
  qs("#worthSkills").innerHTML = (d.top_skills_in_demand ?? []).map((s) =>
    `<span class="tag">${escHtml(s)}</span>`).join("");

  // Sector premium chart
  destroyChart("sectorPremium");
  const premiums = d.sector_premiums ?? [];
  if (premiums.length) {
    charts.sectorPremium = new Chart(qs("#sectorPremiumChart"), {
      type: "bar",
      data: {
        labels: premiums.map((p) => p.sector),
        datasets: [{ label: "Premium %", data: premiums.map((p) => p.premium_pct), backgroundColor: "#34d39966", borderColor: "#34d399", borderWidth: 1 }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" } },
          y: { ticks: { color: "#8892b0", callback: (v) => v + "%" }, grid: { color: "#2e3154" } },
        },
      },
    });
  }

  // Scenario deltas
  qs("#worthScenarioResults").innerHTML = (d.scenarios ?? []).map((s) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--surface2);border-radius:7px;margin-bottom:6px">
      <span style="font-size:13px;font-weight:600">${escHtml(s.label)}</span>
      <div style="display:flex;gap:12px;align-items:center">
        <span style="font-size:12px;color:var(--muted)">${escHtml(s.explanation ?? "")}</span>
        <span class="score-pill ${s.delta_pct > 0 ? "score-high" : "score-low"}">${s.delta_pct > 0 ? "+" : ""}${s.delta_pct}%</span>
      </div>
    </div>`).join("") || `<p style="color:var(--muted);font-size:13px">No scenarios provided.</p>`;

  // Career ROI table
  qs("#careerRoiTable").innerHTML = (d.career_roi ?? []).map((r) => `
    <tr>
      <td>${escHtml(r.action)}</td>
      <td>${escHtml(r.cost_estimate)}</td>
      <td>${escHtml(r.time_estimate)}</td>
      <td style="color:var(--green);font-weight:600">+$${Math.round((r.salary_increase ?? 0) / 1000)}k/yr</td>
      <td>${escHtml(r.payback_period)}</td>
    </tr>`).join("");
}

// ---------------------------------------------------------------------------
// RESUME TAILOR
// ---------------------------------------------------------------------------

function populateTailorSelect() {
  const sel = qs("#tailorJobSelect");
  const cur = sel.value;
  sel.innerHTML = `<option value="">— choose a job —</option>` +
    allJobs.map((j) => `<option value="${escHtml(j.id)}">${escHtml(j.title)} — ${escHtml(j.company)}</option>`).join("");
  if (cur) sel.value = cur;
}

async function tailorResume() {
  const jobId = qs("#tailorJobSelect").value;
  if (!jobId) { alert("Select a job first."); return; }
  const btn = qs("#btnTailorResume");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Tailoring…';
  try {
    const result = await POST("/api/ai/resume", { job_id: jobId });
    renderTailorResults(result);
  } catch (err) {
    alert("Tailoring error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#9997; Tailor Resume";
  }
}

function renderTailorResults(r) {
  setHidden(qs("#tailorResults"), false);

  qs("#tailorOriginalSummary").textContent = profile.headline ?? "(No headline in profile)";
  qs("#tailorNewSummary").textContent = r.tailored_summary ?? "";

  // Bullets by company/role
  qs("#tailorBullets").innerHTML = (r.tailored_bullets ?? []).map((b) => `
    <div style="margin-bottom:14px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">${escHtml(b.title)} @ ${escHtml(b.company)}</div>
      <ul style="padding-left:18px">
        ${(b.bullets ?? []).map((x) => `<li style="font-size:13px;line-height:1.6;margin-bottom:4px">${escHtml(x)}</li>`).join("")}
      </ul>
    </div>`).join("");

  // Keywords
  qs("#tailorKeywords").innerHTML = (r.keywords_added ?? []).map((k) =>
    `<span class="tag" style="border-color:var(--accent);color:var(--accent)">${escHtml(k)}</span>`).join("");

  // Cover letter
  qs("#tailorCoverLetter").textContent = r.cover_letter ?? "";

  // Tips
  qs("#tailorTips").innerHTML = (r.tips ?? []).map((t) => `<div class="insight-item">${escHtml(t)}</div>`).join("");

  // Copy buttons
  qs("#btnCopySummary").onclick = () => navigator.clipboard.writeText(r.tailored_summary ?? "");
  qs("#btnCopyBullets").onclick = () => {
    const text = (r.tailored_bullets ?? []).map((b) =>
      `${b.title} @ ${b.company}\n` + b.bullets.map((x) => `• ${x}`).join("\n")
    ).join("\n\n");
    navigator.clipboard.writeText(text);
  };
  qs("#btnCopyCover").onclick = () => navigator.clipboard.writeText(r.cover_letter ?? "");
}

// ---------------------------------------------------------------------------
// APPLICATION TRACKER
// ---------------------------------------------------------------------------

const STATUSES = ["Saved", "Applied", "Phone Screen", "Interview", "Offer", "Rejected", "Withdrawn"];

function addJobToTracker(jobId) {
  const job = allJobs.find((j) => j.id === jobId);
  if (!job) return;
  const existing = state.tracker.find((t) => t.job_id === jobId);
  if (existing) { activateTab("tracker"); return; }
  state.tracker.push({
    id: uid(),
    job_id: jobId,
    title: job.title,
    company: job.company,
    url: job.url,
    status: "Saved",
    notes: "",
    follow_up: null,
    added_at: new Date().toISOString(),
  });
  saveState(state);
  renderTracker();
  activateTab("tracker");
}

let editingAppId = null;

function openAppModal(appId = null) {
  editingAppId = appId;
  const app = appId ? state.tracker.find((t) => t.id === appId) : null;
  qs("#appModalTitle").textContent = appId ? "Edit Application" : "Add Application";
  qs("#appTitle").value    = app?.title   ?? "";
  qs("#appCompany").value  = app?.company ?? "";
  qs("#appStatus").value   = app?.status  ?? "Saved";
  qs("#appFollowup").value = app?.follow_up ?? "";
  qs("#appUrl").value      = app?.url     ?? "";
  qs("#appNotes").value    = app?.notes   ?? "";
  setHidden(qs("#appModal"), false);
}

function closeAppModal() { setHidden(qs("#appModal"), true); editingAppId = null; }

function saveApp() {
  const data = {
    title:    qs("#appTitle").value.trim(),
    company:  qs("#appCompany").value.trim(),
    status:   qs("#appStatus").value,
    follow_up: qs("#appFollowup").value.trim() || null,
    url:      qs("#appUrl").value.trim(),
    notes:    qs("#appNotes").value.trim(),
  };
  if (!data.title) { alert("Job title is required."); return; }
  if (editingAppId) {
    const idx = state.tracker.findIndex((t) => t.id === editingAppId);
    if (idx >= 0) state.tracker[idx] = { ...state.tracker[idx], ...data };
  } else {
    state.tracker.push({ id: uid(), job_id: null, added_at: new Date().toISOString(), ...data });
  }
  saveState(state);
  closeAppModal();
  renderTracker();
  renderDashboard();
}

function renderTracker() {
  const tracker = state.tracker;

  // KPIs
  const applied = tracker.filter((t) => !["Saved","Withdrawn"].includes(t.status)).length;
  const responses = tracker.filter((t) => ["Phone Screen","Interview","Offer","Rejected"].includes(t.status)).length;
  const responseRate = applied ? Math.round((responses / applied) * 100) : 0;
  const offers = tracker.filter((t) => t.status === "Offer").length;

  qs("#trackerKpis").innerHTML = [
    { v: tracker.length, l: "Total" },
    { v: applied,        l: "Applied" },
    { v: responseRate + "%", l: "Response Rate" },
    { v: tracker.filter((t) => t.status === "Interview").length, l: "Interviews" },
    { v: offers,         l: "Offers" },
  ].map((k) => `<div class="kpi"><div class="kpi-value">${k.v}</div><div class="kpi-label">${k.l}</div></div>`).join("");

  // Funnel chart
  destroyChart("trackerFunnel");
  const counts = STATUSES.slice(0, 6).map((s) => tracker.filter((t) => t.status === s).length);
  charts.trackerFunnel = new Chart(qs("#trackerFunnelChart"), {
    type: "bar",
    data: {
      labels: STATUSES.slice(0, 6),
      datasets: [{ data: counts, backgroundColor: ["#6c8cff88","#6c8cff","#a78bfa","#34d399","#fbbf24","#f87171"], borderWidth: 0 }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" } },
        y: { ticks: { color: "#8892b0", stepSize: 1 }, grid: { color: "#2e3154" } },
      },
    },
  });

  // Kanban
  const kanban = qs("#trackerKanban");
  kanban.innerHTML = STATUSES.map((status) => {
    const apps = tracker.filter((t) => t.status === status);
    return `
      <div class="kanban-col">
        <div class="kanban-col-title">
          ${escHtml(status)}
          <span style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1px 7px;font-size:11px">${apps.length}</span>
        </div>
        ${apps.map((a) => `
          <div class="kanban-card" data-id="${escHtml(a.id)}">
            <div class="kanban-card-title">${escHtml(a.title)}</div>
            <div class="kanban-card-sub">${escHtml(a.company)}</div>
            ${a.follow_up ? `<div class="kanban-card-sub" style="margin-top:4px;color:var(--yellow)">Follow up: ${escHtml(a.follow_up)}</div>` : ""}
          </div>`).join("")}
      </div>`;
  }).join("");

  qsa(".kanban-card", kanban).forEach((card) => {
    card.addEventListener("click", () => openAppModal(card.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// COMPANIES TAB
// ---------------------------------------------------------------------------

function filteredCompanies() {
  const ats = qs("#companyAtsFilter")?.value ?? "";
  const preferredOnly = qs("#companyPreferredFilter")?.checked ?? false;

  return companiesRegistry.filter((company) => {
    if (ats && company.ats_type !== ats) return false;
    if (preferredOnly && !company.preferred) return false;
    return true;
  });
}

function confidenceClass(score) {
  if (score == null) return "";
  if (score >= 85) return "score-high";
  if (score >= 60) return "score-mid";
  return "score-low";
}

function formatSourceSummary(sources) {
  if (!sources?.length) return "—";
  const counts = {};
  for (const source of sources) {
    counts[source.ats_type] = (counts[source.ats_type] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

function formatSourceIdentifiers(sources) {
  return sources?.map((source) => source.ats_identifier).filter(Boolean).join(", ") || "—";
}

function canAddDiscoveryResult(item) {
  return Boolean(item.registry_entry?.sources?.length);
}

function renderDiscoveryEvidence(evidence) {
  if (!evidence) return "<p style='color:var(--muted)'>No evidence captured.</p>";
  const lines = [
    evidence.final_url ? `<div><strong>Final URL:</strong> ${escHtml(evidence.final_url)}</div>` : "",
    evidence.page_title ? `<div><strong>Page title:</strong> ${escHtml(evidence.page_title)}</div>` : "",
    evidence.candidate_careers_links?.length
      ? `<div><strong>Candidate links:</strong><ul style='margin:4px 0 0 16px'>${evidence.candidate_careers_links.map((url) => `<li>${escHtml(url)}</li>`).join("")}</ul></div>`
      : "",
    evidence.candidate_identifiers?.length
      ? `<div><strong>Identifiers:</strong> ${escHtml(evidence.candidate_identifiers.join(", "))}</div>`
      : "",
    evidence.conflicting_signals?.length
      ? `<div><strong>Signals:</strong> ${escHtml(evidence.conflicting_signals.join("; "))}</div>`
      : "",
    evidence.ai_error ? `<div style='color:var(--yellow)'><strong>AI:</strong> ${escHtml(evidence.ai_error)}</div>` : "",
  ].filter(Boolean);
  return lines.join("") || "<p style='color:var(--muted)'>No evidence captured.</p>";
}

function verificationBadge(status, lastVerified) {
  const label = status ?? "unknown";
  const tip = lastVerified
    ? `Last verified: ${new Date(lastVerified).toLocaleString()}`
    : "Not verified yet";
  return `<span class="verify-badge verify-${escHtml(label)}" title="${escHtml(tip)}">${escHtml(label.replace("_", " "))}</span>`;
}

function renderCompaniesTable() {
  const companies = filteredCompanies();
  const tbody = qs("#companiesTableBody");
  const countEl = qs("#companyCount");
  if (countEl) countEl.textContent = `${companies.length} of ${companiesRegistry.length} companies`;
  setHidden(qs("#companiesEmpty"), companies.length > 0);

  if (!companies.length) {
    tbody.innerHTML = "";
    return;
  }

  tbody.innerHTML = companies.map((company) => {
    const verified = company.last_verified
      ? new Date(company.last_verified).toLocaleDateString()
      : "—";
    const confidence = company.discovery_confidence;
    const sourceCount = company.sources?.length ?? 0;
    return `<tr data-id="${escHtml(company.id)}">
      <td>
        <div>${escHtml(company.name)}</div>
        ${company.application_url ? `<div style="font-size:11px;color:var(--muted)">${escHtml(company.application_url)}</div>` : ""}
        ${company.platform ? `<div style="font-size:11px;color:var(--muted)">${escHtml(company.platform)}</div>` : ""}
        ${sourceCount > 1 ? `<div style="font-size:11px;color:var(--accent)">${sourceCount} job sources</div>` : ""}
      </td>
      <td>${sourceBadge(company.ats_type)}</td>
      <td><code style="font-size:11px">${escHtml(company.ats_identifier)}</code></td>
      <td><input type="checkbox" class="company-preferred" data-id="${escHtml(company.id)}" ${company.preferred ? "checked" : ""} /></td>
      <td><input type="checkbox" class="company-enabled" data-id="${escHtml(company.id)}" ${company.enabled ? "checked" : ""} /></td>
      <td>${verificationBadge(company.verification_status, company.last_verified)}</td>
      <td>${confidence != null ? `<span class="score-pill ${confidenceClass(confidence)}">${confidence}%</span>` : "—"}</td>
      <td style="font-size:12px;color:var(--muted)">${escHtml(verified)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary btn-sm company-verify" data-id="${escHtml(company.id)}" title="Re-verify">&#8635;</button>
        <button class="btn btn-secondary btn-sm company-delete" data-id="${escHtml(company.id)}">Delete</button>
      </td>
    </tr>`;
  }).join("");

  qsa(".company-preferred", tbody).forEach((el) => {
    el.addEventListener("change", () => toggleCompanyField(el.dataset.id, "preferred", el.checked));
  });
  qsa(".company-enabled", tbody).forEach((el) => {
    el.addEventListener("change", () => toggleCompanyField(el.dataset.id, "enabled", el.checked));
  });
  qsa(".company-delete", tbody).forEach((el) => {
    el.addEventListener("click", () => deleteCompany(el.dataset.id));
  });
  qsa(".company-verify", tbody).forEach((el) => {
    el.addEventListener("click", () => verifySingleCompany(el.dataset.id, el));
  });
}

function renderDiscoveryResult(result) {
  const card = qs("#discoverResultCard");
  if (!result || result.error) {
    card.innerHTML = `<p style="color:var(--red);font-size:13px">${escHtml(result?.error ?? "Detection failed")}</p>`;
    setHidden(card, false);
    return;
  }

  const canAutoAdd = result.confidence >= discoveryMinConfidence;
  const supportedNote = result.supported
    ? "Sync supported"
    : "Discovery only — no fetch adapter yet";

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-weight:600;font-size:14px">${escHtml(result.name ?? "Unknown")}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">
          ${sourceBadge(result.ats_type)} · <code>${escHtml(result.ats_identifier ?? "—")}</code>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">${escHtml(result.careers_url ?? "")}</div>
        ${result.application_url ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">Apply: ${escHtml(result.application_url)}</div>` : ""}
        ${result.platform ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${escHtml(result.platform)}</div>` : ""}
        <div style="font-size:12px;color:var(--muted);margin-top:4px">${escHtml(supportedNote)}</div>
      </div>
      <span class="score-pill ${confidenceClass(result.confidence)}">${result.confidence ?? 0}% confidence</span>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" id="btnAddDiscovered" ${canAutoAdd ? "" : "disabled"}>
        Add to registry
      </button>
      <button class="btn btn-secondary btn-sm" id="btnAddDiscoveredAnyway" ${canAutoAdd ? 'style="display:none"' : ""}>
        Add anyway
      </button>
    </div>
    ${!canAutoAdd ? `<p style="font-size:12px;color:var(--yellow);margin:8px 0 0">Below auto-add threshold (${discoveryMinConfidence}%). Review before adding.</p>` : ""}
  `;
  setHidden(card, false);

  qs("#btnAddDiscovered")?.addEventListener("click", () => saveDiscoveredCompany(result));
  qs("#btnAddDiscoveredAnyway")?.addEventListener("click", () => {
    if (confirm("Confidence is low. Add this company anyway?")) {
      saveDiscoveredCompany(result);
    }
  });
}

async function detectCompanyAts() {
  const url = qs("#discoverUrlInput").value.trim();
  if (!url) return;

  const btn = qs("#btnDetectAts");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Detecting…';
  try {
    const result = await POST("/api/companies/discover", { url });
    lastDiscoveryResult = result;
    renderDiscoveryResult(result);
  } catch (err) {
    renderDiscoveryResult({ error: err.message });
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Detect ATS";
  }
}

async function saveDiscoveredCompany(result) {
  const entry = result.registry_entry ?? result;
  const company = {
    name: entry.name ?? result.name ?? result.company_name,
    website: entry.website ?? result.website ?? null,
    ats_type: entry.ats_type ?? result.ats_type,
    ats_identifier: entry.ats_identifier ?? result.ats_identifier,
    careers_url: entry.careers_url ?? result.careers_url,
    application_url: entry.application_url ?? result.application_url ?? null,
    platform: entry.platform ?? result.platform ?? null,
    discovery_confidence: entry.discovery_confidence ?? result.confidence,
    verification_status: entry.verification_status ?? (result.confidence >= 85 ? "verified" : "manual_review"),
    last_verified: entry.last_verified ?? new Date().toISOString(),
    preferred: entry.preferred ?? true,
    enabled: entry.enabled ?? result.supported !== false,
    sources: entry.sources ?? result.sources ?? [],
    notes: entry.notes ?? (result.supported ? "" : "ATS detected but fetch adapter not available yet"),
  };

  try {
    const saved = await POST("/api/companies", company);
    const existingIdx = companiesRegistry.findIndex((item) => item.id === saved.id);
    if (existingIdx >= 0) companiesRegistry[existingIdx] = saved;
    else companiesRegistry.push(saved);
    companiesRegistry.sort((a, b) => a.name.localeCompare(b.name));
    renderCompaniesTable();
    renderDashboard();
  } catch (err) {
    alert("Could not save company: " + err.message);
  }
}

async function toggleCompanyField(companyId, field, value) {
  const company = companiesRegistry.find((item) => item.id === companyId);
  if (!company) return;

  try {
    const saved = await POST("/api/companies", { ...company, [field]: value });
    Object.assign(company, saved);
    renderDashboard();
  } catch (err) {
    alert("Update failed: " + err.message);
    renderCompaniesTable();
  }
}

async function deleteCompany(companyId) {
  const company = companiesRegistry.find((item) => item.id === companyId);
  if (!company) return;
  if (!confirm(`Remove ${company.name} from registry?`)) return;

  try {
    await DELETE(`/api/companies/${companyId}`);
    companiesRegistry = companiesRegistry.filter((item) => item.id !== companyId);
    renderCompaniesTable();
    renderDashboard();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

async function loadCompaniesRegistry() {
  const data = await GET("/api/companies");
  companiesRegistry = data.companies ?? [];
  discoveryMinConfidence = data.discovery_min_confidence ?? 85;
  renderCompaniesTable();
  loadVerificationQueue();
}

function parseBatchDiscoverLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^https?:\/\//i.test(line)) {
        if (/career|jobs|work-with-us|apply|lever|greenhouse|smartrecruiters|ashby|oraclecloud/i.test(line)) {
          return { careers_url: line };
        }
        return { website: line };
      }
      return { name: line };
    });
}

function renderBatchDiscoverResults(results) {
  const container = qs("#batchDiscoverResults");
  if (!results?.length) {
    container.innerHTML = "<p style='color:var(--muted)'>No results.</p>";
    setHidden(container, false);
    return;
  }

  const resolvedCount = results.filter((item) => item.status === "resolved").length;
  const addableCount = results.filter((item) => canAddDiscoveryResult(item)).length;
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
      <span style="font-size:13px;color:var(--muted)">${results.length} discovered · ${resolvedCount} resolved · ${addableCount} addable</span>
      <button class="btn btn-primary btn-sm" id="btnAddAllResolved">Add all addable</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Input</th><th>Company</th><th>Sources</th><th>Status</th><th>Confidence</th><th>Detail</th><th></th></tr></thead>
        <tbody>
          ${results.map((item, idx) => {
            const addable = canAddDiscoveryResult(item);
            const detail = item.detail ?? item.error ?? "—";
            return `<tr class="batch-result-row" data-idx="${idx}">
            <td style="font-size:12px;max-width:220px;word-break:break-all">${escHtml(item.input)}</td>
            <td>${escHtml(item.company_name ?? "—")}</td>
            <td style="font-size:12px">${escHtml(formatSourceSummary(item.sources))}</td>
            <td>${escHtml(item.status)}</td>
            <td>${item.confidence != null ? `<span class="score-pill ${confidenceClass(item.confidence)}">${item.confidence}%</span>` : "—"}</td>
            <td style="font-size:12px;color:var(--muted);max-width:220px">${escHtml(detail)}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-secondary btn-sm batch-add-company" data-idx="${idx}" ${addable ? "" : "disabled"}>Add</button>
              <button class="btn btn-secondary btn-sm batch-toggle-evidence" data-idx="${idx}">Evidence</button>
            </td>
          </tr>
          <tr class="batch-evidence-row hidden" data-evidence-idx="${idx}">
            <td colspan="7" style="background:var(--surface2);font-size:12px">
              ${item.sources?.length ? `<div style="margin-bottom:8px"><strong>Boards:</strong> ${escHtml(formatSourceIdentifiers(item.sources))}</div>` : ""}
              ${renderDiscoveryEvidence(item.evidence)}
            </td>
          </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  setHidden(container, false);

  qs("#btnAddAllResolved")?.addEventListener("click", async () => {
    for (const item of results.filter((row) => canAddDiscoveryResult(row))) {
      await saveDiscoveredCompany(item);
    }
  });
  qsa(".batch-add-company", container).forEach((btn) => {
    btn.addEventListener("click", () => saveDiscoveredCompany(results[Number(btn.dataset.idx)]));
  });
  qsa(".batch-toggle-evidence", container).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = container.querySelector(`tr[data-evidence-idx="${btn.dataset.idx}"]`);
      if (row) row.classList.toggle("hidden");
    });
  });
}

async function runBatchDiscover() {
  const text = qs("#batchDiscoverInput").value.trim();
  if (!text) return;

  const btn = qs("#btnBatchDiscover");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Discovering…';
  try {
    const inputs = parseBatchDiscoverLines(text);
    const res = await POST("/api/companies/discover-batch", { inputs });
    renderBatchDiscoverResults(res.results ?? []);
  } catch (err) {
    alert("Batch discover failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Discover All";
  }
}

async function loadVerificationQueue() {
  const el = qs("#verificationQueueList");
  if (!el) return;
  try {
    const data = await GET("/api/companies/review-queue");
    const queue = data.companies ?? [];
    if (!queue.length) {
      el.innerHTML = "<p style='margin:0'>No companies need review.</p>";
      return;
    }
    el.innerHTML = queue.map((company) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <div>
          <strong>${escHtml(company.name)}</strong>
          ${verificationBadge(company.verification_status, company.last_verified)}
          <div style="font-size:11px;color:var(--muted)">${escHtml(company.ats_type)} · ${escHtml(company.ats_identifier ?? "—")}</div>
        </div>
        <button class="btn btn-secondary btn-sm queue-verify" data-id="${escHtml(company.id)}">Verify</button>
      </div>
    `).join("");
    qsa(".queue-verify", el).forEach((btn) => {
      btn.addEventListener("click", () => verifySingleCompany(btn.dataset.id, btn));
    });
  } catch {
    el.innerHTML = "<p style='margin:0'>Could not load verification queue.</p>";
  }
}

async function verifySingleCompany(companyId, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  }
  try {
    await POST(`/api/companies/verify/${companyId}`);
    await loadCompaniesRegistry();
  } catch (err) {
    alert("Verify failed: " + err.message);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "Verify";
    }
  }
}

async function verifyStaleCompanies() {
  const btn = qs("#btnVerifyStale");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying…';
  try {
    const res = await POST("/api/companies/verify-stale", { max_age_days: 30, limit: 10 });
    await loadCompaniesRegistry();
    alert(`Verified ${res.verified} companies (${res.changed} changed).`);
  } catch (err) {
    alert("Verify stale failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Verify Stale";
  }
}

let packsCache = [];

async function loadPacksList() {
  const listEl = qs("#packsList");
  const countEl = qs("#packCount");
  if (!listEl) return;

  try {
    const data = await GET("/api/packs");
    packsCache = data.packs ?? [];
    if (countEl) countEl.textContent = `${packsCache.length} packs`;
    setHidden(qs("#packsEmpty"), packsCache.length > 0);

    if (!packsCache.length) {
      listEl.innerHTML = "";
      return;
    }

    const cards = await Promise.all(
      packsCache.map(async (name) => {
        const pack = await GET(`/api/packs/${encodeURIComponent(name)}`);
        return { name, pack };
      })
    );

    listEl.innerHTML = cards.map(({ name, pack }) => `
      <div class="pack-card">
        <div class="pack-card-header">
          <div>
            <div style="font-weight:600">${escHtml(pack.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${escHtml(pack.description || "No description")}</div>
            <div style="font-size:11px;color:var(--muted)">${escHtml(pack.region ?? "")} · ${pack.companies?.length ?? 0} companies</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm pack-import" data-name="${escHtml(name)}">Import All</button>
            <a class="btn btn-secondary btn-sm" href="/api/packs/${encodeURIComponent(name)}/export" download="${escHtml(name)}.json">Export</a>
          </div>
        </div>
        <div style="margin-top:10px;font-size:12px;color:var(--muted)">
          ${(pack.companies ?? []).slice(0, 5).map((c) => escHtml(c.name)).join(", ")}${(pack.companies?.length ?? 0) > 5 ? "…" : ""}
        </div>
      </div>
    `).join("");

    qsa(".pack-import", listEl).forEach((btn) => {
      btn.addEventListener("click", () => importPack(btn.dataset.name, btn));
    });
  } catch (err) {
    listEl.innerHTML = `<p style="color:var(--red)">${escHtml(err.message)}</p>`;
  }
}

async function importPack(name, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  }
  try {
    const res = await POST(`/api/packs/${encodeURIComponent(name)}/import`);
    await loadCompaniesRegistry();
    alert(`Imported ${res.imported} companies from ${name}.`);
  } catch (err) {
    alert("Import failed: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "Import All";
    }
  }
}

async function buildPackFromInput() {
  const name = qs("#packBuildName").value.trim();
  const region = qs("#packBuildRegion").value.trim();
  const description = qs("#packBuildDescription").value.trim();
  const text = qs("#packBuildInput").value.trim();
  if (!name || !text) {
    alert("Pack name and company input are required.");
    return;
  }

  const btn = qs("#btnBuildPack");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Building…';
  try {
    const inputs = parseBatchDiscoverLines(text);
    await POST("/api/packs/build", {
      name,
      region: region || null,
      description: description || null,
      inputs,
    });
    qs("#packBuildInput").value = "";
    await loadPacksList();
    alert(`Pack "${name}" built successfully.`);
  } catch (err) {
    alert("Build pack failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Build Pack";
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Wire tabs
  qsa(".tabBtn").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // Load data from server
  try {
    const [jobs, prof, discover] = await Promise.all([
      GET("/api/jobs"),
      GET("/api/profile"),
      GET("/api/discover"),
    ]);
    allJobs = jobs;
    profile = prof;
    discoverResult = discover.result ?? null;
    discoverAnalyzedAt = discover.analyzed_at ?? null;
    await migrateDiscoverFromLocalStorage();
    await loadCompaniesRegistry();
  } catch (err) {
    console.warn("Could not load from server (server may not be running):", err.message);
    allJobs = [];
    profile = {};
    discoverResult = null;
    discoverAnalyzedAt = null;
  }

  // Render all tabs
  renderDashboard();
  populateJobCompanyFilter();
  renderJobsTable();
  renderDiscoverTab(discoverResult);
  if (state.worth) renderWorthResults(state.worth);
  renderTracker();
  loadProfileToForm(profile);
  populateTailorSelect();

  // Profile save
  qs("#btnSaveProfile").addEventListener("click", saveProfile);

  // Skill extract
  qs("#skillInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = qs("#skillInput").value.trim();
      if (v) { renderSkillTags([...skillTagsData, v]); qs("#skillInput").value = ""; }
    }
  });
  qs("#btnExtractSkills").addEventListener("click", parseResume);
  qs("#btnAddWork").addEventListener("click", promptAddWork);

  // Jobs tab
  qs("#btnSync").addEventListener("click", syncJobs);
  qs("#btnRank").addEventListener("click", rankAllJobs);
  qs("#btnDeepScore").addEventListener("click", deepScoreTop50);
  ["#jobSearch","#jobSourceFilter","#jobCompanyFilter","#jobSectorFilter","#jobLocationFilter","#jobRemoteFilter","#jobSortSelect"].forEach((sel) => {
    qs(sel).addEventListener("change", renderJobsTable);
    if (sel === "#jobSearch" || sel === "#jobLocationFilter") qs(sel).addEventListener("input", renderJobsTable);
  });

  // Companies tab
  qs("#btnDetectAts").addEventListener("click", detectCompanyAts);
  qs("#discoverUrlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") detectCompanyAts();
  });
  qs("#btnBatchDiscover").addEventListener("click", runBatchDiscover);
  qs("#btnVerifyStale").addEventListener("click", verifyStaleCompanies);
  ["#companyAtsFilter", "#companyPreferredFilter"].forEach((sel) => {
    qs(sel).addEventListener("change", renderCompaniesTable);
  });

  // Packs tab
  qs("#btnBuildPack").addEventListener("click", buildPackFromInput);

  // Discover
  qs("#btnDiscover").addEventListener("click", runDiscover);
  qs("#btnWhatIf").addEventListener("click", () => {
    const skill = qs("#whatIfSkill").value;
    if (!skill) return;
    // Add to profile skills and re-run discover
    if (!skillTagsData.includes(skill)) {
      renderSkillTags([...skillTagsData, skill]);
      alert(`"${skill}" added to your skills. Save your profile and re-run Analyze to see the impact.`);
    }
  });

  // Worth
  qs("#btnAnalyzeWorth").addEventListener("click", analyzeWorth);
  qs("#btnAddScenario").addEventListener("click", () => {
    worthScenarios.push("");
    renderWorthScenarios();
  });
  renderWorthScenarios();

  // Tailor
  qs("#btnTailorResume").addEventListener("click", tailorResume);

  // Tracker
  qs("#btnAddApplication").addEventListener("click", () => openAppModal());
  qs("#btnSaveApp").addEventListener("click", saveApp);
  qs("#btnCloseAppModal").addEventListener("click", closeAppModal);
  qs("#btnCancelAppModal").addEventListener("click", closeAppModal);
}

document.addEventListener("DOMContentLoaded", boot);
