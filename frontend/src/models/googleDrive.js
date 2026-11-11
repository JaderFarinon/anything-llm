import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...baseHeaders(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Falha na conexão com o Google Drive.");
  return data;
}

const GoogleDrive = {
  config: () => request("/admin/google-drive/config"),
  saveConfig: (config) =>
    request("/admin/google-drive/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  connections: () => request("/google-drive/connections"),
  connect: ({ scope, companyId = null }) =>
    request("/google-drive/oauth/start", {
      method: "POST",
      body: JSON.stringify({ scope, companyId }),
    }),
  folders: (connectionId, { query = "", pageToken = null } = {}) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (pageToken) params.set("pageToken", pageToken);
    return request(
      `/google-drive/connections/${connectionId}/folders?${params.toString()}`
    );
  },
  addFolder: (connectionId, folder) =>
    request(`/google-drive/connections/${connectionId}/folders`, {
      method: "POST",
      body: JSON.stringify(folder),
    }),
  removeFolder: (folderId) =>
    request(`/google-drive/folders/${folderId}`, { method: "DELETE" }),
  pendingFolders: () => request("/admin/google-drive/folders/pending"),
  adminFolders: () => request("/admin/google-drive/folders"),
  folderFiles: (folderId) => request(`/admin/google-drive/folders/${folderId}/files`),
  setFileBlocked: (fileId, blocked) =>
    request(`/admin/google-drive/files/${fileId}/block`, {
      method: "POST",
      body: JSON.stringify({ blocked }),
    }),
  moderateFolder: (folderId, status) =>
    request(`/admin/google-drive/folders/${folderId}/moderate`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
};

export default GoogleDrive;
