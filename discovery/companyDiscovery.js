const { detectAllAts, computeConfidence } = require("./detectAts");
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

function detectionToSource(detection, fallbackCareersUrl) {
  return normalizeJobSource({
    ats_type: detection.ats_type,
    ats_identifier: detection.ats_identifier,
    careers_url: detection.source_url ?? detection.careers_url ?? fallbackCareersUrl ?? null,
    application_url: detection.application_url ?? null,
    platform: detection.platform ?? null,
    confidence: detection.confidence ?? null,
    probe_ok: detection.probe_ok === true,
    last_verified: nowIso(),
    enabled: detection.enabled ?? (isSupportedAts(detection.ats_type) && detection.probe_ok === true),
    notes: detection.notes ?? "",
  });
}

function buildEvidencePacket(input, candidates, detections, multiResults = []) {
  const best = detections[0] ?? null;
  const probeResults = {};
  const candidateIdentifiers = [];
  const atsUrls = [];
  const conflicting = [];

  for (const item of detections) {
    const key = `${item.ats_type}:${item.ats_identifier ?? "?"}`;
    probeResults[key] = item.probe_ok === true;
    if (item.ats_identifier) candidateIdentifiers.push(item.ats_identifier);
    if (item.source_url ?? item.careers_url) atsUrls.push(item.source_url ?? item.careers_url);
  }

  const types = new Set(detections.map((item) => item.ats_type).filter(Boolean));
  if (types.size > 1) conflicting.push(`Multiple ATS types: ${[...types].join(", ")}`);
  if (detections.length > 1) {
    conflicting.push(`${detections.length} job boards detected`);
  }

  const embeddedLinks = multiResults.flatMap((result) =>
    (result.sources ?? []).map((source) => source.source_url).filter(Boolean)
  );

  return {
    company_name: input.name ?? best?.name ?? null,
    input_url: buildInputLabel(input),
    final_url: best?.careers_url ?? best?.source_url ?? input.careers_url ?? input.website ?? null,
    page_title: best?.page_title ?? multiResults[0]?.page_title ?? null,
    candidate_careers_links: [...new Set([...candidates, ...embeddedLinks])].slice(0, 10),
    ats_urls: [...new Set(atsUrls)].slice(0, 10),
    script_domains: [],
    candidate_identifiers: [...new Set(candidateIdentifiers)].slice(0, 10),
    probe_results: probeResults,
    conflicting_signals: conflicting,
  };
}

function resolveStatus(confidence, sources) {
  const probed = sources.filter((source) => source.probe_ok);
  const maxConfidence = Math.max(
    confidence,
    ...sources.map((source) => source.confidence ?? 0),
    0
  );

  if (maxConfidence >= 85 && probed.length > 0) return "resolved";
  if (sources.length > 0 && (maxConfidence >= 60 || probed.length > 0)) return "partial";
  if (sources.length > 0) return "needs_review";
  return "failed";
}

function buildDetailText(sources, error) {
  if (sources.length > 1) {
    const ids = sources.map((source) => source.ats_identifier).filter(Boolean);
    return `Found ${ids.join(", ")}`;
  }
  if (sources.length === 1) {
    const source = sources[0];
    if (source.probe_ok) return `Verified ${source.ats_type} board`;
    return source.notes || `Detected ${source.ats_type}/${source.ats_identifier}`;
  }
  return error ?? "No ATS detected";
}

function buildRegistryEntry(input, sources, confidence, status) {
  if (!sources.length) return null;

  const primary = sources[0];
  const probedCount = sources.filter((source) => source.probe_ok).length;
  const notes = [
    input.notes ?? "",
    sources.length > 1
      ? `Federated employer — ${sources.length} job boards (${probedCount} probed OK)`
      : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return normalizeCompany({
    name: input.name ?? "Unknown Company",
    website: input.website ?? null,
    industry: input.industry ?? null,
    headquarters: input.headquarters ?? null,
    ats_type: primary.ats_type,
    ats_identifier: primary.ats_identifier,
    careers_url: primary.careers_url ?? input.careers_url ?? null,
    application_url: primary.application_url,
    platform: primary.platform,
    discovery_confidence: confidence,
    verification_status:
      status === "resolved"
        ? "verified"
        : status === "partial" || status === "needs_review"
          ? "manual_review"
          : "unresolved",
    last_verified: nowIso(),
    preferred: true,
    enabled: sources.some((source) => source.enabled),
    notes,
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
      detail: "No careers URL candidates found",
      evidence: buildEvidencePacket(input, [], []),
      registry_entry: null,
      ai_used: false,
      error: "No careers URL candidates found",
    };
  }

  const multiResults = [];
  const detections = [];

  for (const url of uniqueCandidates) {
    const multi = await detectAllAts(url);
    multiResults.push({ ...multi, candidate_url: url });
    for (const source of multi.sources ?? []) {
      detections.push({
        ...source,
        candidate_url: url,
        name: multi.name,
        page_title: multi.page_title,
      });
    }
    if (detections.some((item) => item.confidence >= 85 && item.probe_ok)) break;
  }

  detections.sort((a, b) => {
    if (a.probe_ok !== b.probe_ok) return a.probe_ok ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const sourceKey = (source) => `${source.ats_type}:${source.ats_identifier.toLowerCase()}`;
  const deduped = new Map();
  for (const detection of detections.filter((item) => item.ats_identifier)) {
    deduped.set(sourceKey(detection), detectionToSource(detection, detection.candidate_url));
  }
  let sources = [...deduped.values()];

  let confidence = detections[0]?.confidence ?? 0;
  let aiUsed = false;
  const evidence = buildEvidencePacket(input, uniqueCandidates, detections, multiResults);

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
  const companyName =
    input.name ?? multiResults.find((item) => item.name)?.name ?? detections[0]?.name ?? null;
  const registryEntry = buildRegistryEntry(
    { ...input, name: companyName },
    sources,
    confidence,
    status
  );
  const error = sources.length
    ? null
    : multiResults.find((item) => item.error)?.error ?? "ATS not detected from candidates";

  return {
    input: label,
    status,
    company_name: companyName,
    website: input.website ?? null,
    careers_url:
      detections[0]?.careers_url ??
      multiResults[0]?.final_url ??
      uniqueCandidates[0] ??
      null,
    sources,
    confidence,
    detail: buildDetailText(sources, error),
    evidence,
    registry_entry: registryEntry,
    ai_used: aiUsed,
    error,
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
