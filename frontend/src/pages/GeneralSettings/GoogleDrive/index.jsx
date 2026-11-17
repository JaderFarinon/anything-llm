import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Sidebar from "@/components/SettingsSidebar";
import CTAButton from "@/components/lib/CTAButton";
import useUser from "@/hooks/useUser";
import Admin from "@/models/admin";
import GoogleDrive from "@/models/googleDrive";
import showToast from "@/utils/toast";
import { isMobile } from "react-device-detect";

export default function GoogleDriveSettings() {
  const { user } = useUser();
  const isAdmin = user?.role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();
  const [connections, setConnections] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [pendingFolders, setPendingFolders] = useState([]);
  const [adminFolders, setAdminFolders] = useState([]);
  const [folderFiles, setFolderFiles] = useState({});
  const [loadingFileFolder, setLoadingFileFolder] = useState(null);
  const [activeConnection, setActiveConnection] = useState(null);
  const [driveFolders, setDriveFolders] = useState([]);
  const [selectedFolders, setSelectedFolders] = useState([]);
  const [folderQuery, setFolderQuery] = useState("");
  const [companyWorkspace, setCompanyWorkspace] = useState("");
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [addingFolders, setAddingFolders] = useState(false);

  async function reload() {
    const [connectionResponse, companyList] = await Promise.all([
      GoogleDrive.connections().catch(() => ({ connections: [] })),
      isAdmin ? Admin.companies() : Promise.resolve([]),
    ]);
    setConnections(connectionResponse.connections || []);
    setCompanies(companyList);
    if (isAdmin) {
      const [pending, allFolders] = await Promise.all([
        GoogleDrive.pendingFolders().catch(() => ({ folders: [] })),
        GoogleDrive.adminFolders().catch(() => ({ folders: [] })),
      ]);
      setPendingFolders(pending.folders || []);
      setAdminFolders(allFolders.folders || []);
    }
  }

  useEffect(() => {
    reload();
  }, [isAdmin]);

  useEffect(() => {
    const connected = searchParams.get("connected");
    const driveError = searchParams.get("driveError");
    if (connected) {
      showToast(
        connected === "company"
          ? "Conta Google da empresa conectada."
          : "Sua conta Google foi conectada.",
        "success"
      );
      setSearchParams({}, { replace: true });
      reload();
    } else if (driveError) {
      showToast("Não foi possível conectar o Google Drive. Confira a configuração e tente novamente.", "error");
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  async function connect(scope, companyId = null) {
    try {
      const { authorizationUrl } = await GoogleDrive.connect({ scope, companyId });
      window.location.assign(authorizationUrl);
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function openFolderPicker(connection) {
    setActiveConnection(connection);
    setFolderQuery("");
    const defaultWorkspace = connection.company?.id
      ? companies.find(({ id }) => id === connection.company.id)?.workspaces?.[0]?.id
      : null;
    setCompanyWorkspace(defaultWorkspace ? String(defaultWorkspace) : "");
    setLoadingFolders(true);
    try {
      const folders = [];
      let pageToken = null;
      do {
        const result = await GoogleDrive.folders(connection.id, { pageToken });
        folders.push(...(result.files || []));
        pageToken = result.nextPageToken || null;
      } while (pageToken);
      setDriveFolders(folders);
      const activeSources = (connection.folders || []).filter(({ status }) =>
        ["pending", "approved"].includes(status)
      );
      const selectedById = new Map(
        activeSources.map(({ driveFolderId, name }) => [driveFolderId, { id: driveFolderId, name }])
      );
      const folderTree = buildFolderTree(folders);
      for (const source of activeSources) {
        for (const id of getFolderBranchIds(source.driveFolderId, folderTree)) {
          const folder = folders.find(({ id: folderId }) => folderId === id);
          if (folder) selectedById.set(id, folder);
        }
      }
      setSelectedFolders([...selectedById.values()]);
    } catch (error) {
      showToast(error.message, "error");
      setActiveConnection(null);
    } finally {
      setLoadingFolders(false);
    }
  }

  function toggleFolderBranch(folderId, checked) {
    const branchIds = new Set(getFolderBranchIds(folderId, folderTree));
    setSelectedFolders((current) => {
      const next = new Map(current.map((folder) => [folder.id, folder]));
      if (checked) {
        for (const folder of driveFolders) {
          if (branchIds.has(folder.id) && !blockedFolderIds.has(folder.id)) next.set(folder.id, folder);
        }
      } else {
        for (const id of branchIds) next.delete(id);
      }
      return [...next.values()];
    });
  }

  function toggleAllFolders(checked) {
    setSelectedFolders(checked ? selectableFolders : []);
  }

  async function saveFolderSelection() {
    if (!activeConnection) return;
    const desiredFolders = getSelectedRootFolders(selectedFolders, folderTree);
    const activeFolders = (activeConnection.folders || []).filter(({ status }) =>
      ["pending", "approved"].includes(status)
    );
    const desiredIds = new Set(selectedFolders.map(({ id }) => id));
    const activeByDriveId = new Map(activeFolders.map((folder) => [folder.driveFolderId, folder]));
    const additions = desiredFolders.filter(({ id }) => !activeByDriveId.has(id));
    const removals = activeFolders.filter(({ driveFolderId }) => !desiredIds.has(driveFolderId));
    if (!additions.length && !removals.length) {
      setActiveConnection(null);
      return;
    }
    if (activeConnection.scope === "company" && additions.length && !companyWorkspace) {
      showToast("Escolha o workspace da empresa antes de adicionar as pastas.", "error");
      return;
    }

    setAddingFolders(true);
    let addedCount = 0;
    let removedCount = 0;
    const addedRoots = [];
    const failures = [];
    try {
      for (const folder of additions) {
        try {
          await GoogleDrive.addFolder(activeConnection.id, {
            folderId: folder.id,
            name: folder.name,
            workspaceId: companyWorkspace || null,
          });
          addedCount += 1;
          addedRoots.push(folder);
        } catch (error) {
          failures.push(folder.name + ": " + error.message);
        }
      }
      for (const folder of removals) {
        try {
          await GoogleDrive.removeFolder(folder.id);
          removedCount += 1;
        } catch (error) {
          failures.push(folder.name + ": " + error.message);
        }
      }
      if (addedCount || removedCount) {
        const coveredFolderCount = addedRoots.reduce(
          (count, folder) => count + getFolderBranchIds(folder.id, folderTree).length,
          0
        );
        const coveredSubfolderCount = Math.max(0, coveredFolderCount - addedRoots.length);
        const addedMessage = addedCount
          ? activeConnection.scope === "personal"
            ? addedCount + (addedCount === 1 ? " pasta principal enviada para aprovação" : " pastas principais enviadas para aprovação")
            : addedCount + (addedCount === 1 ? " pasta principal adicionada" : " pastas principais adicionadas")
          : "";
        const coverageMessage = addedCount && coveredSubfolderCount
          ? " A varredura inclui também " + coveredSubfolderCount + (coveredSubfolderCount === 1 ? " subpasta." : " subpastas.")
          : "";
        const removedMessage = removedCount
          ? removedCount + (removedCount === 1 ? " pasta removida" : " pastas removidas")
          : "";
        showToast([addedMessage, removedMessage].filter(Boolean).join(" · ") + "." + coverageMessage, "success");
        await reload();
      }
      if (failures.length) {
        showToast(failures.length + " alterações falharam. " + failures[0], "error");
      } else {
        setActiveConnection(null);
      }
    } catch (error) {
      showToast(error.message || "Não foi possível atualizar as pastas.", "error");
    } finally {
      setAddingFolders(false);
    }
  }

  async function moderate(folderId, status) {
    try {
      await GoogleDrive.moderateFolder(folderId, status);
      showToast(
        status === "approved" ? "Pasta aprovada para indexação." : "Pasta bloqueada.",
        "success"
      );
      await reload();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function toggleFolderFiles(folderId) {
    if (Object.hasOwn(folderFiles, folderId)) {
      setFolderFiles((current) => {
        const next = { ...current };
        delete next[folderId];
        return next;
      });
      return;
    }
    setLoadingFileFolder(folderId);
    try {
      const result = await GoogleDrive.folderFiles(folderId);
      setFolderFiles((current) => ({ ...current, [folderId]: result.files || [] }));
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setLoadingFileFolder(null);
    }
  }

  async function blockFile(file, blocked) {
    try {
      await GoogleDrive.setFileBlocked(file.id, blocked);
      setFolderFiles((current) => ({
        ...current,
        [file.folderId]: current[file.folderId]?.map((item) =>
          item.id === file.id ? { ...item, blocked, status: blocked ? "blocked" : "pending" } : item
        ),
      }));
      showToast(
        blocked
          ? "Bloqueio solicitado. O conteúdo será removido do índice na próxima sincronização."
          : "Documento liberado para nova indexação.",
        "success"
      );
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  const personalConnection = connections.find(({ scope }) => scope === "personal");
  const companyConnections = useMemo(
    () => connections.filter(({ scope }) => scope === "company"),
    [connections]
  );
  const folderTree = useMemo(() => buildFolderTree(driveFolders), [driveFolders]);
  const selectedIds = useMemo(() => new Set(selectedFolders.map(({ id }) => id)), [selectedFolders]);
  const blockedFolderIds = useMemo(
    () => new Set((activeConnection?.folders || []).filter(({ status }) => status === "blocked").map(({ driveFolderId }) => driveFolderId)),
    [activeConnection]
  );
  const selectableFolders = driveFolders.filter(({ id }) => !blockedFolderIds.has(id));
  const allFoldersSelected = selectableFolders.length > 0 && selectableFolders.every(({ id }) => selectedIds.has(id));
  const filteredFolderTree = useMemo(
    () => filterFolderTree(folderTree, folderQuery.trim().toLocaleLowerCase()),
    [folderTree, folderQuery]
  );
  const selectAllRef = useRef(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.size > 0 && !allFoldersSelected;
    }
  }, [selectedIds, allFoldersSelected]);
  const selectionChanges = useMemo(() => {
    if (!activeConnection) return { additions: 0, removals: 0 };
    const desired = getSelectedRootFolders(selectedFolders, folderTree);
    const desiredIds = new Set(selectedFolders.map(({ id }) => id));
    const active = (activeConnection.folders || []).filter(({ status }) => ["pending", "approved"].includes(status));
    return {
      additions: desired.filter(({ id }) => !active.some((folder) => folder.driveFolderId === id)).length,
      removals: active.filter(({ driveFolderId }) => !desiredIds.has(driveFolderId)).length,
    };
  }, [activeConnection, folderTree, selectedFolders]);
  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <main className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16 gap-6">
          <header className="pb-5 border-white/10 border-b-2">
            <h1 className="text-lg font-bold text-theme-text-primary">Google Drive</h1>
            <p className="mt-1 text-xs leading-[18px] text-theme-text-secondary">
              Conecte pastas para indexar seus documentos e pesquisá-los nas conversas.
              Pastas pessoais passam por moderação antes de serem indexadas. A configuração OAuth fica em Habilidades do agente.
            </p>
          </header>

          {isAdmin && (
            <section className="rounded-xl border border-white/10 bg-theme-bg-primary p-5">
              <h2 className="text-base font-semibold text-theme-text-primary">Conteúdo do Google Drive</h2>
              <p className="mt-1 mb-4 text-xs text-theme-text-secondary">
                Revise os arquivos encontrados nas pastas aprovadas. Bloquear um arquivo remove seus trechos do índice vetorial.
              </p>
              {!adminFolders.length ? (
                <p className="text-xs text-theme-text-secondary">Nenhuma pasta aprovada ou aguardando moderação.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {adminFolders.map((folder) => (
                    <div key={folder.id} className="rounded-lg border border-white/10 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-theme-text-primary">{folder.name}</p>
                          <p className="text-xs text-theme-text-secondary">
                            {folder.connection.scope === "company"
                              ? `Empresa: ${folder.connection.company?.name || "—"}`
                              : `Usuário: ${folder.connection.user?.username || "—"}`} · {folder._count?.files || 0} arquivos · {folder.status}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleFolderFiles(folder.id)}
                          className="text-xs text-sky-400 hover:text-sky-300"
                        >
                          {loadingFileFolder === folder.id
                            ? "Carregando…"
                            : Object.hasOwn(folderFiles, folder.id)
                              ? "Fechar arquivos"
                              : "Ver arquivos"}
                        </button>
                      </div>
                      {Object.hasOwn(folderFiles, folder.id) && (
                        <div className="mt-3 flex flex-col divide-y divide-white/10">
                          {!folderFiles[folder.id]?.length && (
                            <p className="py-2 text-xs text-theme-text-secondary">Nenhum arquivo detectado ainda.</p>
                          )}
                          {folderFiles[folder.id]?.map((file) => (
                            <div key={file.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs text-theme-text-primary">{file.name}</p>
                                <p className="text-[11px] text-theme-text-secondary">
                                  {file.status}{file.lastError ? ` · ${file.lastError}` : ""}
                                </p>
                              </div>
                              <button
                                onClick={() => blockFile(file, !file.blocked)}
                                className={`text-xs ${file.blocked ? "text-emerald-400" : "text-red-400"}`}
                              >
                                {file.blocked ? "Liberar" : "Bloquear conteúdo"}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="rounded-xl border border-white/10 bg-theme-bg-primary p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-theme-text-primary">Meu Drive</h2>
                <p className="mt-1 text-xs text-theme-text-secondary">
                  Suas pastas ficam em um workspace privado. O admin aprova antes de indexar.
                </p>
              </div>
              {!personalConnection && (
                <CTAButton onClick={() => connect("personal")}>Conectar meu Google Drive</CTAButton>
              )}
            </div>
            {personalConnection && (
              <ConnectionCard
                connection={personalConnection}
                onChooseFolder={openFolderPicker}
                onReconnect={() => connect("personal")}
              />
            )}
          </section>

          {isAdmin && (
            <section className="rounded-xl border border-white/10 bg-theme-bg-primary p-5">
              <h2 className="text-base font-semibold text-theme-text-primary">Drives das empresas</h2>
              <p className="mt-1 mb-4 text-xs text-theme-text-secondary">
                O admin autoriza a conta Google da empresa, escolhe as pastas gerais e associa cada pasta a um workspace.
              </p>
              <div className="flex flex-col gap-3">
                {companies.map((company) => {
                  const connection = companyConnections.find(
                    ({ company: linkedCompany }) => linkedCompany?.id === company.id
                  );
                  return (
                    <div key={company.id} className="rounded-lg border border-white/10 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-theme-text-primary">{company.name}</h3>
                          {connection?.googleEmail && (
                            <p className="text-xs text-theme-text-secondary">{connection.googleEmail}</p>
                          )}
                          {connection?.lastError && (
                            <p className="mt-1 text-xs text-red-400">{connection.lastError}</p>
                          )}
                        </div>
                        {connection ? (
                          <div className="flex flex-wrap items-center gap-3">
                            <button
                              onClick={() => openFolderPicker(connection)}
                              className="text-xs text-sky-400 hover:text-sky-300"
                            >
                              Gerenciar pastas
                            </button>
                            <button
                              onClick={() => connect("company", company.id)}
                              className="text-xs text-amber-400 hover:text-amber-300"
                              title="Renova a autorização Google e preserva as pastas selecionadas."
                            >
                              Reconectar Google Drive
                            </button>
                          </div>
                        ) : (
                          <CTAButton onClick={() => connect("company", company.id)}>
                            Conectar Drive da empresa
                          </CTAButton>
                        )}
                      </div>
                      {connection && (
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
                          <p className="text-xs text-theme-text-secondary">
                            {(connection.folders || []).filter(({ status }) => ["pending", "approved"].includes(status)).length}{" "}
                            {(connection.folders || []).filter(({ status }) => ["pending", "approved"].includes(status)).length === 1
                              ? "pasta principal conectada"
                              : "pastas principais conectadas"} · subpastas incluídas
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {isAdmin && (
            <section className="rounded-xl border border-white/10 bg-theme-bg-primary p-5">
              <h2 className="text-base font-semibold text-theme-text-primary">Moderação de pastas pessoais</h2>
              <p className="mt-1 mb-4 text-xs text-theme-text-secondary">
                Pastas pendentes não são indexadas. Use bloquear para impedir que a pasta volte a ser usada.
              </p>
              {!pendingFolders.length ? (
                <p className="text-xs text-theme-text-secondary">Nenhuma pasta aguardando aprovação.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {pendingFolders.map((folder) => (
                    <div key={folder.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                      <div>
                        <p className="text-sm text-theme-text-primary">{folder.name}</p>
                        <p className="text-xs text-theme-text-secondary">
                          {folder.connection.user?.username} · {folder.connection.googleEmail}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => moderate(folder.id, "approved")} className="text-xs text-emerald-400">Aprovar</button>
                        <button onClick={() => moderate(folder.id, "rejected")} className="text-xs text-amber-400">Rejeitar</button>
                        <button onClick={() => moderate(folder.id, "blocked")} className="text-xs text-red-400">Bloquear</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeConnection && (
            <section className="rounded-xl border border-sky-500/30 bg-theme-bg-primary p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-theme-text-primary">Selecionar pasta</h2>
                  <p className="text-xs text-theme-text-secondary">{activeConnection.googleEmail}</p>
                </div>
                <button onClick={() => setActiveConnection(null)} className="text-xs text-theme-text-secondary">Fechar</button>
              </div>
              {activeConnection.scope === "company" && (
                <label className="block mb-3 text-xs text-theme-text-secondary">
                  Workspace de destino
                  <select
                    value={companyWorkspace}
                    onChange={(event) => setCompanyWorkspace(event.target.value)}
                    className="block w-full max-w-lg mt-1 h-[36px] rounded-lg px-3 bg-theme-bg-secondary border border-white/10 text-theme-text-primary"
                  >
                    <option value="">Escolha um workspace</option>
                    {companies.find(({ id }) => id === activeConnection.company?.id)?.workspaces?.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input value={folderQuery} onChange={(event) => setFolderQuery(event.target.value)} placeholder="Filtrar pastas pelo nome" className="w-full max-w-lg h-[36px] rounded-lg px-3 bg-theme-bg-secondary border border-white/10 text-theme-text-primary" />
              </div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-theme-bg-secondary px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-theme-text-secondary">
                  <input ref={selectAllRef} type="checkbox" checked={allFoldersSelected} onChange={(event) => toggleAllFolders(event.target.checked)} disabled={!selectableFolders.length || loadingFolders || addingFolders} className="h-4 w-4 accent-sky-500" />
                  Marcar todas as pastas
                </label>
                <span className="text-xs text-theme-text-secondary">
                  {selectedFolders.length} selecionadas
                  {selectionChanges.additions || selectionChanges.removals ? " · " + selectionChanges.additions + " para adicionar · " + selectionChanges.removals + " para remover" : ""}
                </span>
              </div>
              <p className="mb-3 text-[11px] text-theme-text-secondary">
                A pasta principal percorre automaticamente todo o conteúdo das subpastas. Ao marcar uma pasta mãe, suas subpastas acompanham a seleção.
              </p>
              {loadingFolders ? (
                <p className="text-xs text-theme-text-secondary">Carregando árvore de pastas…</p>
              ) : (
                <div className="max-h-96 overflow-y-auto rounded-lg border border-white/10 p-2">
                  {filteredFolderTree.length ? filteredFolderTree.map((folder) => (
                    <FolderTreeNode key={folder.id} folder={folder} selectedIds={selectedIds} blockedFolderIds={blockedFolderIds} onToggle={toggleFolderBranch} disabled={addingFolders} />
                  )) : <p className="px-2 py-3 text-xs text-theme-text-secondary">{driveFolders.length ? "Nenhuma pasta corresponde ao filtro." : "Nenhuma pasta encontrada."}</p>}
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setActiveConnection(null)} disabled={addingFolders} className="rounded-lg px-4 py-2 text-sm text-theme-text-secondary hover:bg-white/5">Cancelar</button>
                <CTAButton onClick={saveFolderSelection} disabled={loadingFolders || addingFolders}>
                  {addingFolders ? "Salvando…" : "Salvar seleção"}
                </CTAButton>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function ConnectionCard({ connection, onChooseFolder, onReconnect }) {
  const activeFolders = (connection.folders || []).filter(({ status }) => ["pending", "approved"].includes(status));
  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-theme-text-primary">Conectado: {connection.googleEmail}</p>
          <p className="mt-1 text-xs text-theme-text-secondary">{activeFolders.length} {activeFolders.length === 1 ? "pasta principal selecionada" : "pastas principais selecionadas"} · subpastas incluídas</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => onChooseFolder(connection)} className="text-xs text-sky-400">Gerenciar pastas</button>
          <button
            onClick={onReconnect}
            className="text-xs text-amber-400 hover:text-amber-300"
            title="Renova a autorização Google e preserva as pastas selecionadas."
          >
            Reconectar Google Drive
          </button>
        </div>
      </div>
      {connection.lastError && <p className="mt-2 text-xs text-red-400">{connection.lastError}</p>}
      {!activeFolders.length && <p className="mt-2 text-xs text-theme-text-secondary">Nenhuma pasta selecionada.</p>}
    </div>
  );
}

function buildFolderTree(folders) {
  const nodes = new Map(folders.map((folder) => [folder.id, { ...folder, children: [] }]));
  const roots = [];
  for (const folder of folders) {
    const node = nodes.get(folder.id);
    const parentId = (folder.parents || []).find((id) => nodes.has(id) && id !== folder.id);
    if (parentId) nodes.get(parentId).children.push(node);
    else roots.push(node);
  }
  const sort = (items) => {
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const node of items) sort(node.children);
  };
  sort(roots);
  return roots;
}

function filterFolderTree(nodes, query) {
  if (!query) return nodes;
  return nodes.reduce((matches, node) => {
    const children = filterFolderTree(node.children, query);
    if (node.name.toLocaleLowerCase().includes(query) || children.length) matches.push({ ...node, children });
    return matches;
  }, []);
}

function flattenFolderNode(node) {
  return [node, ...(node.children || []).flatMap(flattenFolderNode)];
}

function getFolderBranchIds(folderId, nodes) {
  for (const node of nodes) {
    if (node.id === folderId) return flattenFolderNode(node).map(({ id }) => id);
    const found = getFolderBranchIds(folderId, node.children || []);
    if (found.length) return found;
  }
  return [];
}

function getSelectedRootFolders(selected, tree) {
  const selectedIds = new Set(selected.map(({ id }) => id));
  const parentById = new Map();
  const visit = (node, parentId = null) => {
    if (parentId) parentById.set(node.id, parentId);
    for (const child of node.children || []) visit(child, node.id);
  };
  for (const root of tree) visit(root);
  return selected.filter(({ id }) => {
    let parentId = parentById.get(id);
    while (parentId) {
      if (selectedIds.has(parentId)) return false;
      parentId = parentById.get(parentId);
    }
    return true;
  });
}

function FolderTreeNode({ folder, selectedIds, blockedFolderIds, onToggle, disabled, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const checkboxRef = useRef(null);
  const branch = flattenFolderNode(folder).filter(({ id }) => !blockedFolderIds.has(id));
  const checkedCount = branch.filter(({ id }) => selectedIds.has(id)).length;
  const checked = branch.length > 0 && checkedCount === branch.length;
  const indeterminate = checkedCount > 0 && !checked;
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <div>
      <div className="flex min-h-9 items-center gap-2 rounded px-2 hover:bg-white/5" style={{ paddingLeft: 8 + depth * 18 }}>
        {folder.children.length ? (
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "Recolher subpastas" : "Expandir subpastas"} className="w-4 text-center text-xs text-theme-text-secondary">
            {expanded ? "▾" : "▸"}
          </button>
        ) : <span className="w-4" />}
        <input ref={checkboxRef} type="checkbox" checked={checked} onChange={(event) => onToggle(folder.id, event.target.checked)} disabled={disabled || blockedFolderIds.has(folder.id) || !branch.length} aria-label={"Selecionar pasta " + folder.name} className="h-4 w-4 accent-sky-500" />
        <span className="min-w-0 truncate text-sm text-theme-text-primary">{folder.name}</span>
        {blockedFolderIds.has(folder.id) && <span className="text-[11px] text-red-400">bloqueada pelo admin</span>}
        {folder.children.length > 0 && <span className="text-[11px] text-theme-text-secondary">{folder.children.length} subpastas</span>}
      </div>
      {expanded && folder.children.map((child) => (
        <FolderTreeNode key={child.id} folder={child} selectedIds={selectedIds} blockedFolderIds={blockedFolderIds} onToggle={onToggle} disabled={disabled} depth={depth + 1} />
      ))}
    </div>
  );
}
