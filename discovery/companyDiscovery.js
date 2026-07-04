const { detectAts, probeAtsApi, computeConfidence } = require("./detectAts");
const { resolveCareersCandidates } = require("./websiteResolver");
const { interpretEvidence } = require("./aiEvidenceInterpreter");
const { normalizeCompany, normalizeJobSource, nowIso } = require("../registry/companies");
const { isSupportedAts } = require("../adapters/index");

function buildInputLabel(input) {
  if (input.careers_url) return input.careers_url;
  if (input.website) return input.website;
  if (input.name) return input.name;
  return "unknown";
}

function detectionToSource(detection, careersUrl) {
  return normalizeJobSource({
    ats_type: detection.ats_type,
    ats_identifier: detection.ats_identifier,
    careers_url: careersUrl ?? detection.careers_url ?? null,
    application_url: detection.application_url ?? null,
    platform: detection.platform ?? null,
    confidence: detection.confidence ?? null,
    probe_ok: detection.probe_ok === true,
    last_verified: nowIso(),
    enabled: isSupportedAts(detection.ats_type),
    notes: isSupportedAts(detection.ats_type) ? "" : "Detected but fetch adapter unavailable",
  });
}

function buildEvidencePacket(input, candidates, detections) {
  const best = detections[0] ?? null;
  const probeResults = {};
  const candidateIdentifiers = [];
  const atsUrls = [];
  const conflicting = [];

  for (const item of detections) {
    const key = `${item.ats_type}:${item.ats_identifier ?? "?"}`;
    probeResults[key] = item.probe_ok === true;
    if (item.ats_identifier) candidateIdentifiers.push(item.ats_identifier);
    if (item.careers_url) atsUrls.push(item.careers_url);
  }

  const types = new Set(detections.map((item) => item.ats_type).filter(Boolean));
  if (types.size > 1) conflicting.push(`Multiple ATS types: ${[...types].join(", ")}`);

  return {
    company_name: input.name ?? best?.name ?? null,
    input_url: buildInputLabel(input),
    final_url: best?.careers_url ?? input.careers_url ?? input.website ?? null,
    page_title: best?.page_title ?? null,
    candidate_careers_links: candidates.slice(0, 10),
    ats_urls: [...new Set(atsUrls)].slice(0, 10),
    script_domains: [],
    candidate_identifiers: [...new Set(candidateIdentifiers)].slice(0, 10),
    probe_results: probeResults,
    conflicting_signals: conflicting,
  };
}

function resolveStatus(confidence, sources) {
  if (confidence >= 85 && sources.length > 0) return "resolved";
  if (confidence >= 60) return "partial";
  if (sources.length > 0) return "needs_review";
  return "failed";
}

function buildRegistryEntry(input, sources, confidence, status) {
  if (!sources.length) return null;

  const primary = sources[0];

  return normalizeCompany({
    name: input.name ?? "Unknown Company",
    website: input.website ?? null,
    industry: input.industry ?? null,
    headquarters: input.headquarters ?? null,
    ats_type: primary.ats_type,
    ats_identifier: primary.ats_identifier,
    careers_url: primary.careers_url,
    application_url: primary.application_url,
    platform: primary.platform,
    discovery_confidence: confidence,
    verification_status:
      status === "resolved"
        ? "verified"
        : status === "partial"
          ? "manual_review"
          : status === "needs_review"
            ? "manual_review"
            : "unresolved",
    last_verified: nowIso(),
    preferred: true,
    enabled: sources.some((source) => source.enabled),
    notes: input.notes ?? "",
    sources,
  });
}

async function discoverCompany(input = {}, options = {}) {
  const aiJson = options.aiJson ?? null;
  const label = buildInputLabel(input);
  const candidates = input.careers_url
    ? [input.careers_url, ...(await resolveCareersCandidates(input))]
    : await resolveCareersCandidates(input);

  const uniqueCandidates = [...new Set(candidates)].slice(0, 12);
  if (!uniqueCandidates.length) {
    return {
      input: label,
      status: "failed",
      company_name: input.name ?? null,
      website: input.website ?? null,
      careers_url: null,
      sources: [],
      confidence: 0,
      evidence: buildEvidencePacket(input, [], []),
      registry_entry: null,
      ai_used: false,
      error: "No careers URL candidates found",
    };
  }

  const detections = [];
  for (const url of uniqueCandidates) {
    const result = await detectAts(url);
    if (result.ats_type && result.ats_type !== "unknown") {
      detections.push({ ...result, candidate_url: url });
    }
    if (result.confidence >= 85) break;
  }

  detections.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  let sources = detections
    .filter((item) => item.ats_identifier)
    .map((item) => detectionToSource(item, item.candidate_url ?? item.careers_url));

  const sourceKey = (source) => `${source.ats_type}:${source.ats_identifier.toLowerCase()}`;
  const deduped = new Map();
  for (const source of sources) deduped.set(sourceKey(source), source);
  sources = [...deduped.values()];

  let confidence = detections[0]?.confidence ?? 0;
  let aiUsed = false;
  const evidence = buildEvidencePacket(input, uniqueCandidates, detections);

  const evidenceHasSignals =
    evidence.candidate_careers_links.length > 0 ||
    evidence.ats_urls.length > 0 ||
    evidence.final_url != null;

  if (confidence < 85 && evidenceHasSignals && aiJson && process.env.OPENAI_API_KEY) {
    const aiResult = await interpretEvidence(evidence, aiJson);
    aiUsed = aiResult.used;

    if (aiResult.hypothesis) {
      const adjustment = aiResult.hypothesis.confidence_adjustment ?? 0;
      if (aiResult.primaryProbeOk) {
        const aiSource = normalizeJobSource({
          ats_type: aiResult.hypothesis.ats_type,
          ats_identifier: aiResult.hypothesis.identifier,
          careers_url: detections[0]?.careers_url ?? uniqueCandidates[0],
          confidence,
          probe_ok: true,
          enabled: isSupportedAts(aiResult.hypothesis.ats_type),
        });
        deduped.set(sourceKey(aiSource), aiSource);
        for (const verified of aiResult.verifiedSources.slice(1)) {
          const extra = normalizeJobSource({
            ats_type: verified.ats_type,
            ats_identifier: verified.identifier,
            careers_url: detections[0]?.careers_url ?? uniqueCandidates[0],
            probe_ok: true,
            enabled: isSupportedAts(verified.ats_type),
          });
          deduped.set(sourceKey(extra), extra);
        }
        sources = [...deduped.values()];
        confidence = computeConfidence({
          ats_type: aiResult.hypothesis.ats_type,
          ats_identifier: aiResult.hypothesis.identifier,
          directHostMatch: false,
          probeOk: true,
          pageTitle: evidence.page_title,
          companyName: evidence.company_name,
          redirectCount: 0,
          signalCount: detections.length,
          aiVerified: true,
          adjustment,
        });
      } else {
        confidence = computeConfidence({
          ats_type: aiResult.hypothesis.ats_type,
          ats_identifier: aiResult.hypothesis.identifier,
          directHostMatch: false,
          probeOk: false,
          pageTitle: evidence.page_title,
          companyName: evidence.company_name,
          redirectCount: 0,
          signalCount: detections.length,
          aiFailed: true,
          adjustment,
        });
      }
    } else if (aiResult.error) {
      evidence.ai_error = aiResult.error;
    }
  }

  const status = resolveStatus(confidence, sources);
  const companyName = input.name ?? detections[0]?.name ?? null;
  const registryEntry = buildRegistryEntry(
    { ...input, name: companyName },
    sources,
    confidence,
    status
  );

  return {
    input: label,
    status,
    company_name: companyName,
    website: input.website ?? null,
    careers_url: detections[0]?.careers_url ?? uniqueCandidates[0] ?? null,
    sources,
    confidence,
    evidence,
    registry_entry: status === "resolved" ? registryEntry : registryEntry,
    ai_used: aiUsed,
    error: detections.length ? null : "ATS not detected from candidates",
  };
}

async function discoverCompanies(inputs = [], options = {}) {
  const results = [];
  for (const input of inputs) {
    results.push(await discoverCompany(input, options));
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 400));
  }
  return results;
}

module.exports = { discoverCompany, discoverCompanies };
