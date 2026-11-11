const { SystemSettings } = require("../../../../../../models/systemSettings");
const { safeJsonParse } = require("../../../../../http");
const prisma = require("../../../../../../utils/prisma");

/**
 * @typedef {('postgresql'|'mysql'|'sql-server')} SQLEngine
 */

/**
 * @typedef {Object} QueryResult
 * @property {[number]} rows - The query result rows
 * @property {number} count - Number of rows the query returned/changed
 * @property {string|null} error - Error string if there was an issue
 */

/**
 * A valid database SQL connection object
 * @typedef {Object} SQLConnection
 * @property {string} database_id - Unique identifier of the database connection
 * @property {SQLEngine} engine - Engine used by connection
 * @property {string} connectionString - RFC connection string for db
 */

/**
 * @param {SQLEngine} identifier
 * @param {object} connectionConfig
 * @returns Database Connection Engine Class for SQLAgent or throws error
 */
function getDBClient(identifier = "", connectionConfig = {}) {
  switch (identifier) {
    case "mysql":
      const { MySQLConnector } = require("./MySQL");
      return new MySQLConnector(connectionConfig);
    case "postgresql":
      const { PostgresSQLConnector } = require("./Postgresql");
      return new PostgresSQLConnector(connectionConfig);
    case "sql-server":
      const { MSSQLConnector } = require("./MSSQL");
      return new MSSQLConnector(connectionConfig);
    default:
      throw new Error(
        `There is no supported database connector for ${identifier}`
      );
  }
}

/**
 * Lists all of the known database connection that can be used by the agent.
 * @returns {Promise<[SQLConnection]>}
 */
async function listSQLConnections(scopeContext = null) {
  const connections = await SystemSettings.getSQLConnections();
  if (scopeContext === null) return connections;

  const { userId = null, workspaceId = null } = scopeContext || {};
  const globalConnections = () =>
    connections.filter((connection) => (connection.accessScope || "global") === "global");
  if (!userId) return globalConnections();

  const user = await prisma.users.findUnique({
    where: { id: Number(userId) },
    select: { id: true, role: true },
  });
  if (!user) return globalConnections();
  if (user.role === "admin") return connections;

  const [companyMemberships, workspace] = await Promise.all([
    prisma.user_companies.findMany({
      where: { userId: user.id },
      select: { companyId: true },
    }),
    workspaceId
      ? prisma.workspaces.findUnique({
          where: { id: Number(workspaceId) },
          select: { id: true, companyId: true },
        })
      : null,
  ]);
  const companyIds = new Set(companyMemberships.map(({ companyId }) => companyId));

  return connections.filter((connection) => {
    const scope = connection.accessScope || "global";
    const scopeId = Number(connection.accessScopeId);
    if (scope === "global") return true;
    if (scope === "user") return scopeId === user.id;
    if (scope === "workspace") return !!workspace && scopeId === workspace.id;
    if (scope === "company")
      return (
        companyIds.has(scopeId) &&
        (!workspace?.companyId || workspace.companyId === scopeId)
      );
    return false;
  });
}

function sqlConnectionScopeContext(aibitat) {
  const invocation = aibitat?.handlerProps?.invocation || {};
  return {
    userId: invocation.user_id ?? null,
    workspaceId: invocation.workspace?.id ?? invocation.workspace_id ?? null,
  };
}

/**
 * Validates a SQL connection by attempting to connect and run a simple query
 * @param {SQLEngine} identifier - The SQL engine type
 * @param {object} connectionConfig - The connection configuration
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function validateConnection(identifier = "", connectionConfig = {}) {
  try {
    const client = getDBClient(identifier, connectionConfig);
    return await client.validateConnection();
  } catch {
    console.log(`Failed to connect to ${identifier} database.`);
    return {
      success: false,
      error: `Unable to connect to ${identifier}. Please verify your connection details.`,
    };
  }
}

module.exports = {
  getDBClient,
  listSQLConnections,
  sqlConnectionScopeContext,
  validateConnection,
};
