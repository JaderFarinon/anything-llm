module.exports.SqlAgentListQueries = {
  name: "sql-list-saved-queries",
  plugin: function () {
    const {
      listSQLConnections,
      sqlConnectionScopeContext,
    } = require("./SQLConnectors/index.js");
    const { resolveProviderConnector } = require("../../../../helpers");
    const {
      searchSqlKnowledgeIndex,
      syncSqlKnowledgeIndex,
    } = require("./knowledge-index");

    return {
      name: "sql-list-saved-queries",
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Use this catalog automatically for company-data questions; do not ask the user which source or system to check when an authorized connection exists in the current workspace. Search every connection available to this user unless they named one, and use the saved descriptions, output meanings, examples, and parameter definitions. If one answer needs multiple saved queries, plan the sequence from their documented inputs and outputs, run each approved query, and pass a returned identifier into the next query only when its meaning matches the documented parameter. Do not treat a generic/internal code as a TUSS code: only call a code TUSS when the saved query explicitly returns or documents a TUSS field. If no saved query provides the requested fact or identifier, state that limitation and identify the closest available data. Never invent SQL, tables, fields, query capabilities, or examples; ask only for a required value that the catalog genuinely needs.",
          examples: [
            {
              prompt: "What approved billing queries can I use?",
              call: JSON.stringify({ question: "What approved billing queries can I use?" }),
            },
            {
              prompt: "qual valor faturado no Clinic em maio de 2026?",
              call: JSON.stringify({ question: "qual valor faturado no Clinic em maio de 2026?" }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              database_id: {
                type: "string",
                description: "The database identifier shown in the SQL connection settings.",
              },
              question: {
                type: "string",
                description: "The user's complete natural-language question about the SQL data.",
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
          handler: async function ({ database_id = "", question = "" }) {
            const scopeContext = sqlConnectionScopeContext(this.super);
            const connections = (await listSQLConnections(scopeContext)).filter(
              (item) => !database_id || item.database_id === database_id
            );
            if (!connections.length)
              return database_id
                ? `No database connection for ${database_id} was found.`
                : "No SQL database connections are configured.";
            const catalog = connections.flatMap((connection) => {
              const queries = Array.isArray(connection.queries)
                ? connection.queries
                : [];
              return queries.map(({ id, title, description, examples = [], parameters = [] }) => ({
                database_id: connection.database_id,
                id,
                title,
                description,
                examples: Array.isArray(examples) ? examples : [],
                parameters: parameters.map(({ name, type, description, required }) => ({
                  name,
                  type,
                  description,
                  required,
                })),
              }));
            });
            let relevantContext = [];
            if (question) {
              try {
                await syncSqlKnowledgeIndex(await listSQLConnections());
              } catch (error) {
                this.super.handlerProps?.log?.(
                  `SQL knowledge vector indexing failed: ${error.message}`
                );
              }
              const workspace = this.super.handlerProps?.invocation?.workspace;
              if (workspace) {
                try {
                  const { connector: LLMConnector } = await resolveProviderConnector({
                    workspace,
                    prompt: question,
                  });
                  relevantContext = await searchSqlKnowledgeIndex(
                    connections,
                    question,
                    LLMConnector
                  );
                } catch (error) {
                  this.super.handlerProps?.log?.(
                    `SQL knowledge vector search failed: ${error.message}`
                  );
                }
              }
            }
            if (!catalog.length)
              return `No approved saved queries are configured${database_id ? ` for ${database_id}` : ""}. Ask an administrator to add one.`;
            return JSON.stringify({
              connections: connections.map(({ database_id, engine, description }) => ({
                database_id,
                engine,
                description: description || "Descrição da origem ainda não cadastrada.",
              })),
              relevant_context: relevantContext,
              queries: catalog,
            });
          },
        });
      },
    };
  },
};
