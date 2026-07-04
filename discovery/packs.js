const fs = require("fs");
const path = require("path");
const { mergeCompanies, normalizeCompany, nowIso } = require("../registry/companies");

const PACKS_DIR = path.join(__dirname, "..", "packs");

function ensurePacksDir() {
  fs.mkdirSync(PACKS_DIR, { recursive: true });
}

function sanitizePackName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function packPath(name) {
  return path.join(PACKS_DIR, `${sanitizePackName(name)}.json`);
}

function listPacks() {
  ensurePacksDir();
  return fs
    .readdirSync(PACKS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""));
}

function readPack(name) {
  ensurePacksDir();
  const file = packPath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Pack not found: ${name}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writePack(name, pack) {
  ensurePacksDir();
  const ts = nowIso();
  const payload = {
    name: sanitizePackName(name),
    description: pack.description ?? "",
    region: pack.region ?? null,
    industry: pack.industry ?? null,
    created_at: pack.created_at ?? ts,
    updated_at: ts,
    companies: (pack.companies ?? []).map((company) => normalizeCompany(company)),
  };
  fs.writeFileSync(packPath(name), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function mergePack(name, companies) {
  const existing = fs.existsSync(packPath(name))
    ? readPack(name)
    : { name: sanitizePackName(name), companies: [] };
  const mergedCompanies = mergeCompanies(existing.companies ?? [], companies);
  return writePack(name, { ...existing, companies: mergedCompanies });
}

function buildPack(name, meta = {}) {
  return writePack(name, {
    name: sanitizePackName(name),
    description: meta.description ?? "",
    region: meta.region ?? null,
    industry: meta.industry ?? null,
    companies: (meta.companies ?? []).map((company) => normalizeCompany(company)),
  });
}

function importPackToRegistry(name, registryCompanies = []) {
  const pack = readPack(name);
  const merged = mergeCompanies(registryCompanies, pack.companies ?? []);
  return { pack, companies: merged, imported: pack.companies?.length ?? 0 };
}

module.exports = {
  PACKS_DIR,
  listPacks,
  readPack,
  writePack,
  mergePack,
  buildPack,
  importPackToRegistry,
  sanitizePackName,
};
