const crypto = require("crypto");
const fetch = require("node-fetch");
const { parseOracleIdentifier } = require("../registry/companies");
const { jobMatchesSyncFilters } = require("./syncFilters");

const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 400;
const USER_AGENT = "CareerIntel/1.0 (Oracle Recruiting Cloud)";

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function inferSector(title, category) {
  const text = `${title ?? ""} ${category ?? ""}`.toLowerCase();
  if (text.includes("engineer") || text.includes("software") || text.includes("technology")) {
    return "tech";
  }
  if (text.includes("product")) return "product";
  if (text.includes("sales") || text.includes("revenue")) return "sales";
  if (text.includes("manufacturing") || text.includes("operations")) return "tech";
  return "tech";
}

function formatWorkLocation(workLocation) {
  if (!Array.isArray(workLocation) || !workLocation.length) return "";
  const loc = workLocation[0];
  return [
    loc.TownOrCity,
    loc.Region2,
    loc.Country === "US" ? "United States" : loc.Country,
  ]
    .filter(Boolean)
    .join(", ");
}

function buildDescription(req) {
  return [
    req.ShortDescriptionStr,
    req.ExternalQualificationsStr,
    req.ExternalResponsibilitiesStr,
  ]
    .filter(Boolean)
    .map(stripHtml)
    .join("\n\n");
}

function buildJobUrl(applicationUrl, siteNumber, requisitionId, tenantHost, locale = "en") {
  if (applicationUrl) {
    const base = applicationUrl.replace(/\/$/, "");
    return `${base}/${locale}/sites/${siteNumber}/job/${requisitionId}`;
  }
  return `https://${tenantHost}/hcmUI/CandidateExperience/${locale}/sites/${siteNumber}/job/${requisitionId}`;
}

function safeJobId(tenantHost, siteNumber, requisitionId) {
  const tenantKey = tenantHost.replace(/\./g, "_");
  return `oracle-${tenantKey}-${siteNumber}-${requisitionId}`;
}

function normalizeJob(req, ctx) {
  const { tenantHost, siteNumber, applicationUrl, displayName, locale } = ctx;
  const location = req.PrimaryLocation || formatWorkLocation(req.workLocation);
  const workplace = (req.WorkplaceType ?? "").toLowerCase();
  const remote =
    req.WorkplaceTypeCode === "ORA_REMOTE" ||
    workplace.includes("remote") ||
    location.toLowerCase().includes("remote");

  const descriptionClean = buildDescription(req);
  const url = buildJobUrl(applicationUrl, siteNumber, req.Id, tenantHost, locale);

  return {
    id: safeJobId(tenantHost, siteNumber, req.Id),
    source: "oracle_recruiting_cloud",
    title: req.Title ?? "",
    company: displayName ?? "",
    location,
    remote,
    salary_min: null,
    salary_max: null,
    salary_interval: null,
    description_raw: descriptionClean,
    description_clean: descriptionClean,
    posted_at: req.PostedDate ?? null,
    url,
    sector: inferSector(req.Title, req.JobFamily),
    apply_url: url,
  };
}

function oracleHeaders(sessionUserId) {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "Content-Type": "application/json",
    "ora-irc-cx-userid": sessionUserId,
    "ora-irc-language": "en",
  };
}

async function fetchJobPage(tenantHost, siteNumber, offset, sessionUserId) {
  const params = new URLSearchParams({
    onlyData: "true",
    expand: "requisitionList.workLocation",
    finder: `findReqs;siteNumber=${siteNumber}`,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });

  const url = `https://${tenantHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params}`;
  const res = await fetch(url, { headers: oracleHeaders(sessionUserId) });
  if (!res.ok) {
    throw new Error(`Oracle API ${res.status} for ${tenantHost}`);
  }
  return res.json();
}

async function fetchOracleRecruiting(identifier, options = {}) {
  const parsed = parseOracleIdentifier(identifier);
  if (!parsed) {
    console.warn(`Oracle: invalid identifier "${identifier}" — expected tenantHost|siteNumber`);
    return [];
  }

  const { tenantHost, siteNumber } = parsed;
  const sessionUserId = crypto.randomUUID();
  const applicationUrl = options.applicationUrl ?? null;
  const locale = options.locale ?? "en";
  const displayName = options.displayName ?? "";
  const ctx = { tenantHost, siteNumber, applicationUrl, displayName, locale };

  const jobs = [];
  let offset = 0;
  let totalCount = null;

  while (totalCount === null || offset < totalCount) {
    const json = await fetchJobPage(tenantHost, siteNumber, offset, sessionUserId);
    const item = json.items?.[0];
    if (!item) break;

    if (totalCount === null) {
      totalCount = item.TotalJobsCount ?? 0;
    }

    const requisitions = item.requisitionList ?? [];
    if (!requisitions.length) break;

    for (const req of requisitions) {
      const job = normalizeJob(req, ctx);
      if (!jobMatchesSyncFilters(job, options)) continue;
      jobs.push(job);
    }

    offset += requisitions.length;
    if (!requisitions.length || offset >= totalCount) break;
    await sleep(PAGE_DELAY_MS);
  }

  return jobs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchOracleRecruiting, normalizeJob, buildJobUrl };
