const { validateReadOnlyQuery } = require("./readOnly");

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function getQueryParameterNames(sql = "") {
  return [...new Set([...sql.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

function coerceParameterValue(definition, value) {
  if (value === undefined || value === null || value === "") {
    if (definition.required) {
      throw new Error(`A value is required for ${definition.name}.`);
    }
    return null;
  }

  switch (definition.type) {
    case "integer": {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed))
        throw new Error(`${definition.name} must be an integer.`);
      return parsed;
    }
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed))
        throw new Error(`${definition.name} must be a number.`);
      return parsed;
    }
    case "date": {
      const parsed = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(parsed) || Number.isNaN(Date.parse(parsed))) {
        throw new Error(`${definition.name} must be a valid ISO date or datetime.`);
      }
      return parsed;
    }
    case "boolean": {
      if (value === true || value === "true" || value === 1 || value === "1") return true;
      if (value === false || value === "false" || value === 0 || value === "0") return false;
      throw new Error(`${definition.name} must be true or false.`);
    }
    case "string":
    default: {
      const parsed = String(value);
      if (parsed.length > 2000)
        throw new Error(`${definition.name} is too long.`);
      return parsed;
    }
  }
}

/**
 * Convert an admin-authored SELECT template using {{parameter_name}} markers
 * into a driver-specific parameterized statement. Values never enter SQL text.
 */
function prepareSavedQuery({ engine, sql, parameters = [], values = {} }) {
  const validation = validateReadOnlyQuery(sql);
  if (!validation.valid) throw new Error(validation.reason);

  const names = getQueryParameterNames(sql);
  const definitions = new Map();
  for (const definition of parameters) {
    if (!definition?.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.name))
      throw new Error("Query parameters must use letters, numbers, and underscores.");
    if (definitions.has(definition.name))
      throw new Error(`Duplicate parameter definition: ${definition.name}.`);
    definitions.set(definition.name, definition);
  }

  const unknownDefinitions = [...definitions.keys()].filter((name) => !names.includes(name));
  if (unknownDefinitions.length) {
    throw new Error(`Unused parameter definition: ${unknownDefinitions.join(", ")}.`);
  }
  const missingDefinitions = names.filter((name) => !definitions.has(name));
  if (missingDefinitions.length) {
    throw new Error(`Add a definition for: ${missingDefinitions.join(", ")}.`);
  }
  const unknownValues = Object.keys(values || {}).filter((name) => !names.includes(name));
  if (unknownValues.length) {
    throw new Error(`Unknown query parameter: ${unknownValues.join(", ")}.`);
  }

  const orderedNames = [];
  const boundValues = [];
  const dialect = engine === "sql-server" ? "sql-server" : engine;
  const preparedSql = sql.replace(PLACEHOLDER, (_whole, name) => {
    const definition = definitions.get(name);
    const value = values?.[name] ?? definition.defaultValue ?? null;
    const parsed = coerceParameterValue(definition, value);
    const index = orderedNames.length;
    orderedNames.push(name);
    boundValues.push(parsed);
    if (dialect === "sql-server") return `@p${index}`;
    if (dialect === "postgresql") return `$${index + 1}`;
    if (dialect === "mysql") return "?";
    throw new Error(`Unsupported SQL engine: ${engine}.`);
  });

  return { query: preparedSql, params: boundValues, parameterNames: orderedNames };
}

module.exports = { getQueryParameterNames, prepareSavedQuery };
