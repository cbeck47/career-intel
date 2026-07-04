const fetch = require("node-fetch");
const { isSupportedAts } = require("../adapters/index");
const { formatOracleIdentifier, parseOracleIdentifier } = require("../registry/companies");
const { parseWorkdayIdentifier } = require("../fetchers/workday");

const USER_AGENT = "CareerIntel/1.0 (ATS discovery)";

function parseUrl(rawUrl) {
  try {
    const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

function extractSiteNumberFromPath(pathname) {
  const match = pathname.match(/\/sites\/([^/]+)/i);
  return match?.[1] ?? null;
}

function extractTenantHostFromHtml(html) {
  const patterns = [
    /https?:\/\/([a-z0-9.-]+\.fa\.[a-z0-9.-]+\.oraclecloud\.com)/i,
    /https?:\/\/([a-z0-9.-]+\.oraclecloud\.com)/i,
    /"hostName"\s*:\s*"([^"]+\.oraclecloud\.com)"/i,
    /"siteUrl"\s*:\s*"https?:\/\/([^"/]+\.oraclecloud\.com)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function icimsIdentifierFromHost(host) {
  const normalized = host.toLowerCase();
  const careersMatch = normalized.match(/^careers-([a-z0-9-]+)\.icims\.com$/);
  if (careersMatch) return careersMatch[1];
  const internalMatch = normalized.match(/^internal-([a-z0-9-]+)\.icims\.com$/);
  if (internalMatch) return internalMatch[1];
  return null;
}

function sourceKey(atsType, identifier) {
  if (!atsType || !identifier) return null;
  return `${atsType}:${identifier.toLowerCase()}`;
}

function detectOracleFromUrl(url) {
  const host = url.hostname.toLowerCase();
  const siteNumber = extractSiteNumberFromPath(url.pathname);

  if (host.includes("oraclecloud.com") && url.pathname.includes("CandidateExperience")) {
    if (!siteNumber) return null;
    return {
      ats_type: "oracle_recruiting_cloud",
      tenantHost: host,
      siteNumber,
      application_url: null,
      directHostMatch: true,
      source_url: url.toString(),
    };
  }

  if (siteNumber && /^CX_/i.test(siteNumber)) {
    return {
      ats_type: "oracle_recruiting_cloud",
      tenantHost: null,
      siteNumber,
      application_url: `${url.protocol}//${url.host}`,
      directHostMatch: false,
      needsTenantFromHtml: true,
      source_url: url.toString(),
    };
  }

  return null;
}

function detectFromUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const segment = path.split("/").filter(Boolean)[0] ?? null;

  const oracle = detectOracleFromUrl(url);
  if (oracle) return oracle;

  if (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") {
    return {
      ats_type: "smartrecruiters",
      ats_identifier: segment,
      directHostMatch: true,
      source_url: url.toString(),
    };
  }

  if (host === "jobs.lever.co") {
    return {
      ats_type: "lever",
      ats_identifier: segment,
      directHostMatch: true,
      source_url: url.toString(),
    };
  }

  if (host === "jobs.ashbyhq.com") {
    return {
      ats_type: "ashby",
      ats_identifier: segment,
      directHostMatch: true,
      source_url: url.toString(),
    };
  }

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    return {
      ats_type: "greenhouse",
      ats_identifier: segment,
      directHostMatch: true,
      source_url: url.toString(),
    };
  }

  if (host.endsWith(".myworkdayjobs.com") || host === "myworkdayjobs.com") {
    const tenant = host.replace(/\.myworkdayjobs\.com$/i, "").toLowerCase();
    const identifier =
      tenant && tenant !== "myworkdayjobs" && segment ? `${tenant}|${segment}` : segment;
    return {
      ats_type: "workday",
      ats_identifier: identifier,
      directHostMatch: true,
      source_url: url.toString(),
    };
  }

  if (host.includes("icims.com")) {
    const icimsId = icimsIdentifierFromHost(host);
    const identifier = icimsId ?? segment;
    return {
      ats_type: "icims",
      ats_identifier: identifier,
      directHostMatch: true,
      source_url: `${url.protocol}//${host}`,
    };
  }

  return null;
}

