const { getDb } = require("./schema");
const jobs = require("./jobs");
const companies = require("./companies");
const profile = require("./profile");
const discover = require("./discover");

function initDb() {
  getDb();
}

module.exports = {
  initDb,
  jobs,
  companies,
  profile,
  discover,
};
