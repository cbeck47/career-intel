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
    discover: null,    // cached discovery result
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

let state = loadState();

// In-memory job + profile cache (loaded from server on boot)
let allJobs = [];
let profile = {};
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
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function GET(path) { return api("GET", path); }
function POST(path, body) { return api("POST", path, body); }

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

async function extractSkillsFromResume() {
  const resumeText = qs("#profResume").value.trim();
  if (!resumeText) { alert("Paste your resume text first."); return; }
  const btn = qs("#btnExtractSkills");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Extracting…';
  try {
    const res = await POST("/api/ai/match", { job_id: "__extract_skills__" }).catch(async () => {
      // Fallback: simple regex extraction on client
      return null;
    });
    // Use a dedicated extract endpoint via worth call or just local heuristic
    const words = resumeText.match(/\b[A-Z][A-Za-z+#.]{2,}\b/g) ?? [];
    const freq = {};
    words.forEach((w) => { freq[w] = (freq[w] ?? 0) + 1; });
    const candidates = Object.entries(freq)
      .filter(([w, c]) => c >= 2 && w.length > 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([w]) => w);
    const existing = new Set(skillTagsData.map((s) => s.toLowerCase()));
    const newSkills = candidates.filter((s) => !existing.has(s.toLowerCase()));
    renderSkillTags([...skillTagsData, ...newSkills]);
    btn.innerHTML = `&#10024; Extracted ${newSkills.length} skills`;
  } catch (err) {
    alert("Extraction error: " + err.message);
    btn.innerHTML = '&#10024; Extract from Resume';
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.innerHTML = '&#10024; Extract from Resume'; }, 3000);
  }
}

// ---------------------------------------------------------------------------
// JOBS TAB
// ---------------------------------------------------------------------------

function filteredJobs() {
  const search = qs("#jobSearch").value.toLowerCase();
  const source = qs("#jobSourceFilter").value;
  const sector = qs("#jobSectorFilter").value;
  const sort = qs("#jobSortSelect").value;

  let jobs = allJobs.filter((j) => {
    if (source && j.source !== source) return false;
    if (sector && j.sector !== sector) return false;
    if (search && !`${j.title} ${j.company}`.toLowerCase().includes(search)) return false;
    return true;
  });

  if (sort === "score") {
    jobs.sort((a, b) => (b.ai_score?.overall_score ?? -1) - (a.ai_score?.overall_score ?? -1));
  } else if (sort === "recent") {
    jobs.sort((a, b) => new Date(b.posted_at ?? 0) - new Date(a.posted_at ?? 0));
  } else if (sort === "salary") {
    jobs.sort((a, b) => (b.salary_max ?? 0) - (a.salary_max ?? 0));
  }
  return jobs;
}

