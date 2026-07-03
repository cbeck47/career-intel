const fetch = require("node-fetch");

const BASE = "https://api.lever.co/v0/postings";
const BASE_EU = "https://api.eu.lever.co/v0/postings";

function normalizeJob(company, item) {
  const loc = (item.categories?.location ?? "").toLowerCase();
  return {
    id: `lever-${item.id}`,
    source: "lever",
    title: item.text,
    company,
    location: item.categories?.location ?? "",
    remote: loc.includes("remote"),
    salary_min: null,
    salary_max: null,
    salary_interval: null,
    description_raw: buildDescription(item),
    description_clean: buildDescription(item),
    posted_at: item.createdAt ? new Date(item.createdAt).toISOString() : null,
    url: item.hostedUrl ?? "",
    sector: inferSector(item.categories?.team ?? ""),
    apply_url: item.applyUrl ?? item.hostedUrl ?? "",
  };
}

function buildDescription(item) {
  return [
    item.text,
    item.categories?.team ?? "",
    item.descriptionPlain ?? item.description ?? "",
    (item.lists ?? []).map((l) => `${l.text}: ${l.content}`).join("\n"),
    item.additional ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function inferSector(team) {
  const t = (team ?? "").toLowerCase();
  if (t.includes("engineer") || t.includes("software")) return "tech";
  if (t.includes("product")) return "product";
  if (t.includes("sales") || t.includes("revenue")) return "sales";
  if (t.includes("design")) return "design";
  return "tech";
}

async function fetchLever(companies) {
  const results = [];
  for (const company of companies) {
    const jobs = await fetchCompany(company);
    results.push(...jobs);
    await sleep(600);
  }
  return results;
}

async function fetchCompany(company) {
  let lastStatus = null;
  for (const base of [BASE, BASE_EU]) {
    try {
      const res = await fetch(`${base}/${company}?mode=json`);
      lastStatus = res.status;
      if (res.status === 404) continue;
      if (!res.ok) {
        console.warn(`Lever: skipping ${company} (${res.status})`);
        return [];
      }
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      return json.map((j) => normalizeJob(company, j));
    } catch (err) {
      console.warn(`Lever: error fetching ${company} from ${base}:`, err.message);
    }
  }

  if (lastStatus === 404) {
    console.warn(`Lever: no postings board found for "${company}" — check slug at jobs.lever.co/${company}`);
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { fetchLever };
