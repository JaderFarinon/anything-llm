import { useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import CTAButton from "@/components/lib/CTAButton";
import Admin from "@/models/admin";
import showToast from "@/utils/toast";

export default function AdminCompanies() {
  const [companies, setCompanies] = useState([]);
  const [users, setUsers] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function reload() {
    const [companyList, options] = await Promise.all([
      Admin.companies(),
      Admin.companyOptions(),
    ]);
    setCompanies(companyList);
    setUsers(options.users || []);
    setWorkspaces(options.workspaces || []);
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  async function createCompany(event) {
    event.preventDefault();
    setSaving(true);
    const result = await Admin.createCompany(name);
    setSaving(false);
    if (!result.company) {
      showToast(result.error || "Não foi possível cadastrar a empresa.", "error");
      return;
    }
    setName("");
    showToast("Empresa cadastrada.", "success");
    await reload();
  }

  async function saveMembers(companyId, userIds) {
    const result = await Admin.updateCompanyMembers(companyId, userIds);
    if (!result.company) {
      showToast(result.error || "Não foi possível salvar os usuários.", "error");
      return;
    }
    showToast("Usuários da empresa atualizados.", "success");
    await reload();
  }

  async function assignWorkspace(companyId, workspaceId) {
    const result = await Admin.setCompanyWorkspace(companyId, workspaceId);
    if (!result.company) {
      showToast(result.error || "Não foi possível associar o workspace.", "error");
      return;
    }
    showToast("Workspace associado à empresa.", "success");
    await reload();
  }

  async function unassignWorkspace(workspaceId) {
    const result = await Admin.clearCompanyWorkspace(workspaceId);
    if (!result.success) {
      showToast(result.error || "Não foi possível remover a associação.", "error");
      return;
    }
    showToast("Workspace desvinculado da empresa.", "success");
    await reload();
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <p className="text-lg leading-6 font-bold text-theme-text-primary">
              Empresas
            </p>
            <p className="text-xs leading-[18px] text-theme-text-secondary">
              Cadastre empresas, associe usuários (que podem pertencer a mais de
              uma empresa) e vincule workspaces. Os usuários recebem acesso aos
              workspaces das empresas às quais pertencem.
            </p>
          </div>

          <form onSubmit={createCompany} className="flex gap-3 mt-5 mb-7">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nome da empresa"
              maxLength={100}
              className="w-full max-w-md h-[36px] rounded-lg px-3 bg-theme-bg-primary border border-white/10 text-theme-text-primary"
            />
            <CTAButton disabled={saving || name.trim().length < 2}>
              {saving ? "Salvando…" : "Cadastrar empresa"}
            </CTAButton>
          </form>

          {loading ? (
            <p className="text-sm text-theme-text-secondary">Carregando…</p>
          ) : companies.length === 0 ? (
            <p className="text-sm text-theme-text-secondary">
              Nenhuma empresa cadastrada.
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {companies.map((company) => (
                <CompanyCard
                  key={company.id}
                  company={company}
                  users={users}
                  workspaces={workspaces}
                  onSaveMembers={saveMembers}
                  onAssignWorkspace={assignWorkspace}
                  onUnassignWorkspace={unassignWorkspace}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CompanyCard({
  company,
  users,
  workspaces,
  onSaveMembers,
  onAssignWorkspace,
  onUnassignWorkspace,
}) {
  const currentUsers = useMemo(
    () => new Set(company.members.map(({ userId }) => userId)),
    [company.members]
  );
  const [selectedUsers, setSelectedUsers] = useState(currentUsers);
  const assignedWorkspaceIds = new Set(company.workspaces.map(({ id }) => id));
  const availableWorkspaces = workspaces.filter(
    ({ companyId }) => !companyId || companyId === company.id
  );

  useEffect(() => setSelectedUsers(currentUsers), [currentUsers]);

  return (
    <section className="rounded-xl border border-white/10 bg-theme-bg-primary p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold text-theme-text-primary">
            {company.name}
          </h2>
          <p className="text-xs text-theme-text-secondary">
            {company.members.length} usuário(s) · {company.workspaces.length} workspace(s)
          </p>
        </div>
        <CTAButton
          onClick={() => onSaveMembers(company.id, [...selectedUsers])}
        >
          Salvar usuários
        </CTAButton>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-medium text-theme-text-primary mb-2">
            Usuários da empresa
          </h3>
          <div className="max-h-56 overflow-y-auto flex flex-col gap-2">
            {users.map((user) => (
              <label
                key={user.id}
                className="flex items-center gap-2 text-sm text-theme-text-secondary"
              >
                <input
                  type="checkbox"
                  checked={selectedUsers.has(user.id)}
                  onChange={(event) => {
                    setSelectedUsers((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(user.id);
                      else next.delete(user.id);
                      return next;
                    });
                  }}
                />
                {user.username} <span className="opacity-60">({user.role})</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-theme-text-primary mb-2">
            Workspaces da empresa
          </h3>
          <div className="flex gap-2 mb-3">
            <select
              defaultValue=""
              onChange={(event) => {
                const workspaceId = Number(event.target.value);
                if (workspaceId) onAssignWorkspace(company.id, workspaceId);
                event.target.value = "";
              }}
              className="min-w-0 flex-1 h-[36px] rounded-lg px-3 bg-theme-bg-secondary border border-white/10 text-theme-text-primary"
            >
              <option value="" disabled>
                Associar workspace…
              </option>
              {availableWorkspaces
                .filter(({ id }) => !assignedWorkspaceIds.has(id))
                .map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            {company.workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="flex items-center justify-between gap-3 text-sm text-theme-text-secondary"
              >
                <span>{workspace.name}</span>
                <button
                  onClick={() => onUnassignWorkspace(workspace.id)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Desvincular
                </button>
              </div>
            ))}
            {!company.workspaces.length && (
              <p className="text-xs text-theme-text-secondary">
                Nenhum workspace associado.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
