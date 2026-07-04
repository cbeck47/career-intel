const fetch = require("node-fetch");
const { jobMatchesSyncFilters } = require("./syncFilters");

const USER_AGENT = "CareerIntel/1.0 (iCIMS fetcher)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJob(identifier, item, displayName) {
  const title = item.title ?? item.jobTitle ?? "";
  const location = item.location ?? item.cityState ?? item.formattedLocation ?? "";
  const jobId = item.id ?? item.jobId ?? item.reqId ?? title;
  const relativeUrl = item.url ?? item.link ?? `/jobs/${jobId}/job`;
  const base = `https://careers-${identifier}.icims.com`;
  const url = relativeUrl.startsWith("http") ? relativeUrl : `${base}${relativeUrl}`;

  return {
    id: `icims-${identifier}-${jobId}`.replace(/\s+/g, "-"),
    source: "icims",
    title,
    company: displayName ?? identifier,
    location,
    remote: /remote/i.test(location),
    salary_min: null,
    salary_max: null,
    salary_interval: null,
    description_raw: item.description ?? item.summary ?? title,
    description_clean: item.description ?? item.summary ?? title,
    posted_at: item.date ?? item.postedDate ?? item.updated ?? null,
    url,
    sector: "tech",
    apply_url: url,
  };
}

function extractJobs(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.jobs)) return json.jobs;
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.searchResults)) return json.searchResults;
  return [];
}

async function fetchIcims(identifier, options = {}) {
  if (!identifier?.trim()) return [];

  const slug = identifier.trim();
  const displayName = options.displayName ?? slug;
  const searchUrl = `https://careers-${slug}.icims.com/jobs/search?ss=1&searchRelation=keyword_all&output=json`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      console.warn(`iCIMS: skipping ${slug} (${res.status})`);
      return [];
    }

    const json = await res.json();
    const rawJobs = extractJobs(json);
    const jobs = [];

    for (const item of rawJobs) {
      const job = normalizeJob(slug, item, displayName);
      if (!jobMatchesSyncFilters(job, options)) continue;
      jobs.push(job);
    }

    await sleep(400);
    return jobs;
  } catch (err) {
    console.warn(`iCIMS: error fetching ${slug}:`, err.message);
    return [];
  }
}

module.exports = { fetchIcims };
