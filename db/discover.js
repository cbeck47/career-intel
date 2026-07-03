const { getDb } = require("./schema");

function get() {
  const db = getDb();
  const row = db.prepare("SELECT result, analyzed_at FROM discover WHERE id = 1").get();
  if (!row?.result) {
    return { result: null, analyzed_at: null };
  }
  try {
    return {
      result: JSON.parse(row.result),
      analyzed_at: row.analyzed_at ?? null,
    };
  } catch {
    return { result: null, analyzed_at: row.analyzed_at ?? null };
  }
}

function save({ result, analyzed_at }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discover (id, result, analyzed_at) VALUES (1, @result, @analyzed_at)
    ON CONFLICT(id) DO UPDATE SET
      result = excluded.result,
      analyzed_at = excluded.analyzed_at
  `).run({
    result: JSON.stringify(result),
    analyzed_at: analyzed_at ?? new Date().toISOString(),
  });
}

module.exports = { get, save };
