const BLOCKED_SQL_KEYWORDS = new Set([
  "ALTER",
  "BACKUP",
  "BULK",
  "CALL",
  "COMMIT",
  "CREATE",
  "DELETE",
  "DENY",
  "DROP",
  "EXEC",
  "EXECUTE",
  "GRANT",
  "INSERT",
  "INTO",
  "MERGE",
  "OPENQUERY",
  "OPENROWSET",
  "OPENDATASOURCE",
  "RECONFIGURE",
  "SET",
  "SHUTDOWN",
  "SP_EXECUTESQL",
  "XP_CMDSHELL",
  "RESTORE",
  "REVOKE",
  "ROLLBACK",
  "TRUNCATE",
  "UPDATE",
  "USE",
  "WAITFOR",
]);

/**
 * Removes SQL comments and quoted literals/identifiers before validating tokens.
 * This is a conservative guard; database credentials must still be read-only.
 */
function normalizeForValidation(query = "") {
  let output = "";
  let quote = null;
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    const next = query[i + 1];
    if (!quote && char === "-" && next === "-") {
      while (i < query.length && query[i] !== "\n") i++;
      output += " ";
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      i += 2;
      while (i < query.length && !(query[i] === "*" && query[i + 1] === "/"))
        i++;
      if (i < query.length) i++;
      output += " ";
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote && quote !== "]") {
          i++;
        } else {
          quote = null;
        }
      }
      output += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
      continue;
    }
    if (char === "[") {
      quote = "]";
      output += " ";
      continue;
    }
    output += char;
  }
  return output
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

function validateReadOnlyQuery(query = "") {
  if (typeof query !== "string" || !query.trim()) {
    return { valid: false, reason: "A SQL query is required." };
  }

  const normalized = normalizeForValidation(query);
  if (!normalized || normalized.includes(";")) {
    return {
      valid: false,
      reason: "Only one read-only SQL statement is allowed.",
    };
  }

  const tokens = normalized.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
  if (!tokens.length || !["SELECT", "WITH"].includes(tokens[0].toUpperCase())) {
    return { valid: false, reason: "Only SELECT queries are allowed." };
  }

  const blocked = tokens.find((token) =>
    BLOCKED_SQL_KEYWORDS.has(token.toUpperCase())
  );
  if (blocked) {
    return {
      valid: false,
      reason: `Read-only SQL does not allow ${blocked.toUpperCase()}.`,
    };
  }

  return { valid: true, reason: null };
}

module.exports = { validateReadOnlyQuery };
