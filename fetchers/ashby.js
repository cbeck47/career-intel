const fetch = require("node-fetch");

const BASE = "https://api.ashbyhq.com/posting-api/job-board";

function normalizeJob(company, item) {
  const comp = item.compensationTiers?.[0] ?? {};
  const salaryComp = (item.compensationTiers ?? []).find(
    (t) => t.compensationType === "Salary"
  );
  return {
    id: `ashby-${item.id}`,
    source: "ashby",
    title: item.title,
    company,
    location: item.locationName ?? "",
    remote: item.isRemote ?? false,
    salary_min: salaryComp?.minValue ?? null,
    salary_max: salaryComp?.maxValue ?? null,
    salary_interval: salaryComp?.interval ?? null,
    salary_summary: item.compensationTierSummary ?? null,
    description_raw: item.descriptionHtml ?? "",
    description_clean: stripHtml(item.descriptionHtml ?? ""),
    posted_at: item.publishedDate ?? null,
    url: item.jobUrl ?? "",
    sector: inferSector(item.department ?? ""),
    apply_url: item.applyUrl ?? item.jobUrl ?? "",
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function inferSector(dept) {
  const d = (dept ?? "").toLowerCase();
  if (d.includes("engineer") || d.includes("software")) return "tech";
  if (d.includes("product")) return "product";
  if (d.includes("sales")) return "sales";
  return "tech";
}

async function fetchAshby(companies) {
  const results = [];
  for (const company of companies) {
    try {
      const res = await fetch(
        `${BASE}/${company}?includeCompensation=true`
      );
      if (!res.ok) {
        console.warn(`Ashby: skipping ${company} (${res.status})`);
        continue;
      }
      const json = await res.json();
      const jobs = (json.jobs ?? [])
        .filter((j) => j.isListed !== false)
        .map((j) => normalizeJob(company, j));
      results.push(...jobs);
      await sleep(800);
    } catch (err) {
      console.warn(`Ashby: error fetching ${company}:`, err.message);
    }
  }
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { fetchAshby };
