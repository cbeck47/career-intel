const { getDb } = require("./schema");

function getAll() {
  const db = getDb();
  const rows = db.prepare("SELECT payload FROM companies ORDER BY json_extract(payload, '$.name')").all();
  const companies = rows.map((row) => JSON.parse(row.payload));
  return { companies };
}

function upsertMany(companies) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO companies (id, payload) VALUES (@id, @payload)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
  `);

  const run = db.transaction((items) => {
    for (const company of items) {
      upsert.run({ id: company.id, payload: JSON.stringify(company) });
    }
  });
  run(companies);
}

function saveRegistry(registry) {
  const db = getDb();
  const deleteAll = db.prepare("DELETE FROM companies");
  const insert = db.prepare("INSERT INTO companies (id, payload) VALUES (?, ?)");

  const run = db.transaction((companies) => {
    deleteAll.run();
    for (const company of companies) {
      insert.run(company.id, JSON.stringify(company));
    }
  });
  run(registry.companies ?? []);
}

function deleteById(id) {
  const db = getDb();
  const result = db.prepare("DELETE FROM companies WHERE id = ?").run(id);
  return result.changes > 0;
}

function count() {
  const db = getDb();
  return db.prepare("SELECT COUNT(*) AS count FROM companies").get().count;
}

function getStale(olderThanDays = 30) {
  const { companies } = getAll();
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  return companies.filter(
    (company) =>
      company.enabled &&
      (!company.last_verified || company.last_verified < cutoff)
  );
}

function getById(id) {
  const { companies } = getAll();
  return companies.find((company) => company.id === id) ?? null;
}

function updateCompany(company) {
  upsertMany([company]);
  return company;
}

function getReviewQueue() {
  const { companies } = getAll();
  return companies.filter((company) =>
    ["manual_review", "stale", "unresolved"].includes(company.verification_status)
  );
}

module.exports = {
  getAll,
  upsertMany,
  saveRegistry,
  deleteById,
  count,
  getStale,
  getById,
  updateCompany,
  getReviewQueue,
};
