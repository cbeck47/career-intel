const { getDb } = require("./schema");

function get() {
  const db = getDb();
  const row = db.prepare("SELECT payload FROM profile WHERE id = 1").get();
  if (!row) return {};
  try {
    return JSON.parse(row.payload);
  } catch {
    return {};
  }
}

function save(profile) {
  const db = getDb();
  db.prepare(`
    INSERT INTO profile (id, payload) VALUES (1, @payload)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
  `).run({ payload: JSON.stringify(profile ?? {}) });
}

module.exports = { get, save };
