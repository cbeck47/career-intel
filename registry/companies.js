const crypto = require("crypto");

const CAREERS_URL_PATTERNS = {
  greenhouse: (slug) => `https://boards.greenhouse.io/${slug}`,
  lever: (slug) => `https://jobs.lever.co/${slug}`,
  ashby: (slug) => `https://jobs.ashbyhq.com/${slug}`,
  smartrecruiters: (slug) => `https://careers.smartrecruiters.com/${slug}`,
};

function slugToName(slug) {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function newCompanyId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeJobSource(input) {
  const ts = nowIso();
  return {
    ats_type: input.ats_type,
    ats_identifier: (input.ats_identifier ?? "").trim(),
    careers_url: (input.careers_url ?? "").trim() || null,
    application_url: (input.application_url ?? "").trim() || null,
    platform: input.platform?.trim() || null,
    confidence: input.confidence ?? null,
    probe_ok: input.probe_ok === true,
    last_verified: input.last_verified ?? ts,
    enabled: input.enabled !== false,
    notes: input.notes?.trim() || "",
  };
}

function normalizeCompany(input) {
  const ts = nowIso();
  const sources = Array.isArray(input.sources)
    ? input.sources.map(normalizeJobSource)
    : [];
  return {
    id: input.id ?? newCompanyId(),
    name: (input.name ?? "").trim() || slugToName(input.ats_identifier ?? ""),
    website: input.website?.trim() || null,
    industry: input.industry?.trim() || null,
    headquarters: input.headquarters?.trim() || null,
    preferred: input.preferred !== false,
    enabled: input.enabled !== false,
    ats_type: input.ats_type,
    ats_identifier: (input.ats_identifier ?? "").trim(),
    careers_url: (input.careers_url ?? "").trim() || null,
    application_url: (input.application_url ?? "").trim() || null,
    platform: input.platform?.trim() || null,
    discovery_confidence: input.discovery_confidence ?? null,
    verification_status: input.verification_status ?? null,
    last_verified: input.last_verified ?? null,
    added_at: input.added_at ?? ts,
    notes: input.notes?.trim() || "",
    sources,
  };
}

function getEffectiveJobSources(company) {
  const enabledSources = (company.sources ?? []).filter((source) => source.enabled !== false);
  if (enabledSources.length > 0) return enabledSources;
  if (company.ats_type && company.ats_identifier) {
    return [
      {
        ats_type: company.ats_type,
        ats_identifier: company.ats_identifier,
        careers_url: company.careers_url ?? null,
        application_url: company.application_url ?? null,
        platform: company.platform ?? null,
        enabled: true,
      },
    ];
  }
  return [];
}

function companyHasSyncSources(company) {
  return company.enabled && getEffectiveJobSources(company).length > 0;
}

function buildMigrationEntry(atsType, slug) {
  const careersUrlFn = CAREERS_URL_PATTERNS[atsType];
  const ts = nowIso();
  return normalizeCompany({
    name: slugToName(slug),
    ats_type: atsType,
    ats_identifier: slug,
    careers_url: careersUrlFn ? careersUrlFn(slug) : null,
    discovery_confidence: 100,
    last_verified: ts,
    added_at: ts,
    notes: "Migrated from config.json",
  });
}

const MIGRATION_DEFAULTS = {
  greenhouse: ["stripe", "airbnb", "coinbase", "brex", "figma"],
  lever: ["palantir", "spotify", "shieldai", "gopuff"],
  ashby: ["anthropic", "openai", "linear", "vercel", "notion"],
  smartrecruiters: [],
};

function migrateFromConfig(config) {
  const entries = [];
  const seen = new Set();

  const sources = [
    ["greenhouse", config.greenhouse_companies ?? MIGRATION_DEFAULTS.greenhouse],
    ["lever", config.lever_companies ?? MIGRATION_DEFAULTS.lever],
    ["ashby", config.ashby_companies ?? MIGRATION_DEFAULTS.ashby],
    ["smartrecruiters", config.smartrecruiters_companies ?? MIGRATION_DEFAULTS.smartrecruiters],
  ];

  for (const [atsType, slugs] of sources) {
    for (const slug of slugs) {
      if (!slug?.trim()) continue;
      const key = `${atsType}:${slug.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(buildMigrationEntry(atsType, slug.trim()));
    }
  }

  return entries;
}

function parseOracleIdentifier(identifier) {
  if (!identifier?.includes("|")) return null;
  const [tenantHost, siteNumber] = identifier.split("|").map((part) => part.trim());
  if (!tenantHost || !siteNumber) return null;
  return { tenantHost, siteNumber };
}

function formatOracleIdentifier(tenantHost, siteNumber) {
  return `${tenantHost}|${siteNumber}`;
}

function sourceKey(source) {
  if (!source?.ats_type || !source?.ats_identifier) return null;
  return `${source.ats_type}:${source.ats_identifier.toLowerCase()}`;
}

function companyPrimaryKey(company) {
  return sourceKey(company) ?? sourceKey(company.sources?.[0]);
}

function mergeCompanies(existing, incoming) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byKey = new Map();

  for (const company of existing) {
    const key = companyPrimaryKey(company);
    if (key) byKey.set(key, company);
    for (const source of company.sources ?? []) {
      const sourceLookupKey = sourceKey(source);
      if (sourceLookupKey) byKey.set(sourceLookupKey, company);
    }
  }

  for (const raw of incoming) {
    const company = normalizeCompany(raw);
    const primaryKey = companyPrimaryKey(company);

    if (!primaryKey && !company.id) continue;

    const prev =
      (company.id ? byId.get(company.id) : null) ??
      (primaryKey ? byKey.get(primaryKey) : null) ??
      (company.sources?.[0] ? byKey.get(sourceKey(company.sources[0])) : null);

    if (prev) {
      const merged = {
        ...prev,
        ...company,
        id: prev.id,
        added_at: prev.added_at,
        sources: company.sources?.length ? company.sources : prev.sources,
      };
      byId.set(merged.id, merged);
      const mergedKey = companyPrimaryKey(merged);
      if (mergedKey) byKey.set(mergedKey, merged);
      for (const source of merged.sources ?? []) {
        const sourceLookupKey = sourceKey(source);
        if (sourceLookupKey) byKey.set(sourceLookupKey, merged);
      }
      continue;
    }

    if (company.careers_url) {
      const urlMatch = [...byId.values()].find(
        (c) => c.careers_url && c.careers_url === company.careers_url
      );
      if (urlMatch) {
        const merged = {
          ...urlMatch,
          ...company,
          id: urlMatch.id,
          added_at: urlMatch.added_at,
          sources: company.sources?.length ? company.sources : urlMatch.sources,
        };
        byId.set(merged.id, merged);
        const mergedKey = companyPrimaryKey(merged);
        if (mergedKey) byKey.set(mergedKey, merged);
        for (const source of merged.sources ?? []) {
          const sourceLookupKey = sourceKey(source);
          if (sourceLookupKey) byKey.set(sourceLookupKey, merged);
        }
        continue;
      }
    }

    byId.set(company.id, company);
    if (primaryKey) byKey.set(primaryKey, company);
    for (const source of company.sources ?? []) {
      const sourceLookupKey = sourceKey(source);
      if (sourceLookupKey) byKey.set(sourceLookupKey, company);
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  normalizeCompany,
  normalizeJobSource,
  getEffectiveJobSources,
  companyHasSyncSources,
  migrateFromConfig,
  mergeCompanies,
  parseOracleIdentifier,
  formatOracleIdentifier,
  slugToName,
  newCompanyId,
  nowIso,
};
