const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "career-intel.db");

const JSON_FILES = {
  jobs: path.join(DATA_DIR, "jobs.json"),
  companies: path.join(DATA_DIR, "companies.json"),
  profile: path.join(DATA_DIR, "profile.json"),
  discover: path.join(DATA_DIR, "discover.json"),
};

let dbInstance = null;

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function renameMigrated(filePath) {
  if (!fs.existsSync(filePath)) return;
  const migrated = `${filePath}.migrated`;
  if (fs.existsSync(migrated)) return;
  fs.renameSync(filePath, migrated);
}

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source TEXT,
      title TEXT,
      company TEXT,
      location TEXT,
      remote INTEGER DEFAULT 0,
      salary_min REAL,
      salary_max REAL,
      salary_interval TEXT,
      description_raw TEXT,
      description_clean TEXT,
      posted_at TEXT,
      url TEXT,
      apply_url TEXT,
      sector TEXT,
      registry_id TEXT,
      ai_score TEXT,
      heuristic_score REAL,
      heuristic_scored_at TEXT,
      heuristic_components TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      closed_at TEXT,
      sync_status TEXT DEFAULT 'active',
      sync_error TEXT
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discover (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      result TEXT,
      analyzed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function migrateJsonIfNeeded(db) {
  const migrated = db.prepare("SELECT value FROM meta WHERE key = 'json_migrated'").get();
  if (migrated?.value === "1") return;

  const hasJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
  if (hasJobs > 0) {
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')"
    ).run();
    return;
  }

  let imported = false;

  const jobs = readJsonFile(JSON_FILES.jobs, []);
  if (Array.isArray(jobs) && jobs.length) {
    const { upsertMany } = require("./jobs");
    upsertMany(jobs, { isMigration: true });
    imported = true;
    console.log(`[db] Migrated ${jobs.length} jobs from jobs.json`);
  }

  const companiesData = readJsonFile(JSON_FILES.companies, { companies: [] });
  if (companiesData.companies?.length) {
    const { upsertMany: upsertCompanies } = require("./companies");
    upsertCompanies(companiesData.companies);
    imported = true;
    console.log(`[db] Migrated ${companiesData.companies.length} companies from companies.json`);
  }

  const profile = readJsonFile(JSON_FILES.profile, null);
  if (profile && typeof profile === "object" && Object.keys(profile).length) {
    const { save } = require("./profile");
    save(profile);
    imported = true;
    console.log("[db] Migrated profile from profile.json");
  }

  const discover = readJsonFile(JSON_FILES.discover, null);
  if (discover?.result) {
    const { save: saveDiscover } = require("./discover");
    saveDiscover(discover);
    imported = true;
    console.log("[db] Migrated discover from discover.json");
  }

  if (imported) {
    for (const filePath of Object.values(JSON_FILES)) {
      renameMigrated(filePath);
    }
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')").run();
}

function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");

  createTables(dbInstance);
  migrateJsonIfNeeded(dbInstance);

  return dbInstance;
}

module.exports = { getDb, DATA_DIR, DB_PATH };
