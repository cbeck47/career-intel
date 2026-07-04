const { z } = require("zod");
const { probeAtsApi } = require("./detectAts");

const evidenceInterpretationSchema = z.object({
  ats_type: z.string(),
  identifier: z.string(),
  confidence_adjustment: z.number().min(-30).max(20),
  additional_sources: z
    .array(
      z.object({
        ats_type: z.string(),
        identifier: z.string(),
      })
    )
    .max(3)
    .optional()
    .default([]),
  recommend_manual_review: z.boolean(),
  reasoning: z.string(),
});

const SYSTEM_PROMPT = `You are an ATS discovery assistant. Given compressed evidence about a company careers page, return JSON with:
{
  "ats_type": string,
  "identifier": string,
  "confidence_adjustment": number (-30 to 20),
  "additional_sources": [{ "ats_type": string, "identifier": string }],
  "recommend_manual_review": boolean,
  "reasoning": string
}
Use only the evidence provided. Do not invent identifiers. Prefer probe_results=true candidates.`;

async function interpretEvidence(evidence, aiJson) {
  if (!aiJson) {
    return { used: false, hypothesis: null, verifiedSources: [], error: "AI not configured" };
  }

  const userPrompt = JSON.stringify(evidence, null, 2);

  let hypothesis;
  try {
    hypothesis = await aiJson(SYSTEM_PROMPT, userPrompt, "gpt-4o-mini", evidenceInterpretationSchema);
  } catch (err) {
    return { used: true, hypothesis: null, verifiedSources: [], error: err.message };
  }

  const verifiedSources = [];
  const primaryOk = await probeAtsApi(hypothesis.ats_type, hypothesis.identifier);
  if (primaryOk) {
    verifiedSources.push({
      ats_type: hypothesis.ats_type,
      identifier: hypothesis.identifier,
      probe_ok: true,
      confidence_adjustment: hypothesis.confidence_adjustment,
    });
  }

  for (const extra of hypothesis.additional_sources ?? []) {
    const ok = await probeAtsApi(extra.ats_type, extra.identifier);
    if (ok) {
      verifiedSources.push({
        ats_type: extra.ats_type,
        identifier: extra.identifier,
        probe_ok: true,
        confidence_adjustment: 0,
      });
    }
  }

  return {
    used: true,
    hypothesis,
    verifiedSources,
    primaryProbeOk: primaryOk,
    error: null,
  };
}

module.exports = { interpretEvidence, evidenceInterpretationSchema };
