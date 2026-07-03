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

function normalizeCompany(input) {
  const ts = nowIso();
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
    last_verified: input.last_verified ?? null,
    added_at: input.added_at ?? ts,
    notes: input.notes?.trim() || "",
  };
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

function mergeCompanies(existing, incoming) {
  const byKey = new Map(
    existing.map((c) => [`${c.ats_type}:${c.ats_identifier.toLowerCase()}`, c])
  );

  for (const raw of incoming) {
    const company = normalizeCompany(raw);
    if (!company.ats_type || !company.ats_identifier) continue;

    const key = `${company.ats_type}:${company.ats_identifier.toLowerCase()}`;
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        ...prev,
        ...company,
        id: prev.id,
        added_at: prev.added_at,
      });
      continue;
    }

    if (company.careers_url) {
      const urlMatch = [...byKey.values()].find(
        (c) => c.careers_url && c.careers_url === company.careers_url
      );
      if (urlMatch) {
        byKey.set(`${urlMatch.ats_type}:${urlMatch.ats_identifier.toLowerCase()}`, {
          ...urlMatch,
          ...company,
          id: urlMatch.id,
          added_at: urlMatch.added_at,
        });
        continue;
      }
    }

    byKey.set(key, company);
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  normalizeCompany,
  migrateFromConfig,
  mergeCompanies,
  parseOracleIdentifier,
  formatOracleIdentifier,
  slugToName,
  newCompanyId,
};
