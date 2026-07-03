const { fetchGreenhouse } = require("../fetchers/greenhouse");
const { fetchLever } = require("../fetchers/lever");
const { fetchAshby } = require("../fetchers/ashby");
const { fetchSmartRecruiters } = require("../fetchers/smartrecruiters");
const { fetchOracleRecruiting } = require("../fetchers/oracleRecruiting");

const SUPPORTED_ATS = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "oracle_recruiting_cloud",
]);

function applyDisplayName(jobs, displayName) {
  if (!displayName) return jobs;
  return jobs.map((job) => ({ ...job, company: displayName }));
}

function buildAdapterOptions(opts = {}) {
  return {
    displayName: opts.displayName,
    syncFilters: opts.syncFilters,
    smartrecruitersConfig: opts.smartrecruitersConfig,
    detailLocationKeywords: opts.detailLocationKeywords,
    detailTitleKeywords: opts.detailTitleKeywords,
    applicationUrl: opts.applicationUrl,
    locale: opts.locale ?? "en",
  };
}

const ADAPTERS = {
  greenhouse: {
    async fetch(identifier, opts = {}) {
      const jobs = await fetchGreenhouse([identifier]);
      return applyDisplayName(jobs, opts.displayName);
    },
  },
  lever: {
    async fetch(identifier, opts = {}) {
      const jobs = await fetchLever([identifier]);
      return applyDisplayName(jobs, opts.displayName);
    },
  },
  ashby: {
    async fetch(identifier, opts = {}) {
      const jobs = await fetchAshby([identifier]);
      return applyDisplayName(jobs, opts.displayName);
    },
  },
  smartrecruiters: {
    async fetch(identifier, opts = {}) {
      const jobs = await fetchSmartRecruiters([identifier], buildAdapterOptions(opts));
      return applyDisplayName(jobs, opts.displayName);
    },
  },
  oracle_recruiting_cloud: {
    async fetch(identifier, opts = {}) {
      const jobs = await fetchOracleRecruiting(identifier, buildAdapterOptions(opts));
      return applyDisplayName(jobs, opts.displayName);
    },
  },
};

function getAdapter(atsType) {
  return ADAPTERS[atsType] ?? null;
}

function isSupportedAts(atsType) {
  return SUPPORTED_ATS.has(atsType);
}

module.exports = { getAdapter, isSupportedAts, SUPPORTED_ATS };
