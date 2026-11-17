import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import Modal, {
  ModalHeader,
  ModalLabel,
  ModalInput,
  ModalPrimaryButton,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import { WarningOctagon } from "@phosphor-icons/react";
import { DB_LOGOS } from "./DBConnection";
import System from "@/models/system";
import Admin from "@/models/admin";
import showToast from "@/utils/toast";
import Toggle from "@/components/lib/Toggle";

/**
 * Converts a string to a URL-friendly slug format.
 * Matches backend slugify behavior for consistent database_id generation.
 * @param {string} str - The string to slugify
 * @returns {string} - The slugified string (lowercase, hyphens, no special chars)
 */
function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove special characters
    .replace(/[\s_]+/g, "-") // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ""); // Remove leading/trailing hyphens
}

/**
 * Assembles a database connection string based on the engine type and configuration.
 * @param {Object} params - Connection parameters
 * @param {string} params.engine - The database engine ('postgresql', 'mysql', or 'sql-server')
 * @param {string} [params.username=""] - Database username
 * @param {string} [params.password=""] - Database password
 * @param {string} [params.host=""] - Database host/endpoint
 * @param {string} [params.port=""] - Database port
 * @param {string} [params.database=""] - Database name
 * @param {boolean} [params.encrypt=false] - Enable encryption (SQL Server only)
 * @param {boolean} [params.ssl=false] - Connect over SSL/TLS without certificate verification
 * @returns {string|null} - The assembled connection string, error message if fields missing, or null if engine invalid
 */
function assembleConnectionString({
  engine,
  username = "",
  password = "",
  host = "",
  port = "",
  database = "",
  encrypt = false,
  ssl = false,
}) {
  if ([username, password, host, database].every((i) => !!i) === false)
    return `Please fill out all the fields above.`;
  username = encodeURIComponent(username);
  password = encodeURIComponent(password);
  database = encodeURIComponent(database);
  // SSL is encrypt-without-verification to allow self-signed
  const pgSsl = ssl ? "?sslmode=no-verify" : "";
  switch (engine) {
    case "postgresql":
      return `postgres://${username}:${password}@${host}:${port}/${database}${pgSsl}`;
    case "mysql":
      return `mysql://${username}:${password}@${host}:${port}/${database}`;
    case "sql-server":
      return `mssql://${username}:${password}@${host}:${port}/${database}?encrypt=${encrypt}`;
    default:
      return null;
  }
}

const DEFAULT_ENGINE = "postgresql";
const DEFAULT_CONFIG = {
  name: "",
  description: "",
  accessScope: "global",
  accessScopeId: null,
  username: null,
  password: null,
  host: null,
  port: null,
  database: null,
  schema: null,
  encrypt: false,
  ssl: false,
};

/**
 * Modal component for creating or editing SQL database connections.
 * Supports PostgreSQL, MySQL, and SQL Server with connection validation.
 * Handles duplicate connection name detection and connection string assembly.
 *
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the modal is currently open
 * @param {Function} props.closeModal - Callback to close the modal
 * @param {Function} props.onSubmit - Callback when connection is successfully validated and saved
 * @param {Function} props.setHasChanges - Callback to mark that changes have been made
 * @param {Object|null} [props.existingConnection=null] - Existing connection data for edit mode (contains database_id, engine, username, password, host, port, database, schema, encrypt)
 * @param {Array} [props.connections=[]] - List of all existing connections for duplicate detection
 * @returns {React.ReactPortal|null} - Portal containing the modal UI, or null if not open
 */
