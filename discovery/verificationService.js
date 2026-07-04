const { detectAts } = require("./detectAts");
const { normalizeJobSource, nowIso } = require("../registry/companies");
const { isSupportedAts } = require("../adapters/index");

function sourcesMatch(existingSources, detected) {
  if (!existingSources?.length) {
    return (
      existingSources?.ats_type === detected.ats_type &&
      existingSources?.ats_identifier?.toLowerCase() === detected.ats_identifier?.toLowerCase()
    );
  }
  return existingSources.some(
    (source) =>
      source.ats_type === detected.ats_type &&
      source.ats_identifier?.toLowerCase() === detected.ats_identifier?.toLowerCase()
  );
}

async function verifyCompany(company) {
  const careersUrl = company.careers_url ?? company.sources?.[0]?.careers_url;
  if (!careersUrl) {
    const updated = {
      ...company,
      verification_status: "unresolved",
      last_verified: nowIso(),
      notes: `${company.notes ?? ""} Verification failed: no careers URL`.trim(),
    };
    return { company: updated, changed: true, detection: null };
  }

  const detection = await detectAts(careersUrl);
  const ts = nowIso();
  let verification_status = "verified";
  let notes = company.notes ?? "";

  const primaryMismatch =
    detection.ats_type &&
    detection.ats_identifier &&
    (company.ats_type !== detection.ats_type ||
      company.ats_identifier?.toLowerCase() !== detection.ats_identifier?.toLowerCase());

  if (primaryMismatch) {
    verification_status = "manual_review";
    notes = `${notes} ATS changed: ${company.ats_type}/${company.ats_identifier} -> ${detection.ats_type}/${detection.ats_identifier}`.trim();
  } else if ((detection.confidence ?? 0) < 60) {
    verification_status = "stale";
  } else if (!detection.probe_ok) {
    verification_status = "manual_review";
  } else if ((detection.confidence ?? 0) < 85) {
    verification_status = "manual_review";
  }

  const updatedSources = (company.sources ?? []).map((source) => ({
    ...source,
    last_verified: ts,
    probe_ok: source.ats_type === detection.ats_type ? detection.probe_ok : source.probe_ok,
    confidence:
      source.ats_type === detection.ats_type ? detection.confidence : source.confidence,
  }));

  if (!updatedSources.length && detection.ats_type && detection.ats_identifier) {
    updatedSources.push(
      normalizeJobSource({
        ats_type: detection.ats_type,
        ats_identifier: detection.ats_identifier,
        careers_url: detection.careers_url,
        application_url: detection.application_url,
        platform: detection.platform,
        confidence: detection.confidence,
        probe_ok: detection.probe_ok,
        enabled: isSupportedAts(detection.ats_type),
      })
    );
  }

  const updated = {
    ...company,
    ats_type: detection.ats_type ?? company.ats_type,
    ats_identifier: detection.ats_identifier ?? company.ats_identifier,
    careers_url: detection.careers_url ?? company.careers_url,
    application_url: detection.application_url ?? company.application_url,
    platform: detection.platform ?? company.platform,
    discovery_confidence: detection.confidence ?? company.discovery_confidence,
    verification_status,
    last_verified: ts,
    sources: updatedSources,
    notes,
  };

  return {
    company: updated,
    changed:
      verification_status !== company.verification_status ||
      primaryMismatch ||
      updated.discovery_confidence !== company.discovery_confidence,
    detection,
  };
}

async function verifyStale(options = {}) {
  const db = require("../db");
  const maxAgeDays = options.maxAgeDays ?? 30;
  const limit = options.limit ?? 10;

  const stale = db.companies.getStale(maxAgeDays).slice(0, limit);
  const results = [];

  for (const company of stale) {
    const result = await verifyCompany(company);
    db.companies.updateCompany(result.company);
    results.push(result);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 500));
  }

  return results;
}

module.exports = { verifyCompany, verifyStale };
