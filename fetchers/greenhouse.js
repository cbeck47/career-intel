const fetch = require("node-fetch");

const BASE = "https://boards-api.greenhouse.io/v1/boards";

function normalizeJob(company, item) {
  const loc = item.location ?? {};
  const salaryRange = item.salary_range ?? {};
  return {
    id: `greenhouse-${item.id}`,
    source: "greenhouse",
    title: item.title,
    company,
    location: loc.name ?? "",
    remote: (loc.name ?? "").toLowerCase().includes("remote"),
    salary_min: salaryRange.min_amount ?? null,
    salary_max: salaryRange.max_amount ?? null,
    salary_interval: salaryRange.unit ?? null,
    description_raw: item.content ?? "",
    description_clean: stripHtml(item.content ?? ""),
    posted_at: item.updated_at ?? null,
    url: item.absolute_url ?? "",
    sector: inferSector(item.departments),
    apply_url: item.absolute_url ?? "",
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function inferSector(departments) {
  if (!departments?.length) return "tech";
  const name = departments[0]?.name?.toLowerCase() ?? "";
  if (name.includes("engineer") || name.includes("software")) return "tech";
  if (name.includes("product")) return "product";
  if (name.includes("sales") || name.includes("revenue")) return "sales";
  if (name.includes("design")) return "design";
  return "tech";
}

async function fetchGreenhouse(companies) {
  const results = [];
  for (const company of companies) {
    try {
      const res = await fetch(`${BASE}/${company}/jobs?content=true`);
      if (!res.ok) {
        console.warn(`Greenhouse: skipping ${company} (${res.status})`);
        continue;
      }
      const json = await res.json();
      const jobs = (json.jobs ?? []).map((j) => normalizeJob(company, j));
      results.push(...jobs);
      await sleep(600);
    } catch (err) {
      console.warn(`Greenhouse: error fetching ${company}:`, err.message);
    }
  }
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { fetchGreenhouse };
