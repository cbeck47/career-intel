const fetch = require("node-fetch");

const USER_AGENT = "CareerIntel/1.0 (website resolver)";
const FETCH_TIMEOUT_MS = 10000;
const CAREERS_PATHS = ["/careers", "/jobs", "/en/careers", "/en/jobs", "/about/careers", "/work-with-us"];

function parseUrl(rawUrl) {
  try {
    const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

function normalizeWebsite(website) {
  if (!website?.trim()) return null;
  const parsed = parseUrl(website.trim());
  if (!parsed) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    const key = url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

function extractCareersLinks(html, baseUrl) {
  const links = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (!/(career|jobs|work-with-us|join-us|opportunities)/i.test(href)) continue;
    try {
      const resolved = new URL(href, baseUrl).toString();
      links.push(resolved);
    } catch {
      // ignore invalid href
    }
  }
  return links;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    const text = await res.text();
    return { ok: res.ok, finalUrl: res.url, html: text };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCareersCandidates(input = {}) {
  const name = (input.name ?? "").trim();
  const website = normalizeWebsite(input.website);
  const directCareersUrl = input.careers_url?.trim() || null;

  const candidates = [];

  if (directCareersUrl) {
    candidates.push(directCareersUrl);
  }

  if (website) {
    for (const path of CAREERS_PATHS) {
      candidates.push(`${website.replace(/\/$/, "")}${path}`);
    }

    try {
      const page = await fetchWithTimeout(website);
      if (page.ok) {
        const homepageLinks = extractCareersLinks(page.html, page.finalUrl);
        candidates.push(...homepageLinks);
      }
    } catch {
      // homepage fetch failed — still return path guesses
    }
  }

  if (!candidates.length && name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (slug) {
      candidates.push(`https://careers.smartrecruiters.com/${slug}`);
      candidates.push(`https://jobs.lever.co/${slug}`);
    }
  }

  return dedupeUrls(candidates).slice(0, 12);
}

module.exports = { resolveCareersCandidates, normalizeWebsite };
