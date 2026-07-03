const fetch = require("node-fetch");
const { isSupportedAts } = require("../adapters/index");
const { formatOracleIdentifier, parseOracleIdentifier } = require("../registry/companies");

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
    return { ats_type: "smartrecruiters", ats_identifier: segment, directHostMatch: true };
  }

  if (host === "jobs.lever.co") {
    return { ats_type: "lever", ats_identifier: segment, directHostMatch: true };
  }

  if (host === "jobs.ashbyhq.com") {
    return { ats_type: "ashby", ats_identifier: segment, directHostMatch: true };
  }

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    return { ats_type: "greenhouse", ats_identifier: segment, directHostMatch: true };
  }

  if (host.endsWith(".myworkdayjobs.com") || host === "myworkdayjobs.com") {
    return { ats_type: "workday", ats_identifier: segment, directHostMatch: true };
  }

  if (host.includes("icims.com")) {
    const subdomain = host.split(".")[0];
    const identifier =
      subdomain && subdomain !== "www" && subdomain !== "careers" ? subdomain : segment;
    return { ats_type: "icims", ats_identifier: identifier, directHostMatch: true };
  }

  return null;
}

function detectFromHtml(html) {
  const signals = [];
  const text = html ?? "";

  const tenantHost = extractTenantHostFromHtml(text);
  const siteMatch = text.match(/siteNumber["\s:=]+(CX_[A-Za-z0-9_]+)/i);
  if (tenantHost && siteMatch?.[1]) {
    return {
      ats_type: "oracle_recruiting_cloud",
      tenantHost,
      siteNumber: siteMatch[1],
      application_url: null,
      directHostMatch: false,
      signalCount: 2,
    };
  }

  const patterns = [
    { ats_type: "greenhouse", regex: /boards-api\.greenhouse\.io\/v1\/boards\/([^/"'\s?]+)/i },
    { ats_type: "greenhouse", regex: /boards\.greenhouse\.io\/([^/"'\s?]+)/i },
    { ats_type: "lever", regex: /jobs\.lever\.co\/([^/"'\s?]+)/i },
    { ats_type: "lever", regex: /api\.lever\.co\/v0\/postings\/([^/"'\s?]+)/i },
    { ats_type: "ashby", regex: /jobs\.ashbyhq\.com\/([^/"'\s?]+)/i },
    { ats_type: "ashby", regex: /api\.ashbyhq\.com\/posting-api\/job-board\/([^/"'\s?]+)/i },
    { ats_type: "smartrecruiters", regex: /api\.smartrecruiters\.com\/v1\/companies\/([^/"'\s?]+)/i },
    { ats_type: "smartrecruiters", regex: /careers\.smartrecruiters\.com\/([^/"'\s?]+)/i },
    { ats_type: "workday", regex: /([a-z0-9-]+)\.myworkdayjobs\.com/i },
    { ats_type: "icims", regex: /careers-([a-z0-9-]+)\.icims\.com/i },
    { ats_type: "icims", regex: /icims\.com/i },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match?.[1]) {
      signals.push({
        ats_type: pattern.ats_type,
        ats_identifier: decodeURIComponent(match[1]),
      });
    } else if (match && pattern.ats_type === "icims" && !match[1]) {
      signals.push({ ats_type: "icims", ats_identifier: null });
    }
  }

  if (!signals.length) return null;

  const counts = {};
  for (const signal of signals) {
    counts[signal.ats_type] = (counts[signal.ats_type] ?? 0) + 1;
  }

  const topType = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const topSignals = signals.filter((s) => s.ats_type === topType && s.ats_identifier);
  return {
    ats_type: topType,
    ats_identifier: topSignals[0]?.ats_identifier ?? null,
    directHostMatch: false,
    signalCount: signals.length,
  };
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

  if (pageTitle && companyName) {
    const title = pageTitle.toLowerCase();
    const name = companyName.toLowerCase();
    if (title.includes(name.split(" ")[0])) score += 10;
  }

  if (redirectCount > 2) score -= 10;
  if (signalCount > 3) score -= 15;

  return Math.max(0, Math.min(100, score));
}

async function detectAts(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) {
    return { error: "Invalid URL", confidence: 0 };
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
        const detection = finalizeOracleDetection(
          {
            ...urlHint,
            tenantHost,
            application_url: urlHint.application_url ?? `${parsed.protocol}//${parsed.host}`,
          },
          ""
        );
        const probeOk = await probeAtsApi(detection.ats_type, detection.ats_identifier);
        const companyName = guessCompanyName(null, detection.ats_identifier);
        const confidence = computeConfidence({
          ats_type: detection.ats_type,
          ats_identifier: detection.ats_identifier,
          directHostMatch: false,
          probeOk,
          pageTitle: null,
          companyName,
          redirectCount: 0,
          signalCount: 1,
        });
        return {
          name: companyName,
          careers_url: parsed.toString(),
          application_url: detection.application_url,
          platform: detection.platform,
          ats_type: detection.ats_type,
          ats_identifier: detection.ats_identifier,
          confidence,
          supported: isSupportedAts(detection.ats_type),
          probe_ok: probeOk,
          page_title: null,
        };
      }
    }
    return { error: `Could not fetch URL: ${err.message}`, confidence: 0 };
  }

  let detection = detectFromUrl(finalUrl) ?? detectFromHtml(html);
  if (detection?.ats_type === "oracle_recruiting_cloud") {
    detection = finalizeOracleDetection(detection, html);
  }

  if (!detection) {
    return {
      careers_url: finalUrl.toString(),
      ats_type: "unknown",
      ats_identifier: null,
      confidence: 0,
      supported: false,
      error: "Could not detect ATS from URL or page content",
    };
  }

  const pageTitle = extractPageTitle(html);
  const companyName = guessCompanyName(pageTitle, detection.ats_identifier);
  const probeOk = await probeAtsApi(detection.ats_type, detection.ats_identifier);
  const confidence = computeConfidence({
    ats_type: detection.ats_type,
    ats_identifier: detection.ats_identifier,
    directHostMatch: detection.directHostMatch,
    probeOk,
    pageTitle,
    companyName,
    redirectCount,
    signalCount: detection.signalCount ?? 1,
  });

  return {
    name: companyName,
    careers_url: finalUrl.toString(),
    application_url: detection.application_url ?? null,
    platform: detection.platform ?? null,
    ats_type: detection.ats_type,
    ats_identifier: detection.ats_identifier,
    confidence,
    supported: isSupportedAts(detection.ats_type),
    probe_ok: probeOk,
    page_title: pageTitle,
  };
}

module.exports = { detectAts };
