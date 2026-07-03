const fetch = require("node-fetch");
const {
  getDetailFilterKeywords,
  jobMatchesSyncFilters,
  DEFAULT_LOCATION_KEYWORDS,
  DEFAULT_TITLE_KEYWORDS,
} = require("./syncFilters");

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function formatLocation(loc) {
  if (!loc) return "";
  if (loc.fullLocation) return loc.fullLocation;
  return [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
}

function inferSector(item) {
  const text = [
    item.department?.label,
    item.function?.label,
    item.industry?.label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (text.includes("engineer") || text.includes("software") || text.includes("technology")) {
    return "tech";
  }
  if (text.includes("product")) return "product";
  if (text.includes("sales") || text.includes("revenue")) return "sales";
  if (text.includes("design")) return "design";
  return "tech";
}

function buildMetadataDescription(item) {
  return [
    item.name,
    item.department?.label,
    item.function?.label,
    item.experienceLevel?.label,
    item.typeOfEmployment?.label,
    item.industry?.label,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDetailDescription(detail) {
  const sections = detail?.jobAd?.sections ?? {};
  return Object.values(sections)
    .map((section) => {
      if (!section?.text) return "";
      return section.title ? `${section.title}\n${section.text}` : section.text;
    })
    .filter(Boolean)
    .join("\n\n");
}

function locationSearchText(item) {
  const loc = item.location ?? {};
  return [
    loc.fullLocation,
    loc.city,
    loc.region,
    loc.country,
    loc.remote ? "remote" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesLocationFilter(item, keywords) {
  const loc = item.location ?? {};
  if (loc.remote === true) return true;
  const text = locationSearchText(item);
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function matchesTitleFilter(item, keywords) {
  const title = (item.name ?? "").toLowerCase();
  return keywords.some((keyword) => title.includes(keyword.toLowerCase()));
}

function shouldFetchDetail(item, options) {
  const { detailLocationKeywords, detailTitleKeywords } = getDetailFilterKeywords(options);
  return (
    matchesLocationFilter(item, detailLocationKeywords) &&
    matchesTitleFilter(item, detailTitleKeywords)
  );
}

function careersUrl(slug, postingId) {
  return `https://jobs.smartrecruiters.com/${slug}/${postingId}`;
}

function normalizeJob(slug, item, descriptionClean, applyUrl) {
  const loc = item.location ?? {};
  const postingId = item.id;
  const url = applyUrl || careersUrl(slug, postingId);

  return {
    id: `smartrecruiters-${postingId}`,
    source: "smartrecruiters",
    title: item.name ?? "",
    company: item.company?.name ?? slug,
    location: formatLocation(loc),
    remote: loc.remote === true,
    salary_min: null,
    salary_max: null,
    salary_interval: null,
    description_raw: descriptionClean,
    description_clean: descriptionClean,
    posted_at: item.releasedDate ?? null,
    url,
    sector: inferSector(item),
    apply_url: url,
  };
}

async function fetchPostingDetail(slug, postingId) {
  const res = await fetch(`${BASE}/${slug}/postings/${postingId}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchCompanyPostings(slug, options) {
  const postings = [];
  let offset = 0;
  let totalFound = null;

  while (totalFound === null || offset < totalFound) {
    const res = await fetch(
      `${BASE}/${slug}/postings?limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (res.status === 404) {
      console.warn(
        `SmartRecruiters: no public postings feed for "${slug}" — check slug at careers.smartrecruiters.com/${slug}`
      );
      return [];
    }
    if (!res.ok) {
      console.warn(`SmartRecruiters: skipping ${slug} (${res.status})`);
      return postings;
    }

    const json = await res.json();
    totalFound = json.totalFound ?? 0;
    const content = json.content ?? [];
    if (!content.length) break;

    postings.push(...content);
    offset += content.length;
    if (content.length < PAGE_SIZE) break;
  }

  const jobs = [];
  for (const item of postings) {
    let descriptionClean = buildMetadataDescription(item);
    let applyUrl = careersUrl(slug, item.id);

    if (shouldFetchDetail(item, options)) {
      try {
        const detail = await fetchPostingDetail(slug, item.id);
        if (detail) {
          const detailText = buildDetailDescription(detail);
          if (detailText) descriptionClean = stripHtml(detailText);
          if (detail.applyUrl) applyUrl = detail.applyUrl;
        }
      } catch (err) {
        console.warn(
          `SmartRecruiters: detail fetch failed for ${slug}/${item.id}:`,
          err.message
        );
      }
      await sleep(DETAIL_DELAY_MS);
    }

    const job = normalizeJob(slug, item, descriptionClean, applyUrl);
    if (!jobMatchesSyncFilters(job, options)) continue;
    jobs.push(job);
  }

  return jobs;
}

async function fetchSmartRecruiters(companies, options = {}) {
  const results = [];
  for (const slug of companies) {
    if (!slug?.trim()) continue;
    try {
      const jobs = await fetchCompanyPostings(slug.trim(), options);
      results.push(...jobs);
      await sleep(600);
    } catch (err) {
      console.warn(`SmartRecruiters: error fetching ${slug}:`, err.message);
    }
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchSmartRecruiters };
