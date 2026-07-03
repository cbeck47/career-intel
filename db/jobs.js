const { getDb } = require("./schema");

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    company: row.company,
    location: row.location,
    remote: row.remote === 1,
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_interval: row.salary_interval,
    description_raw: row.description_raw,
    description_clean: row.description_clean,
    posted_at: row.posted_at,
    url: row.url,
    apply_url: row.apply_url,
    sector: row.sector,
    registry_id: row.registry_id,
    ai_score: parseJson(row.ai_score),
    heuristic_score: row.heuristic_score,
    heuristic_scored_at: row.heuristic_scored_at,
    heuristic_components: parseJson(row.heuristic_components),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    closed_at: row.closed_at,
    sync_status: row.sync_status,
    sync_error: row.sync_error,
  };
}

function jobToRow(job) {
  return {
    id: job.id,
    source: job.source ?? null,
    title: job.title ?? null,
    company: job.company ?? null,
    location: job.location ?? null,
    remote: job.remote ? 1 : 0,
    salary_min: job.salary_min ?? null,
    salary_max: job.salary_max ?? null,
    salary_interval: job.salary_interval ?? null,
    description_raw: job.description_raw ?? null,
    description_clean: job.description_clean ?? null,
    posted_at: job.posted_at ?? null,
    url: job.url ?? null,
    apply_url: job.apply_url ?? null,
    sector: job.sector ?? null,
    registry_id: job.registry_id ?? null,
    ai_score: job.ai_score != null ? JSON.stringify(job.ai_score) : null,
    heuristic_score: job.heuristic_score ?? null,
    heuristic_scored_at: job.heuristic_scored_at ?? null,
    heuristic_components:
      job.heuristic_components != null ? JSON.stringify(job.heuristic_components) : null,
    first_seen_at: job.first_seen_at ?? null,
    last_seen_at: job.last_seen_at ?? null,
    closed_at: job.closed_at ?? null,
    sync_status: job.sync_status ?? "active",
    sync_error: job.sync_error ?? null,
  };
}

const UPSERT_SQL = `
  INSERT INTO jobs (
    id, source, title, company, location, remote,
    salary_min, salary_max, salary_interval,
    description_raw, description_clean, posted_at, url, apply_url, sector, registry_id,
    ai_score, heuristic_score, heuristic_scored_at, heuristic_components,
    first_seen_at, last_seen_at, closed_at, sync_status, sync_error
  ) VALUES (
    @id, @source, @title, @company, @location, @remote,
    @salary_min, @salary_max, @salary_interval,
    @description_raw, @description_clean, @posted_at, @url, @apply_url, @sector, @registry_id,
    @ai_score, @heuristic_score, @heuristic_scored_at, @heuristic_components,
    @first_seen_at, @last_seen_at, @closed_at, @sync_status, @sync_error
  )
  ON CONFLICT(id) DO UPDATE SET
    source = excluded.source,
    title = excluded.title,
    company = excluded.company,
    location = excluded.location,
    remote = excluded.remote,
    salary_min = excluded.salary_min,
    salary_max = excluded.salary_max,
    salary_interval = excluded.salary_interval,
    description_raw = excluded.description_raw,
    description_clean = excluded.description_clean,
    posted_at = excluded.posted_at,
    url = excluded.url,
    apply_url = excluded.apply_url,
    sector = excluded.sector,
    registry_id = excluded.registry_id,
    last_seen_at = excluded.last_seen_at,
    closed_at = NULL,
    sync_status = 'active',
    sync_error = NULL,
    ai_score = COALESCE(jobs.ai_score, excluded.ai_score),
    heuristic_score = COALESCE(jobs.heuristic_score, excluded.heuristic_score),
    heuristic_scored_at = COALESCE(jobs.heuristic_scored_at, excluded.heuristic_scored_at),
    heuristic_components = COALESCE(jobs.heuristic_components, excluded.heuristic_components),
    first_seen_at = COALESCE(jobs.first_seen_at, excluded.first_seen_at)
`;

function getAll(options = {}) {
  const db = getDb();
  const activeOnly = options.activeOnly !== false;
  const sql = activeOnly
    ? "SELECT * FROM jobs WHERE closed_at IS NULL ORDER BY heuristic_score DESC, title ASC"
    : "SELECT * FROM jobs ORDER BY heuristic_score DESC, title ASC";
  return db.prepare(sql).all().map(rowToJob);
}

function getById(id) {
  const db = getDb();
  return rowToJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
}

function upsertMany(jobs, options = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(UPSERT_SQL);

  const run = db.transaction((items) => {
    for (const job of items) {
      const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
      const row = jobToRow({
        ...job,
        first_seen_at: existing?.first_seen_at ?? job.first_seen_at ?? now,
        last_seen_at: now,
        closed_at: null,
        sync_status: "active",
        sync_error: null,
        ai_score: existing ? parseJson(existing.ai_score) : job.ai_score ?? null,
        heuristic_score: existing?.heuristic_score ?? job.heuristic_score ?? null,
        heuristic_scored_at: existing?.heuristic_scored_at ?? job.heuristic_scored_at ?? null,
        heuristic_components: existing
          ? parseJson(existing.heuristic_components)
          : job.heuristic_components ?? null,
      });
      upsert.run(row);
    }
  });

  run(jobs);
  return jobs.length;
}

function markClosed(freshIds) {
  const db = getDb();
  const now = new Date().toISOString();
  const idSet = new Set(freshIds);

  const activeRows = db.prepare("SELECT id FROM jobs WHERE closed_at IS NULL").all();
  const staleIds = activeRows.map((row) => row.id).filter((id) => !idSet.has(id));

  if (!staleIds.length) return 0;

  const mark = db.prepare(`
    UPDATE jobs
    SET closed_at = ?, sync_status = 'closed'
    WHERE id = ? AND closed_at IS NULL
  `);

  const run = db.transaction((ids) => {
    for (const id of ids) mark.run(now, id);
  });
  run(staleIds);
  return staleIds.length;
}

function updateRankings(rankedJobs) {
  const db = getDb();
  const update = db.prepare(`
    UPDATE jobs SET
      heuristic_score = @heuristic_score,
      heuristic_scored_at = @heuristic_scored_at,
      heuristic_components = @heuristic_components
    WHERE id = @id
  `);

  const run = db.transaction((items) => {
    for (const job of items) {
      update.run({
        id: job.id,
        heuristic_score: job.heuristic_score ?? null,
        heuristic_scored_at: job.heuristic_scored_at ?? null,
        heuristic_components:
          job.heuristic_components != null ? JSON.stringify(job.heuristic_components) : null,
      });
    }
  });
  run(rankedJobs);
}

function updateAiScore(id, aiScore) {
  const db = getDb();
  db.prepare("UPDATE jobs SET ai_score = ? WHERE id = ?").run(
    JSON.stringify(aiScore),
    id
  );
}

module.exports = {
  getAll,
  getById,
  upsertMany,
  markClosed,
  updateRankings,
  updateAiScore,
  rowToJob,
};