function renderJobsTable() {
  const jobs = filteredJobs();
  const tbody = qs("#jobsTableBody");
  qs("#jobCount").textContent = `${jobs.length} jobs`;
  setHidden(qs("#jobsEmpty"), jobs.length > 0);

  if (!jobs.length) { tbody.innerHTML = ""; return; }

  tbody.innerHTML = jobs.map((j) => {
    const score = j.ai_score?.overall_score;
    const scorePill = score != null
      ? `<span class="score-pill ${scoreClass(score)}">${score}%</span>`
      : `<button class="btn btn-secondary btn-sm score-job" data-id="${escHtml(j.id)}">Score</button>`;
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

async function syncJobs() {
  const btn = qs("#btnSync");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing…';
  try {
    const res = await POST("/api/jobs/sync");
    allJobs = await GET("/api/jobs");
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

function renderDashboard() {
  const scored = allJobs.filter((j) => j.ai_score);
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, j) => s + (j.ai_score.overall_score ?? 0), 0) / scored.length)
    : 0;
  const topScore = scored.length
    ? Math.max(...scored.map((j) => j.ai_score?.overall_score ?? 0))
    : 0;
  const applied = state.tracker.filter((t) => t.status === "Applied").length;
  const interviewing = state.tracker.filter((t) => ["Phone Screen","Interview"].includes(t.status)).length;

  qs("#dashKpis").innerHTML = [
    { v: allJobs.length,      l: "Total Jobs" },
    { v: scored.length,       l: "Jobs Scored" },
    { v: avgScore ? avgScore + "%" : "—", l: "Avg Fit Score" },
    { v: topScore ? topScore + "%" : "—", l: "Best Match" },
    { v: state.tracker.length, l: "Applications" },
    { v: applied,              l: "Applied" },
    { v: interviewing,         l: "Interviewing" },
  ].map((k) => `<div class="kpi"><div class="kpi-value">${escHtml(String(k.v))}</div><div class="kpi-label">${escHtml(k.l)}</div></div>`).join("");

  // Top 5 jobs
  const top = [...scored].sort((a, b) => (b.ai_score?.overall_score ?? 0) - (a.ai_score?.overall_score ?? 0)).slice(0, 5);
  qs("#dashTopJobs").innerHTML = top.length
    ? top.map((j) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <a href="${escHtml(j.url)}" target="_blank" style="color:var(--text);font-weight:600;font-size:13px">${escHtml(j.title)}</a>
            <div style="font-size:11px;color:var(--muted)">${escHtml(j.company)} · ${sourceBadge(j.source)}</div>
          </div>
          <span class="score-pill ${scoreClass(j.ai_score?.overall_score)}">${j.ai_score?.overall_score}%</span>
        </div>`).join("")
    : `<p style="color:var(--muted);font-size:13px">Score some jobs to see top matches here.</p>`;

  // Skill gap chart
  const allMissing = scored.flatMap((j) => j.ai_score?.missing_skills ?? []);
  const freq = {};
  allMissing.forEach((s) => { freq[s] = (freq[s] ?? 0) + 1; });
  const top10 = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);

  destroyChart("skillGap");
  if (top10.length) {
    charts.skillGap = new Chart(qs("#skillGapChart"), {
      type: "bar",
      data: {
        labels: top10.map(([s]) => s),
        datasets: [{ data: top10.map(([, c]) => c), backgroundColor: "#6c8cff88", borderColor: "#6c8cff", borderWidth: 1 }],
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
  }

  // Insights
  const insights = scored.flatMap((j) => {
    const r = [];
    if ((j.ai_score?.overall_score ?? 0) >= 85) r.push(`Strong match (${j.ai_score.overall_score}%) for ${j.title} at ${j.company}.`);
    if (j.ai_score?.missing_skills?.length) r.push(`Learning ${j.ai_score.missing_skills[0]} could improve your fit for ${j.title}.`);
    return r;
  }).slice(0, 5);
  qs("#dashInsights").innerHTML = insights.length
    ? insights.map((i) => `<div class="insight-item">${escHtml(i)}</div>`).join("")
    : `<p style="color:var(--muted);font-size:13px">Score some jobs to generate insights.</p>`;
}

// ---------------------------------------------------------------------------
// DISCOVER TAB
// ---------------------------------------------------------------------------

async function runDiscover() {
  const btn = qs("#btnDiscover");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  try {
    const result = await POST("/api/ai/discover");
    state.discover = result;
    saveState(state);
    renderDiscoverTab(result);
  } catch (err) {
    alert("Discovery error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#10024; Analyze";
  }
}

function renderDiscoverTab(d) {
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
    charts.sector = new Chart(qs("#sectorChart"), {
      type: "bar",
      data: {
        labels: hm.map((s) => s.sector),
        datasets: [{ label: "Avg Fit %", data: hm.map((s) => s.avg_fit), backgroundColor: "#a78bfa88", borderColor: "#a78bfa", borderWidth: 1 }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" } },
          y: { ticks: { color: "#8892b0" }, grid: { color: "#2e3154" }, suggestedMax: 100 },
        },
      },
    });
  }

  // Career network canvas
  drawCareerNetwork(d.adjacent_roles ?? []);

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

function drawCareerNetwork(adjacentRoles) {
  const canvas = qs("#discoveryCanvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth || 700;
  const H = canvas.offsetHeight || 420;
  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);

  if (!adjacentRoles.length) {
    ctx.fillStyle = "#8892b0";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Run Analyze to see your career network", W / 2, H / 2);
    return;
  }

  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) * 0.35;

  const nodes = [
    { label: profile.headline || "Your Role", x: cx, y: cy, r: 36, isCenter: true, fit: 100 },
    ...adjacentRoles.slice(0, 8).map((role, i) => {
      const angle = (i / Math.min(adjacentRoles.length, 8)) * Math.PI * 2 - Math.PI / 2;
      const fit = role.avg_fit ?? 70;
      const dist = R * (1 + (100 - fit) / 200);
      return {
        label: role.title,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        r: 12 + (fit / 100) * 18,
        isCenter: false,
        fit,
      };
    }),
  ];

  // Draw edges
  nodes.slice(1).forEach((n) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(n.x, n.y);
    ctx.strokeStyle = "#2e3154";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // Draw nodes
  nodes.forEach((n) => {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = n.isCenter ? "#6c8cff" : n.fit >= 75 ? "#34d399" : n.fit >= 50 ? "#fbbf24" : "#f87171";
    ctx.fill();
    ctx.strokeStyle = "#1a1d2e";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    ctx.fillStyle = "#e2e8f0";
    ctx.font = `${n.isCenter ? "bold " : ""}11px sans-serif`;
    ctx.textAlign = "center";
    const words = n.label.split(" ");
    words.forEach((word, wi) => {
      ctx.fillText(word, n.x, n.y + n.r + 13 + wi * 13);
    });
    if (!n.isCenter) {
      ctx.fillStyle = "#8892b0";
      ctx.font = "10px sans-serif";
      ctx.fillText(`${n.fit}%`, n.x, n.y + 4);
    }
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
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Wire tabs
  qsa(".tabBtn").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // Load data from server
  try {
    [allJobs, profile] = await Promise.all([GET("/api/jobs"), GET("/api/profile")]);
  } catch (err) {
    console.warn("Could not load from server (server may not be running):", err.message);
    allJobs = [];
    profile = {};
  }

  // Render all tabs
  renderDashboard();
  renderJobsTable();
  renderDiscoverTab(state.discover);
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
  qs("#btnExtractSkills").addEventListener("click", extractSkillsFromResume);
  qs("#btnAddWork").addEventListener("click", promptAddWork);

  // Jobs tab
  qs("#btnSync").addEventListener("click", syncJobs);
  ["#jobSearch","#jobSourceFilter","#jobSectorFilter","#jobSortSelect"].forEach((sel) => {
    qs(sel).addEventListener("change", renderJobsTable);
    if (sel === "#jobSearch") qs(sel).addEventListener("input", renderJobsTable);
  });

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
