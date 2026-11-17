import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Modal, { ModalHeader } from "@/components/lib/Modal";
import System from "@/models/system";
import showToast from "@/utils/toast";

const PARAMETER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function parameterNames(sql = "") {
  return [...new Set([...sql.matchAll(PARAMETER_PATTERN)].map((match) => match[1]))];
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `query-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function SQLQueryModal({
  isOpen,
  onClose,
  onSubmit,
  connection,
  existingQuery = null,
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [examples, setExamples] = useState("");
  const [sql, setSql] = useState("");
  const [parameters, setParameters] = useState([]);
  const [testValues, setTestValues] = useState({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const names = useMemo(() => parameterNames(sql), [sql]);

  useEffect(() => {
    if (!isOpen) return;
    setTitle(existingQuery?.title || "");
    setDescription(existingQuery?.description || "");
    setExamples((existingQuery?.examples || []).join("\n"));
    setSql(existingQuery?.sql || "");
    setParameters(existingQuery?.parameters || []);
    setTestValues({});
    setTestResult(null);
  }, [isOpen, existingQuery]);

  useEffect(() => {
    setParameters((current) =>
      names.map(
        (name) =>
          current.find((parameter) => parameter.name === name) || {
            name,
            type: "string",
            description: "",
            required: true,
          }
      )
    );
    setTestValues((current) =>
      Object.fromEntries(names.map((name) => [name, current[name] || ""]))
    );
    setTestResult(null);
  }, [names.join("|")]);

  if (!isOpen || !connection) return null;

  function updateParameter(name, field, value) {
    setParameters((current) =>
      current.map((parameter) =>
        parameter.name === name ? { ...parameter, [field]: value } : parameter
      )
    );
    setTestResult(null);
  }

  async function handleTest() {
    if (!sql.trim()) return showToast("Add a SELECT query first.", "error");
    setTesting(true);
    setTestResult(null);
    const result = await System.testSQLQuery(
      connection.database_id,
      sql,
      parameters,
      testValues
    );
    setTestResult(result);
    setTesting(false);
  }

  function handleSubmit(event) {
    event.preventDefault();
    // The modal is rendered in a portal inside the parent Agent Skills form.
    // Stop this submit from bubbling and saving the parent's stale connection state.
    event.stopPropagation();
    if (!title.trim() || !description.trim() || !sql.trim()) {
      return showToast("Add a title, description, and SELECT query.", "error");
    }
    if (parameters.some((parameter) => !parameter.description.trim())) {
      return showToast("Describe each query parameter for the agent.", "error");
    }
    onSubmit({
      id: existingQuery?.id || createId(),
      title: title.trim(),
      description: description.trim(),
      examples: examples
        .split(/\r?\n/)
        .map((example) => example.trim())
        .filter(Boolean)
        .slice(0, 20),
      sql: sql.trim(),
      parameters,
    });
    onClose();
  }

  return createPortal(
    <Modal isOpen={isOpen} onClose={onClose} size="xl" noPortal className="!z-[1000]">
      <ModalHeader
        title={existingQuery ? "Edit saved SQL query" : "New saved SQL query"}
        onClose={onClose}
      />
      <form onSubmit={handleSubmit} className="flex max-h-[78vh] flex-col gap-4 overflow-y-auto">
        <p className="text-sm text-zinc-400 light:text-slate-600">
          The agent uses the title and description to choose this query. Use
          placeholders like <code>{"{{start_date}}"}</code> for values that
          should come from the user's question.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            required
            className="rounded-lg border border-white/10 bg-zinc-800 p-2 light:border-slate-300 light:bg-white"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Description and when to use it
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
            rows={3}
            required
            className="rounded-lg border border-white/10 bg-zinc-800 p-2 light:border-slate-300 light:bg-white"
            placeholder="Explains billed revenue by period and optionally by payer. Use for questions about faturamento."
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Example questions and alternate wording
          <textarea
            value={examples}
            onChange={(event) => setExamples(event.target.value)}
            maxLength={4000}
            rows={3}
            className="rounded-lg border border-white/10 bg-zinc-800 p-2 light:border-slate-300 light:bg-white"
            placeholder={
              "qual valor faturado em maio?\nmostre o faturamento do Clinic no mês passado\nquanto faturamos por convênio?"
            }
          />
          <span className="text-xs text-zinc-400">
            Add common phrases users may say. The agent uses these examples to find the right query.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Read-only SQL template
          <textarea
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            rows={9}
            required
            spellCheck={false}
            className="rounded-lg border border-white/10 bg-zinc-800 p-3 font-mono text-xs light:border-slate-300 light:bg-white"
            placeholder={
              "SELECT ...\nWHERE DataFaturamento >= {{start_date}}\n  AND DataFaturamento < {{end_date}}"
            }
          />
        </label>

        {parameters.length > 0 && (
          <div className="flex flex-col gap-3 rounded-lg border border-white/10 p-3 light:border-slate-300">
            <p className="font-semibold">Parameters and test values</p>
            {parameters.map((parameter) => (
              <div key={parameter.name} className="grid gap-2 rounded-md bg-zinc-800/60 p-3 light:bg-slate-100 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <code>{`{{${parameter.name}}}`}</code>
                    <select
                      value={parameter.type}
                      onChange={(event) => updateParameter(parameter.name, "type", event.target.value)}
                      className="rounded border border-white/10 bg-zinc-900 p-1 text-xs light:border-slate-300 light:bg-white"
                    >
                      <option value="string">Text</option>
                      <option value="date">Date</option>
                      <option value="integer">Integer</option>
                      <option value="number">Number</option>
                      <option value="boolean">True / false</option>
                    </select>
                  </div>
                  <input
                    value={parameter.description}
                    onChange={(event) => updateParameter(parameter.name, "description", event.target.value)}
                    placeholder="Tell the agent what value to use"
                    className="rounded border border-white/10 bg-zinc-900 p-2 text-xs light:border-slate-300 light:bg-white"
                  />
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={!parameter.required}
                      onChange={(event) => updateParameter(parameter.name, "required", !event.target.checked)}
                    />
                    Optional filter
                  </label>
                </div>
                <label className="flex flex-col gap-2 text-xs">
                  Value used by the test
                  <input
                    type={parameter.type === "date" ? "date" : parameter.type === "number" || parameter.type === "integer" ? "number" : "text"}
                    step={parameter.type === "number" ? "any" : undefined}
                    value={testValues[parameter.name] || ""}
                    onChange={(event) => setTestValues((current) => ({ ...current, [parameter.name]: event.target.value }))}
                    placeholder={parameter.required ? "Required for test" : "Leave blank to test without filter"}
                    className="rounded border border-white/10 bg-zinc-900 p-2 text-xs light:border-slate-300 light:bg-white"
                  />
                </label>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="button" onClick={handleTest} disabled={testing} className="rounded-lg border border-sky-500 px-4 py-2 text-sm text-sky-300 disabled:opacity-50">
            {testing ? "Testing…" : "Test query"}
          </button>
          {testResult?.success && <span className="text-xs text-emerald-400">Query ran. Showing up to 20 rows.</span>}
          {testResult && !testResult.success && <span className="text-xs text-red-400">{testResult.error}</span>}
        </div>

        {testResult?.success && (
          <div className="max-w-full overflow-x-auto rounded-lg border border-white/10 light:border-slate-300">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-zinc-800 light:bg-slate-100">
                <tr>{testResult.columns.map((column) => <th key={column.name} className="whitespace-nowrap p-2">{column.name}<span className="ml-1 text-zinc-500">({column.type})</span></th>)}</tr>
              </thead>
              <tbody>
                {testResult.rows.map((row, index) => (
                  <tr key={index} className="border-t border-white/10 light:border-slate-200">
                    {testResult.columns.map((column) => <td key={column.name} className="max-w-[260px] truncate p-2">{row[column.name] == null ? "NULL" : String(row[column.name])}</td>)}
                  </tr>
                ))}
                {testResult.rows.length === 0 && <tr><td colSpan={Math.max(testResult.columns.length, 1)} className="p-3 text-zinc-400">The query returned no rows.</td></tr>}
              </tbody>
            </table>
            <p className="p-2 text-xs text-zinc-500">{testResult.count} rows returned{testResult.truncated ? "; preview is limited to 20 rows" : ""}.</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-white/10 pt-4 light:border-slate-200">
          <button type="button" onClick={onClose} className="rounded-lg border border-white/20 px-4 py-2 text-sm light:border-slate-300">Cancel</button>
          <button type="submit" className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white">Save query</button>
        </div>
      </form>
    </Modal>,
    document.body
  );
}
