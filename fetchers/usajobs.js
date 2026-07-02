const fetch = require("node-fetch");

const BASE = "https://data.usajobs.gov/api/search";

function normalizeJob(item) {
  const pos = item.MatchedObjectDescriptor;
  const remuneration = pos.PositionRemuneration?.[0] ?? {};
  const loc = pos.PositionLocation?.[0] ?? {};
  return {
    id: `usajobs-${pos.PositionID}`,
    source: "usajobs",
    title: pos.PositionTitle,
    company: pos.OrganizationName,
    location: loc.LocationName ?? "",
    remote: (pos.PositionOfferingType ?? []).some((t) =>
      t.Name?.toLowerCase().includes("remote")
    ),
    salary_min: parseFloat(remuneration.MinimumRange) || null,
    salary_max: parseFloat(remuneration.MaximumRange) || null,
    salary_interval: remuneration.RateIntervalCode ?? null,
    description_raw: pos.UserArea?.Details?.MissionCriticalTags?.join(" ") ?? "",
    description_clean: [
      pos.PositionTitle,
      pos.OrganizationName,
      pos.QualificationSummary ?? "",
      (pos.JobCategory ?? []).map((c) => c.Name).join(" "),
    ]
      .filter(Boolean)
      .join("\n"),
    posted_at: pos.PublicationStartDate ?? null,
    url: pos.PositionURI ?? "",
    sector: "government",
    apply_url: pos.ApplyURI?.[0] ?? pos.PositionURI ?? "",
  };
}

async function fetchUSAJobs(config, apiKey, email) {
  const cfg = config.usajobs ?? {};
  const keywords = (cfg.keywords ?? []).join(";");
  const params = new URLSearchParams({
    Keyword: keywords,
    LocationName: cfg.location ?? "",
    Radius: cfg.radius_miles ?? 50,
    RemoteIndicator: cfg.include_remote ? "True" : "False",
    ResultsPerPage: cfg.results_per_page ?? 50,
    Fields: "Min",
  });

  const url = `${BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Host: "data.usajobs.gov",
      "User-Agent": email,
      "Authorization-Key": apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`USAJOBS fetch failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const items = json.SearchResult?.SearchResultItems ?? [];
  return items.map(normalizeJob);
}

module.exports = { fetchUSAJobs };