function detectAllFromHtml(html, pageUrl = null) {
  const text = html ?? "";
  const found = new Map();

  function add(entry) {
    if (!entry?.ats_type) return;
    if (entry.ats_type === "oracle_recruiting_cloud") {
      const key = entry.tenantHost && entry.siteNumber
        ? sourceKey(entry.ats_type, formatOracleIdentifier(entry.tenantHost, entry.siteNumber))
        : sourceKey(entry.ats_type, entry.siteNumber ?? "?");
      if (key && !found.has(key)) found.set(key, entry);
      return;
    }
    if (!entry.ats_identifier) return;
    const key = sourceKey(entry.ats_type, entry.ats_identifier);
    if (key && !found.has(key)) found.set(key, entry);
  }

  const tenantHost = extractTenantHostFromHtml(text);
  const siteMatch = text.match(/siteNumber["\s:=]+(CX_[A-Za-z0-9_]+)/i);
  if (tenantHost && siteMatch?.[1]) {
    add({
      ats_type: "oracle_recruiting_cloud",
      tenantHost,
      siteNumber: siteMatch[1],
      application_url: null,
      directHostMatch: false,
      source_url: pageUrl?.toString?.() ?? null,
    });
  }

  const scanPatterns = [
    {
      ats_type: "greenhouse",
      regex: /boards-api\.greenhouse\.io\/v1\/boards\/([^/"'\s?]+)/gi,
      build: (id) => ({
        ats_identifier: decodeURIComponent(id),
        source_url: `https://boards.greenhouse.io/${id}`,
      }),
    },
    {
      ats_type: "greenhouse",
      regex: /boards\.greenhouse\.io\/([^/"'\s?]+)/gi,
      build: (id) => ({
        ats_identifier: decodeURIComponent(id),
        source_url: `https://boards.greenhouse.io/${id}`,
      }),
    },
    {
      ats_type: "lever",
      regex: /jobs\.lever\.co\/([^/"'\s?]+)/gi,
      build: (id) => ({
        ats_identifier: decodeURIComponent(id),
        source_url: `https://jobs.lever.co/${id}`,
      }),
    },
    {
      ats_type: "ashby",
      regex: /jobs\.ashbyhq\.com\/([^/"'\s?]+)/gi,
      build: (id) => ({
        ats_identifier: decodeURIComponent(id),
        source_url: `https://jobs.ashbyhq.com/${id}`,
      }),
    },
    {
      ats_type: "smartrecruiters",
      regex: /careers\.smartrecruiters\.com\/([^/"'\s?]+)/gi,
      build: (id) => ({
        ats_identifier: decodeURIComponent(id),
        source_url: `https://careers.smartrecruiters.com/${id}`,
      }),
    },
    {
      ats_type: "icims",
      regex: /careers-([a-z0-9-]+)\.icims\.com/gi,
      build: (id) => ({
        ats_identifier: decodeURIComponent(id),
        source_url: `https://careers-${id}.icims.com`,
      }),
    },
    {
      ats_type: "workday",
      regex: /https?:\/\/([a-z0-9-]+)\.myworkdayjobs\.com\/([^/"'\s?#]+)/gi,
      build: (tenant, board) => ({
        ats_identifier: `${tenant}|${board}`,
        source_url: `https://${tenant}.myworkdayjobs.com/${board}`,
      }),
    },
  ];

  for (const pattern of scanPatterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const built = pattern.build(match[1], match[2]);
      add({
        ats_type: pattern.ats_type,
        ...built,
        directHostMatch: false,
      });
    }
  }

  return [...found.values()];
}

function detectFromHtml(html) {
  const all = detectAllFromHtml(html);
  if (!all.length) return null;

  const oracle = all.find((item) => item.ats_type === "oracle_recruiting_cloud");
  if (oracle) {
    return { ...oracle, signalCount: all.length };
  }

  const withId = all.filter((item) => item.ats_identifier);
  if (!withId.length) return null;

  return { ...withId[0], signalCount: all.length };
}

function finalizeOracleDetection(detection, html) {
  if (detection.ats_type !== "oracle_recruiting_cloud") return detection;

  let tenantHost = detection.tenantHost ?? extractTenantHostFromHtml(html);
  const siteNumber = detection.siteNumber;

  if (!tenantHost || !siteNumber) {
    return {
      ...detection,
      ats_identifier: null,
      platform: "Oracle Fusion HCM",
    };
  }

  return {
    ...detection,
    tenantHost,
    ats_identifier: formatOracleIdentifier(tenantHost, siteNumber),
    platform: "Oracle Fusion HCM",
    source_url: detection.source_url ?? `https://${tenantHost}`,
  };
}

function extractPageTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim() ?? null;
}

function guessCompanyName(pageTitle, identifier) {
  if (pageTitle) {
    const cleaned = pageTitle
      .replace(/\s*[|\-–—].*$/, "")
      .replace(/\s+careers.*$/i, "")
      .replace(/\s+global career site.*$/i, "")
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }
  if (identifier && !identifier.includes("|")) {
    return identifier.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "Unknown Company";
}

function resolveKnownOracleTenant(applicationHost, siteNumber) {
  const host = (applicationHost ?? "").toLowerCase();
  if (host.includes("ford.com")) {
    return "efds.fa.em5.oraclecloud.com";
  }
  return null;
}

async function resolveOracleTenant(applicationHost, siteNumber) {
  const candidate = resolveKnownOracleTenant(applicationHost, siteNumber);
  if (!candidate) return null;
  const identifier = formatOracleIdentifier(candidate, siteNumber);
  const ok = await probeOracleApi(identifier);
  return ok ? candidate : null;
}

async function probeOracleApi(identifier) {
  const parsed = parseOracleIdentifier(identifier);
  if (!parsed) return false;

  try {
    const params = new URLSearchParams({
      onlyData: "true",
      finder: `findReqs;siteNumber=${parsed.siteNumber}`,
      limit: "1",
    });
    const url = `https://${parsed.tenantHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return false;
    const json = await res.json();
    const total = json.items?.[0]?.TotalJobsCount ?? 0;
    return total > 0;
  } catch {
    return false;
  }
}

async function probeAtsApi(atsType, identifier) {
  if (!identifier) return false;

  if (atsType === "oracle_recruiting_cloud") {
    return probeOracleApi(identifier);
  }

  if (!isSupportedAts(atsType)) return false;

  try {
    if (atsType === "smartrecruiters") {
      const res = await fetch(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(identifier)}/postings?limit=1`,
        { headers: { "User-Agent": USER_AGENT } }
      );
      return res.ok;
    }
    if (atsType === "greenhouse") {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs`,
        { headers: { "User-Agent": USER_AGENT } }
      );
      return res.ok;
    }
    if (atsType === "lever") {
      for (const base of [
        "https://api.lever.co/v0/postings",
        "https://api.eu.lever.co/v0/postings",
      ]) {
        const res = await fetch(`${base}/${encodeURIComponent(identifier)}?mode=json`, {
          headers: { "User-Agent": USER_AGENT },
        });
        if (res.ok) return true;
      }
      return false;
    }
    if (atsType === "ashby") {
      const res = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identifier)}`,
        { headers: { "User-Agent": USER_AGENT } }
      );
      return res.ok;
    }
    if (atsType === "workday") {
      const parsed = parseWorkdayIdentifier(identifier);
      if (!parsed) return false;
      const { tenant, jobboard } = parsed;
      const res = await fetch(
        `https://${tenant}.myworkdayjobs.com/wday/cxs/${tenant}/${jobboard}/jobs`,
        {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            appliedFacets: {},
            limit: 1,
            offset: 0,
            searchText: "",
          }),
        }
      );
      if (!res.ok) return false;
      const json = await res.json();
      return (json.jobPostings ?? json.jobs ?? []).length > 0;
    }
    if (atsType === "icims") {
      const res = await fetch(
        `https://careers-${encodeURIComponent(identifier)}.icims.com/jobs/search?ss=1&searchRelation=keyword_all&output=json`,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
      );
      if (!res.ok) return false;
      const json = await res.json();
      const jobs = Array.isArray(json) ? json : json?.jobs ?? json?.results ?? [];
      return jobs.length > 0;
    }
  } catch {
    return false;
  }

  return false;
}

function computeConfidence({
  ats_type,
  ats_identifier,
  directHostMatch,
  probeOk,
  pageTitle,
  companyName,
  redirectCount,
  signalCount,
  aiVerified,
  aiFailed,
  adjustment = 0,
}) {
  if (!ats_type) return 0;

  let score = 0;

  if (directHostMatch) score += 40;
  else if (ats_type) score += 20;

  if (ats_identifier?.includes("|")) score += 20;
  else if (ats_identifier && !/[?#]/.test(ats_identifier) && ats_identifier.length >= 2) {
    score += 20;
  }

  if (probeOk) score += 30;
  else if (probeOk === false) score -= 25;

  if (pageTitle && companyName) {
    const title = pageTitle.toLowerCase();
    const name = companyName.toLowerCase();
    if (title.includes(name.split(" ")[0])) score += 10;
  }

  if (aiVerified) score += 15;
  if (aiFailed) score -= 20;

  if (redirectCount > 2) score -= 10;
  if (signalCount > 3) score -= 15;

  score += adjustment;

  return Math.max(0, Math.min(100, score));
}

function buildSourceNotes(atsType, probeOk) {
  if (!isSupportedAts(atsType)) return "Detected but fetch adapter unavailable";
  if (probeOk) return "";
  return "Probe failed — verify identifier manually";
}

async function finalizeAndProbeDetection(rawDetection, context) {
  let detection = { ...rawDetection };
  if (detection.ats_type === "oracle_recruiting_cloud") {
    detection = finalizeOracleDetection(detection, context.html ?? "");
  }
  if (!detection.ats_type || !detection.ats_identifier) return null;

  const probeOk = await probeAtsApi(detection.ats_type, detection.ats_identifier);
  const confidence = computeConfidence({
    ats_type: detection.ats_type,
    ats_identifier: detection.ats_identifier,
    directHostMatch: detection.directHostMatch === true,
    probeOk,
    pageTitle: context.pageTitle,
    companyName: context.companyName,
    redirectCount: context.redirectCount ?? 0,
    signalCount: context.signalCount ?? 1,
  });

  const careersUrl = detection.source_url ?? context.finalUrl?.toString?.() ?? null;

  return {
    ats_type: detection.ats_type,
    ats_identifier: detection.ats_identifier,
    source_url: detection.source_url ?? careersUrl,
    careers_url: careersUrl,
    application_url: detection.application_url ?? null,
    platform: detection.platform ?? null,
    confidence,
    probe_ok: probeOk,
    supported: isSupportedAts(detection.ats_type),
    enabled: isSupportedAts(detection.ats_type) && probeOk,
    directHostMatch: detection.directHostMatch === true,
    notes: buildSourceNotes(detection.ats_type, probeOk),
  };
}

async function detectAllAts(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) {
    return { error: "Invalid URL", confidence: 0, sources: [] };
  }

  let finalUrl = parsed;
  let html = "";
  let redirectCount = 0;

  try {
    const res = await fetch(parsed.toString(), {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
    });
    finalUrl = new URL(res.url);
    redirectCount = res.redirected ? 1 : 0;
    html = await res.text();
  } catch (err) {
    const urlHint = detectFromUrl(parsed);
    if (urlHint?.ats_type === "oracle_recruiting_cloud" && urlHint.siteNumber) {
      const tenantHost =
        urlHint.tenantHost ??
        (await resolveOracleTenant(parsed.hostname, urlHint.siteNumber));
      if (tenantHost) {
        const probed = await finalizeAndProbeDetection(
          {
            ...urlHint,
            tenantHost,
            application_url: urlHint.application_url ?? `${parsed.protocol}//${parsed.host}`,
          },
          {
            html: "",
            pageTitle: null,
            companyName: guessCompanyName(null, urlHint.siteNumber),
            redirectCount: 0,
            signalCount: 1,
            finalUrl: parsed,
          }
        );
        return {
          input_url: parsed.toString(),
          final_url: parsed.toString(),
          page_title: null,
          name: guessCompanyName(null, probed?.ats_identifier),
          sources: probed ? [probed] : [],
          confidence: probed?.confidence ?? 0,
        };
      }
    }
    return { error: `Could not fetch URL: ${err.message}`, confidence: 0, sources: [] };
  }

  const pageTitle = extractPageTitle(html);
  const rawDetections = [];
  const urlDetection = detectFromUrl(finalUrl);
  if (urlDetection) rawDetections.push(urlDetection);
  rawDetections.push(...detectAllFromHtml(html, finalUrl));

  const dedupedRaw = new Map();
  for (const item of rawDetections) {
    if (item.ats_type === "oracle_recruiting_cloud") {
      const key = item.tenantHost && item.siteNumber
        ? sourceKey(item.ats_type, formatOracleIdentifier(item.tenantHost, item.siteNumber))
        : sourceKey(item.ats_type, item.siteNumber ?? "?");
      if (key) dedupedRaw.set(key, item);
      continue;
    }
    const key = sourceKey(item.ats_type, item.ats_identifier);
    if (key) dedupedRaw.set(key, item);
  }

  const companyName = guessCompanyName(pageTitle, [...dedupedRaw.values()][0]?.ats_identifier);
  const signalCount = dedupedRaw.size;
  const sources = [];

  for (const raw of dedupedRaw.values()) {
    const probed = await finalizeAndProbeDetection(raw, {
      html,
      pageTitle,
      companyName,
      redirectCount,
      signalCount,
      finalUrl,
    });
    if (probed) sources.push(probed);
  }

  sources.sort((a, b) => {
    if (a.probe_ok !== b.probe_ok) return a.probe_ok ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const confidence = sources[0]?.confidence ?? 0;

  return {
    input_url: parsed.toString(),
    final_url: finalUrl.toString(),
    page_title: pageTitle,
    name: companyName,
    sources,
    confidence,
    error: sources.length ? null : "Could not detect ATS from URL or page content",
  };
}

async function detectAts(rawUrl) {
  const multi = await detectAllAts(rawUrl);
  if (multi.error && !multi.sources?.length) {
    return {
      error: multi.error,
      confidence: 0,
      careers_url: multi.final_url ?? rawUrl,
    };
  }

  const best = multi.sources?.[0];
  if (!best) {
    return {
      careers_url: multi.final_url ?? rawUrl,
      ats_type: "unknown",
      ats_identifier: null,
      confidence: 0,
      supported: false,
      error: multi.error ?? "Could not detect ATS from URL or page content",
    };
  }

  return {
    name: multi.name,
    careers_url: multi.final_url ?? best.careers_url,
    application_url: best.application_url,
    platform: best.platform,
    ats_type: best.ats_type,
    ats_identifier: best.ats_identifier,
    confidence: best.confidence,
    supported: best.supported,
    probe_ok: best.probe_ok,
    page_title: multi.page_title,
    sources: multi.sources,
  };
}

module.exports = {
  detectAts,
  detectAllAts,
  detectAllFromHtml,
  probeAtsApi,
  computeConfidence,
};
