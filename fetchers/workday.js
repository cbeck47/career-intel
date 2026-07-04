const fetch = require("node-fetch");
const { jobMatchesSyncFilters } = require("./syncFilters");

const USER_AGENT = "CareerIntel/1.0 (Workday fetcher)";
const PAGE_SIZE = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWorkdayIdentifier(identifier, applicationUrl) {
  if (!identifier?.trim()) return null;

  if (identifier.includes("|")) {
    const [tenant, jobboard] = identifier.split("|").map((part) => part.trim());
    if (tenant && jobboard) return { tenant, jobboard };
  }

  if (applicationUrl) {
    try {
      const url = new URL(applicationUrl);
      const match = url.hostname.match(/^([a-z0-9-]+)\.myworkdayjobs\.com$/i);
      if (match) {
        return { tenant: match[1].toLowerCase(), jobboard: identifier.trim() };
      }
    } catch {
      // ignore invalid URL
    }
  }

  return null;
}

function buildJobUrl(tenant, jobboard, externalPath) {
  const path = externalPath?.startsWith("/") ? externalPath : `/${externalPath ?? ""}`;
  return `https://${tenant}.myworkdayjobs.com/en-US/${jobboard}${path}`;
}

function normalizeJob(tenant, jobboard, item, displayName) {
  const externalPath = item.externalPath ?? item.externalUrl ?? "";
  const url = buildJobUrl(tenant, jobboard, externalPath);
  const location = item.locationsText ?? item.location ?? "";

  return {
    id: `workday-${tenant}-${jobboard}-${item.bulletFields?.[0] ?? externalPath}`.replace(/\s+/g, "-"),
    source: "workday",
    title: item.title ?? "",
    company: displayName ?? tenant,
    location,
    remote: /remote/i.test(location),
    salary_min: null,
    salary_max: null,
    salary_interval: null,
    description_raw: item.description ?? item.summary ?? "",
    description_clean: item.description ?? item.summary ?? item.title ?? "",
    posted_at: item.postedOn ?? item.postedDate ?? null,
    url,
    sector: "tech",
    apply_url: url,
  };
}

async function fetchWorkdayPage(tenant, jobboard, offset) {
  const apiUrl = `https://${tenant}.myworkdayjobs.com/wday/cxs/${tenant}/${jobboard}/jobs`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appliedFacets: {},
      limit: PAGE_SIZE,
      offset,
      searchText: "",
    }),
  });

  if (!res.ok) {
    console.warn(`Workday: ${tenant}/${jobboard} returned ${res.status}`);
    return null;
  }

  return res.json();
}

async function fetchWorkday(identifier, options = {}) {
  const parsed = parseWorkdayIdentifier(identifier, options.applicationUrl);
  if (!parsed) {
    console.warn(
      `Workday: invalid identifier "${identifier}" — expected tenant|jobboard or jobboard with applicationUrl`
    );
    return [];
  }

  const { tenant, jobboard } = parsed;
  const displayName = options.displayName ?? tenant;
  const jobs = [];
  let offset = 0;

  while (true) {
    let json;
    try {
      json = await fetchWorkdayPage(tenant, jobboard, offset);
    } catch (err) {
      console.warn(`Workday: error fetching ${tenant}/${jobboard}:`, err.message);
      break;
    }

    if (!json) break;

    const postings = json.jobPostings ?? json.jobs ?? [];
    if (!postings.length) break;

    for (const item of postings) {
      const job = normalizeJob(tenant, jobboard, item, displayName);
      if (!jobMatchesSyncFilters(job, options)) continue;
      jobs.push(job);
    }

    if (postings.length < PAGE_SIZE) break;
    offset += postings.length;
    await sleep(400);
  }

  return jobs;
}

module.exports = { fetchWorkday, parseWorkdayIdentifier };
