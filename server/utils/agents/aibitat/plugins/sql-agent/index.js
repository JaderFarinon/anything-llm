const { SqlAgentGetTableSchema } = require("./get-table-schema");
const { SqlAgentListDatabase } = require("./list-database");
const { SqlAgentListTables } = require("./list-table");
const { SqlAgentQuery } = require("./query");
const { SqlAgentListQueries } = require("./list-queries");

const sqlAgent = {
  name: "sql-agent",
  startupConfig: {
    params: {},
  },
  plugin: [
    SqlAgentListDatabase,
    SqlAgentListTables,
    SqlAgentGetTableSchema,
    SqlAgentListQueries,
    SqlAgentQuery,
  ],
};

module.exports = {
  sqlAgent,
};
