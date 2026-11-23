module.exports.SqlAgentQuery = {
  name: "sql-query",
  plugin: function () {
    const { validateReadOnlyQuery } = require("./readOnly");
    const { prepareSavedQuery } = require("./query-template");
    const {
      getDBClient,
      listSQLConnections,
      sqlConnectionScopeContext,
    } = require("./SQLConnectors/index.js");

    return {
      name: "sql-query",
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Use this after sql-list-saved-queries has searched every connection the user may access. Run only the approved query_id from that catalog; map the user's dates, names and filters to its documented parameters, and chain queries when a saved query returns an identifier needed by another. Preserve the meaning of returned columns exactly: never relabel an internal exam/procedure code as TUSS unless the query explicitly identifies that field as TUSS. If the saved query does not return the requested kind of code or fact, say so instead of substituting a different code. Answer from returned rows and cite the saved query title; when the user requests a chart, pass those rows to create-chart. Only read-only SQL is accepted and results are capped at 200 rows.",
          examples: [
            {
              prompt:
                "What approved SQL queries can answer a question about billing?",
              call: JSON.stringify({
                database_id: "billing",
              }),
            },
            {
              prompt: "How much was billed in the last 12 months?",
              call: JSON.stringify({
                database_id: "billing",
                query_id: "billing-by-period",
                parameters: {
                  start_date: "2025-01-01",
                  end_date: "2026-01-01",
                },
              }),
            },
            {
              prompt: "qual valor faturado em maio de 2026 pelo Clinic?",
              call: JSON.stringify({
                database_id: "clinic",
                query_id: "billing-by-period",
                parameters: {
                  start_date: "2026-05-01",
                  end_date: "2026-06-01",
                },
              }),
            },
            {
              prompt: "Show billed revenue by payer as a chart.",
              call: JSON.stringify({
                database_id: "billing",
                query_id: "billing-by-payer",
                parameters: {
                  start_date: "2025-01-01",
                  end_date: "2026-01-01",
                },
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              database_id: {
                type: "string",
                description:
                  "The database identifier for which we will connect to to query the table schema. This is required to run the SQL query.",
              },
              sql_query: {
                type: "string",
                description:
                  "A direct SELECT query. Use only if the database has no saved queries configured.",
              },
              query_id: {
                type: "string",
                description:
                  "The id of an admin-approved saved query returned by sql-list-saved-queries.",
              },
              parameters: {
                type: "object",
                description:
                  "Values for the saved query parameters, keyed by the parameter name and matching the user's request.",
                additionalProperties: true,
              },
            },
            required: ["database_id"],
            additionalProperties: false,
          },
          handler: async function ({
            database_id = "",
            sql_query = "",
            query_id = "",
            parameters = {},
          }) {
            this.super.handlerProps.log(`Using the sql-query tool.`);
            const startedAt = Date.now();
            let selectedQueryTitle = null;
            const logQuery = async ({
              success,
              queryId = null,
              queryTitle = null,
              rowCount = 0,
              truncated = false,
              errorCode = null,
            }) => {
              const invocation = this.super.handlerProps?.invocation || {};
              const { EventLogs } = require("../../../../models/eventLogs");
              await EventLogs.logEvent(
                "sql_query_executed",
                {
                  databaseId: database_id,
                  queryId,
                  queryTitle,
                  chatId: this.super.trackedChatId || null,
                  invocationId: invocation.uuid || null,
                  success,
                  rowCount,
                  truncated,
                  durationMs: Date.now() - startedAt,
                  ...(errorCode ? { errorCode } : {}),
                },
                invocation.user_id || null
              );
            };
            try {
              const databaseConfig = (
                await listSQLConnections(sqlConnectionScopeContext(this.super))
              ).find((db) => db.database_id === database_id);
              if (!databaseConfig) {
                this.super.handlerProps.log(
                  `sql-query failed to find config!`,
                  database_id
                );
                return `No database connection for ${database_id} was found!`;
              }

              let queryToRun = sql_query;
              let boundParameters = [];
              const savedQueries = Array.isArray(databaseConfig.queries)
                ? databaseConfig.queries
                : [];
              if (query_id) {
                const savedQuery = savedQueries.find(
                  (query) => query.id === query_id
                );
                if (!savedQuery)
                  return `No approved query with id ${query_id} was found.`;
                selectedQueryTitle = savedQuery.title;
                const prepared = prepareSavedQuery({
                  engine: databaseConfig.engine,
                  sql: savedQuery.sql,
                  parameters: savedQuery.parameters || [],
                  values: parameters,
                });
                queryToRun = prepared.query;
                boundParameters = prepared.params;
              } else {
                if (savedQueries.length)
                  return `This database has approved saved queries. Use sql-list-saved-queries and call sql-query with one of the returned query_id values.`;
                const validation = validateReadOnlyQuery(sql_query);
                if (!validation.valid) return validation.reason;
                if (!sql_query.trim())
                  return "Provide a query_id for an approved query.";
              }

              this.super.introspect(
                `${this.caller}: Im going to run a query on the ${database_id} to get an answer.`
              );
              const db = getDBClient(databaseConfig.engine, databaseConfig);

              this.super.introspect(
                `Running an approved SQL query on ${database_id}.`
              );
              const result = await db.runQuery(queryToRun, boundParameters);
              if (result.error) {
                await logQuery({
                  success: false,
                  queryId: query_id || null,
                  queryTitle:
                    typeof selectedQueryTitle === "string"
                      ? selectedQueryTitle
                      : null,
                  errorCode: "query_execution_failed",
                });
                this.super.handlerProps.log(
                  `sql-query tool reported error`,
                  result.error
                );
                this.super.introspect(`Error: ${result.error}`);
                return `There was an error running the query: ${result.error}`;
              }

              const maxRows = 200;
              const rows = Array.isArray(result.rows) ? result.rows : [];
              await logQuery({
                success: true,
                queryId: query_id || null,
                queryTitle:
                  typeof selectedQueryTitle === "string"
                    ? selectedQueryTitle
                    : null,
                rowCount: rows.length,
                truncated: result.truncated === true || rows.length > maxRows,
              });
              return JSON.stringify({
                ...result,
                rows: rows.slice(0, maxRows),
                count: rows.length,
                truncated: result.truncated === true || rows.length > maxRows,
              });
            } catch (e) {
              await logQuery({
                success: false,
                queryId: query_id || null,
                errorCode: "query_execution_exception",
              });
              console.error(e);
              return e.message;
            }
          },
        });
      },
    };
  },
};
