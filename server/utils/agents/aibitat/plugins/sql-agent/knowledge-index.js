const crypto = require("crypto");

const SQL_KNOWLEDGE_NAMESPACE_PREFIX = "__anyhealth_sql_knowledge_";
const LEGACY_SQL_KNOWLEDGE_NAMESPACE = "__anyhealth_sql_knowledge__";
const SQL_KNOWLEDGE_DOC_PREFIX = "sql-connection-knowledge:";
let indexedCatalogHash = null;
let activeSync = null;

function connectionKnowledge(connection) {
  const queries = (connection.queries || []).map((query) => {
    const parameters = (query.parameters || []).map((parameter) =>
      `- ${parameter.name} (${parameter.type}${parameter.required !== false ? ", obrigatório" : ", opcional"}): ${parameter.description}`
    );
    return [
      `Consulta: ${query.title}`,
      `Quando usar: ${query.description}`,
      query.examples?.length
        ? `Exemplos de perguntas validadas:\n${query.examples.map((example) => `- ${example}`).join("\n")}`
        : "Ainda não há exemplos de perguntas validados para esta consulta.",
      parameters.length
        ? `Parâmetros necessários:\n${parameters.join("\n")}`
        : "Não requer parâmetros informados pelo usuário.",
    ].join("\n");
  });

  return [
    `Origem de dados: ${connection.database_id}`,
    `Sistema de origem: ${connection.description || "Descrição ainda não cadastrada."}`,
    `Tipo de banco: ${connection.engine}`,
    `Escopo de acesso: ${connection.accessScope || "global"}${connection.accessScopeId ? ` (${connection.accessScopeId})` : ""}`,
    "A conexão aceita apenas consultas de leitura. Use exclusivamente consultas salvas e aprovadas; não invente tabelas ou campos.",
    ...queries,
  ].join("\n\n");
}

function sqlKnowledgeNamespace(databaseId) {
  const key = crypto
    .createHash("sha256")
    .update(String(databaseId || ""))
    .digest("hex")
    .slice(0, 24);
  return `${SQL_KNOWLEDGE_NAMESPACE_PREFIX}${key}__`;
}

/**
 * Keeps SQL connection descriptions and saved-query documentation in a
 * dedicated vector namespace per connection. This keeps restricted connection
 * knowledge isolated. Credentials and SQL templates are never indexed.
 */
async function syncSqlKnowledgeIndex(connections = []) {
  const catalog = (connections || [])
    .filter((connection) => connection?.database_id)
    .map((connection) => ({
      database_id: connection.database_id,
      engine: connection.engine,
      description: connection.description || "",
      accessScope: connection.accessScope || "global",
      accessScopeId: connection.accessScopeId || null,
      queries: (connection.queries || []).map((query) => ({
        title: query.title,
        description: query.description,
        examples: query.examples || [],
        parameters: query.parameters || [],
      })),
    }))
    .sort((a, b) => a.database_id.localeCompare(b.database_id));
  const catalogHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(catalog))
    .digest("hex");
  if (catalogHash === indexedCatalogHash) return { success: true, unchanged: true };
  if (activeSync) return activeSync;

  activeSync = (async () => {
    const { getVectorDbClass } = require("../../../../helpers");
    const { DocumentVectors } = require("../../../../../models/vectors");
    const VectorDb = getVectorDbClass();
    const existingVectors = await DocumentVectors.where({
      docId: { startsWith: SQL_KNOWLEDGE_DOC_PREFIX },
    });
    const wantedDocIds = new Set(
      catalog.map(({ database_id }) => `${SQL_KNOWLEDGE_DOC_PREFIX}${database_id}`)
    );

    // Remove the former shared catalog if an instance is upgrading from the
    // earlier shared-index implementation. Never search this namespace.
    if (await VectorDb.hasNamespace(LEGACY_SQL_KNOWLEDGE_NAMESPACE)) {
      await VectorDb["delete-namespace"]({
        namespace: LEGACY_SQL_KNOWLEDGE_NAMESPACE,
      });
      for (const { docId } of existingVectors)
        await DocumentVectors.delete({ docId });
    }

    const staleDocIds = new Set(
      existingVectors
        .map(({ docId }) => docId)
        .filter((docId) => !wantedDocIds.has(docId))
    );
    for (const docId of staleDocIds) {
      const databaseId = docId.slice(SQL_KNOWLEDGE_DOC_PREFIX.length);
      const namespace = sqlKnowledgeNamespace(databaseId);
      if (await VectorDb.hasNamespace(namespace))
        await VectorDb["delete-namespace"]({ namespace });
      await DocumentVectors.delete({ docId });
    }

    let success = true;
    for (const connection of catalog) {
      const docId = `${SQL_KNOWLEDGE_DOC_PREFIX}${connection.database_id}`;
      const namespace = sqlKnowledgeNamespace(connection.database_id);
      if (await VectorDb.hasNamespace(namespace)) {
        await VectorDb["delete-namespace"]({ namespace });
        await DocumentVectors.delete({ docId });
      }
      const pageContent = connectionKnowledge(connection);
      const result = await VectorDb.addDocumentToNamespace(
        namespace,
        {
          docId,
          url: `anyhealth://sql-connection/${connection.database_id}`,
          title: `Contexto SQL: ${connection.database_id}`,
          docAuthor: "AnyHealth administrator",
          docSource: "SQL connection catalog",
          description: connection.description || "SQL saved-query documentation",
          published: new Date().toISOString(),
          wordCount: pageContent.split(/\s+/).length,
          pageContent,
        },
        null,
        true
      );
      if (!result?.vectorized) {
        success = false;
        console.error(
          `Failed to index SQL connection ${connection.database_id}:`,
          result?.error || "unknown vectorization error"
        );
      }
    }

    if (success) indexedCatalogHash = catalogHash;
    return { success };
  })();

  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}

async function searchSqlKnowledgeIndex(connections = [], question, LLMConnector) {
  if (!question || !LLMConnector) return [];
  const { getVectorDbClass } = require("../../../../helpers");
  const VectorDb = getVectorDbClass();
  const results = [];
  for (const connection of connections) {
    const namespace = sqlKnowledgeNamespace(connection.database_id);
    if (!(await VectorDb.hasNamespace(namespace))) continue;
    try {
      const result = await VectorDb.performSimilaritySearch({
        namespace,
        input: question,
        LLMConnector,
        similarityThreshold: 0.2,
        topN: 3,
      });
      for (const text of result.contextTexts || [])
        results.push(`Conexão ${connection.database_id}:\n${text}`);
    } catch (error) {
      console.error(
        `SQL knowledge vector search failed for ${connection.database_id}:`,
        error.message
      );
    }
  }
  return results;
}

module.exports = {
  sqlKnowledgeNamespace,
  connectionKnowledge,
  searchSqlKnowledgeIndex,
  syncSqlKnowledgeIndex,
};
