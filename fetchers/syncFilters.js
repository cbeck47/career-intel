const DEFAULT_LOCATION_KEYWORDS = [
  "mi",
  "remote",
  "detroit",
  "warren",
  "pontiac",
  "ann arbor",
];

const DEFAULT_TITLE_KEYWORDS = [
  "software",
  "engineering",
  "manager",
  "platform",
  "program",
  "devops",
  "quality",
  "systems",
];

function resolveSyncFilterConfig(options = {}) {
  const syncFilters = options.syncFilters ?? {};
  const srCfg = options.smartrecruitersConfig ?? {};

  return {
    enabled: syncFilters.enabled === true,
    locationKeywords:
      syncFilters.location_keywords ??
      srCfg.detail_location_keywords ??
      DEFAULT_LOCATION_KEYWORDS,
    titleKeywords:
      syncFilters.title_keywords ??
      srCfg.detail_title_keywords ??
      DEFAULT_TITLE_KEYWORDS,
  };
}

function jobMatchesLocationFilter(job, keywords) {
  if (job.remote === true) return true;
  const text = `${job.location ?? ""} ${job.title ?? ""}`.toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function jobMatchesTitleFilter(job, keywords) {
  const title = (job.title ?? "").toLowerCase();
  return keywords.some((keyword) => title.includes(keyword.toLowerCase()));
}

function jobMatchesSyncFilters(job, options = {}) {
  const config = resolveSyncFilterConfig(options);
  if (!config.enabled) return true;
  return (
    jobMatchesLocationFilter(job, config.locationKeywords) &&
    jobMatchesTitleFilter(job, config.titleKeywords)
  );
}

function getDetailFilterKeywords(options = {}) {
  const config = resolveSyncFilterConfig(options);
  return {
    detailLocationKeywords: config.locationKeywords,
    detailTitleKeywords: config.titleKeywords,
  };
}

module.exports = {
  resolveSyncFilterConfig,
  jobMatchesSyncFilters,
  jobMatchesLocationFilter,
  jobMatchesTitleFilter,
  getDetailFilterKeywords,
  DEFAULT_LOCATION_KEYWORDS,
  DEFAULT_TITLE_KEYWORDS,
};