export default function SQLConnectionModal({
  isOpen,
  closeModal,
  onSubmit,
  setHasChanges,
  existingConnection = null, // { database_id, engine } for edit mode
  connections = [], // List of all existing connections for duplicate detection
}) {
  const isEditMode = !!existingConnection;
  const [engine, setEngine] = useState(DEFAULT_ENGINE);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [scopeTargets, setScopeTargets] = useState({
    companies: [],
    users: [],
    workspaces: [],
  });
  const [isValidating, setIsValidating] = useState(false);

  // Sync state when modal opens - useState initial values only run once on mount,
  // so we need this effect to update state when the modal is reopened
  useEffect(() => {
    if (!isOpen) return;

    if (existingConnection) {
      setEngine(existingConnection.engine);
      setConfig({
        name: existingConnection.database_id,
        description: existingConnection.description || "",
        accessScope: existingConnection.accessScope || "global",
        accessScopeId: existingConnection.accessScopeId || null,
        username: existingConnection.username,
        password: existingConnection.password,
        host: existingConnection.host,
        port: existingConnection.port,
        database: existingConnection.database,
        schema: existingConnection.schema,
        encrypt: existingConnection?.encrypt,
        ssl: existingConnection?.ssl,
      });
    } else {
      setEngine(DEFAULT_ENGINE);
      setConfig(DEFAULT_CONFIG);
    }

    Promise.all([Admin.companyOptions(), Admin.companies()]).then(
      ([options, companies]) =>
        setScopeTargets({
          companies,
          users: options.users || [],
          workspaces: options.workspaces || [],
        })
    );
  }, [isOpen, existingConnection]);

  // Track original database ID to send to server for updating if in edit mode
  const originalDatabaseId = isEditMode ? existingConnection.database_id : null;
  const targetLabelForScope =
    config.accessScope === "user"
      ? "Usuário"
      : config.accessScope === "workspace"
        ? "Workspace"
        : "Empresa";
  const availableScopeTargets =
    config.accessScope === "user"
      ? scopeTargets.users.map((target) => ({
          id: target.id,
          label: target.username || `Usuário ${target.id}`,
        }))
      : config.accessScope === "workspace"
        ? scopeTargets.workspaces.map((target) => ({
            id: target.id,
            label: target.name,
          }))
        : scopeTargets.companies.map((target) => ({
            id: target.id,
            label: target.name,
          }));

  if (!isOpen) return null;

  function handleClose() {
    setEngine(DEFAULT_ENGINE);
    setConfig(DEFAULT_CONFIG);
    closeModal();
  }

  function onFormChange(e) {
    if (["accessRestricted", "accessScope", "accessScopeId"].includes(e.target.name))
      return;
    const form = new FormData(e.target.form);
    setConfig((current) => ({
      ...current,
      name: form.get("name").trim(),
      description: form.get("description").trim(),
      username: form.get("username").trim(),
      password: form.get("password"),
      host: form.get("host").trim(),
      port: form.get("port").trim(),
      database: form.get("database").trim(),
      schema: form.get("schema")?.trim() || null,
      encrypt: form.get("encrypt") === "true",
      ssl: form.get("ssl") === "true",
    }));
  }

  function updateAccessScope(e) {
    const { name, value, checked } = e.target;
    setConfig((current) => {
      if (name === "accessRestricted") {
        return checked
          ? {
              ...current,
              accessScope:
                current.accessScope === "global" ? "company" : current.accessScope,
              accessScopeId: null,
            }
          : { ...current, accessScope: "global", accessScopeId: null };
      }
      if (name === "accessScope")
        return { ...current, accessScope: value, accessScopeId: null };
      return { ...current, accessScopeId: value ? Number(value) : null };
    });
  }

  /**
   * Checks if a connection name (slugified) already exists in the connections list.
   * For edit mode, excludes the original connection being edited.
   * @param {string} slugifiedName - The slugified name to check
   * @returns {boolean} - True if duplicate exists, false otherwise
   */
  function isDuplicateConnectionName(slugifiedName) {
    // Get active connections (not marked for removal)
    const activeConnections = connections.filter(
      (conn) => conn.action !== "remove"
    );

    // Check for duplicates, excluding the original connection in edit mode
    return activeConnections.some((conn) => {
      // In edit mode, skip the original connection being edited
      if (isEditMode && conn.database_id === originalDatabaseId) {
        return false;
      }
      return conn.database_id === slugifiedName;
    });
  }

  /**
   * Handles form submission for both creating new connections and updating existing ones.
   * Process:
   * 1. Slugify the connection name to match backend behavior
   * 2. Check for duplicate names (prevents frontend from sending invalid updates)
   * 3. Validate the connection string by attempting to connect to the database
   * 4. If valid, submit with appropriate action ("add" or "update")
   *
   * For updates: Includes originalDatabaseId so backend can find and replace the old connection
   * For new connections: Just includes the new connection data
   */
  async function handleUpdate(e) {
    e.preventDefault();
    e.stopPropagation();
    const form = new FormData(e.target);
    const connectionString = assembleConnectionString({ engine, ...config });
    const connectionDescription = form.get("description")?.trim() || "";
    const accessScope = config.accessScope || "global";
    const accessScopeId =
      accessScope === "global" ? null : Number(config.accessScopeId);

    if (!connectionDescription) {
      showToast("Descreva de qual sistema esta conexão traz os dados.", "error", {
        clear: true,
      });
      return;
    }
    if (accessScope !== "global" && (!accessScopeId || !Number.isInteger(accessScopeId))) {
      showToast("Selecione a empresa, workspace ou usuário do escopo restrito.", "error", {
        clear: true,
      });
      return;
    }

    // Slugify the database_id immediately to match backend behavior
    const slugifiedDatabaseId = slugify(form.get("name"));

    // Check for duplicate connection names before validation
    if (isDuplicateConnectionName(slugifiedDatabaseId)) {
      showToast(
        `A connection with the name "${slugifiedDatabaseId}" already exists. Please choose a different name.`,
        "error",
        { clear: true }
      );
      return;
    }

    setIsValidating(true);
    try {
      // Validate that we can actually connect to this database
      const { success, error } = await System.validateSQLConnection(
        engine,
        connectionString
      );
      if (!success) {
        showToast(
          error ||
            "Failed to establish database connection. Please check your connection details.",
          "error",
          { clear: true }
        );
        setIsValidating(false);
        return;
      }

      const connectionData = {
        engine,
        database_id: slugifiedDatabaseId,
        description: connectionDescription,
        accessScope,
        accessScopeId,
        connectionString,
        schema: engine === "postgresql" ? config.schema : null,
      };

      if (isEditMode) {
        // EDIT MODE: Send update action with originalDatabaseId
        // This tells the backend to find the connection with originalDatabaseId
        // and replace it with the new connection data
        onSubmit({
          ...connectionData,
          action: "update",
          originalDatabaseId: originalDatabaseId,
        });
      } else {
        // CREATE MODE: Send add action
        // Backend will check for duplicates and add if unique
        onSubmit({
          ...connectionData,
          action: "add",
        });
      }

      setHasChanges(true);
      handleClose();
    } catch (error) {
      console.error("Error validating connection:", error);
      showToast(
        error?.message ||
          "Failed to validate connection. Please check your connection details.",
        "error",
        { clear: true }
      );
    } finally {
      setIsValidating(false);
    }
    return false;
  }

  // Cannot do nested forms, it will cause all sorts of issues, so we portal this out
  // to the parent container form so we don't have nested forms.
  return createPortal(
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="lg"
      noPortal
      className="!z-[1000]"
    >
      <ModalHeader
        title={isEditMode ? "Edit SQL Connection" : "New SQL Connection"}
        onClose={handleClose}
      />
      <form
        id="sql-connection-form"
        onChange={onFormChange}
        onSubmit={handleUpdate}
        className="flex flex-col gap-y-5 w-full"
      >
        <div className="space-y-6">
          <p className="text-sm text-zinc-400 light:text-slate-600">
            {isEditMode
              ? "Update the connection information for your database below."
              : "Add the connection information for your database below and it will be available for future SQL agent calls."}
          </p>
          <div className="flex flex-col w-full">
            <div className="border border-red-800 bg-zinc-800 light:bg-red-200/50 p-4 rounded-lg flex items-center gap-x-2 text-sm text-red-400 light:text-red-500">
              <WarningOctagon size={28} className="shrink-0" />
              <p>
                <b>READ ONLY:</b> The server accepts only read queries and
                limits SQL Server execution time and returned rows. This is not
                a substitute for database permissions: connect with a user
                that has <b>READ_ONLY</b> access.
              </p>
            </div>

            <ModalLabel className="mt-4 mb-2">
              Select your SQL engine
            </ModalLabel>
            <div className="grid md:grid-cols-4 gap-4 grid-cols-2">
              <DBEngine
                provider="postgresql"
                active={engine === "postgresql"}
                onClick={() => setEngine("postgresql")}
              />
              <DBEngine
                provider="mysql"
                active={engine === "mysql"}
                onClick={() => setEngine("mysql")}
              />
              <DBEngine
                provider="sql-server"
                active={engine === "sql-server"}
                onClick={() => setEngine("sql-server")}
              />
            </div>
          </div>

          <ModalInput
            label="Connection name"
            type="text"
            name="name"
            placeholder="a unique name to identify this SQL connection"
            required={true}
            autoComplete="off"
            spellCheck={false}
            defaultValue={config.name || ""}
          />

          <label className="flex flex-col gap-2 text-sm text-theme-text-primary">
            Descrição da origem dos dados
            <textarea
              name="description"
              value={config.description || ""}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              maxLength={2000}
              rows={3}
              required
              className="rounded-lg border border-white/10 bg-zinc-800 p-2 text-sm light:border-slate-300 light:bg-white"
              placeholder="Ex.: Clinic é o sistema de gestão clínica. Esta conexão contém cadastros de médicos, agendas, exames e faturamento."
            />
            <span className="text-xs text-theme-text-secondary">
              Esse contexto ajuda o agente a identificar quando consultar este sistema e será indexado no banco vetorial. Depois de validar, clique em Salvar no aviso no topo da página para persistir a alteração.
            </span>
          </label>

          <div className="rounded-lg border border-white/10 p-3 light:border-slate-200">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-theme-text-primary">
                Disponibilidade da conexão
                <select
                  name="accessScope"
                  value={config.accessScope || "global"}
                  onChange={updateAccessScope}
                  className="rounded-lg border border-white/10 bg-zinc-800 p-2 light:border-slate-300 light:bg-white"
                >
                  <option value="global">Todos os usuários com acesso ao SQL</option>
                  <option value="company">Uma empresa</option>
                  <option value="workspace">Um workspace</option>
                  <option value="user">Um usuário</option>
                </select>
              </label>
              {(config.accessScope || "global") !== "global" && (
                <label className="flex flex-col gap-1 text-sm text-theme-text-primary">
                  {targetLabelForScope}
                  <select
                    name="accessScopeId"
                    value={config.accessScopeId || ""}
                    onChange={updateAccessScope}
                    required
                    className="rounded-lg border border-white/10 bg-zinc-800 p-2 light:border-slate-300 light:bg-white"
                  >
                    <option value="">Selecione...</option>
                    {availableScopeTargets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="text-xs text-theme-text-secondary sm:col-span-2">
                {(config.accessScope || "global") === "global"
                  ? "A conexão é limitada aos usuários que já podem usar o agente SQL."
                  : config.accessScope === "company"
                    ? "Disponível para membros da empresa quando conversarem em workspaces dessa empresa ou em workspaces sem empresa definida."
                    : config.accessScope === "workspace"
                      ? "Disponível somente nas conversas deste workspace."
                      : "Disponível somente para o usuário selecionado, nos workspaces aos quais ele tem acesso."}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ModalInput
              label="Database user"
              type="text"
              name="username"
              placeholder="root"
              required={true}
              autoComplete="off"
              spellCheck={false}
              defaultValue={config.username || ""}
            />
            <ModalInput
              label="Database user password"
              type="password"
              name="password"
              placeholder="password123"
              required={true}
              autoComplete="off"
              spellCheck={false}
              defaultValue={config.password || ""}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <ModalInput
                label="Server endpoint"
                type="text"
                name="host"
                placeholder="the hostname or endpoint for your database"
                required={true}
                autoComplete="off"
                spellCheck={false}
                defaultValue={config.host || ""}
              />
            </div>
            <ModalInput
              label="Port"
              type="text"
              name="port"
              placeholder="3306"
              required={false}
              autoComplete="off"
              spellCheck={false}
              defaultValue={config.port || ""}
            />
          </div>

          <ModalInput
            label="Database"
            type="text"
            name="database"
            placeholder="the database the agent will interact with"
            required={true}
            autoComplete="off"
            spellCheck={false}
            defaultValue={config.database || ""}
          />

          {engine === "postgresql" && (
            <ModalInput
              label="Schema (optional)"
              type="text"
              name="schema"
              placeholder="public (default schema if not specified)"
              required={false}
              autoComplete="off"
              spellCheck={false}
              defaultValue={config.schema || ""}
            />
          )}

          {engine === "sql-server" && (
            <Toggle
              name="encrypt"
              value="true"
              size="md"
              label="Enable Encryption"
              enabled={config.encrypt}
            />
          )}

          {engine === "postgresql" && (
            <Toggle
              name="ssl"
              value="true"
              size="md"
              label="Use SSL"
              enabled={config.ssl}
            />
          )}

          <p className="text-zinc-400 light:text-slate-500 text-sm">
            {assembleConnectionString({ engine, ...config })}
          </p>
        </div>
        <div className="flex justify-between items-center w-full">
          <ModalSecondaryButton type="button" onClick={handleClose}>
            Cancel
          </ModalSecondaryButton>
          <ModalPrimaryButton
            type="submit"
            form="sql-connection-form"
            disabled={isValidating}
          >
            {isValidating ? "Validando conexão..." : "Validar e aplicar alterações"}
          </ModalPrimaryButton>
        </div>
      </form>
    </Modal>,
    document.getElementById("workspace-agent-settings-container")
  );
}

/**
 * Database engine selection button component.
 * Displays a database logo and handles selection state.
 *
 * @param {Object} props - Component props
 * @param {string} props.provider - The database provider identifier ('postgresql', 'mysql', 'sql-server')
 * @param {boolean} props.active - Whether this engine is currently selected
 * @param {Function} props.onClick - Callback when the engine is clicked
 * @returns {JSX.Element} - Button element with database logo
 */
function DBEngine({ provider, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col p-4 border border-white/40 bg-zinc-800 light:bg-theme-settings-input-bg rounded-lg w-fit hover:bg-zinc-700 ${
        active ? "!bg-blue-500/50" : ""
      }`}
    >
      <img
        src={DB_LOGOS[provider]}
        className="h-[100px] rounded-md"
        alt={provider}
      />
    </button>
  );
}
