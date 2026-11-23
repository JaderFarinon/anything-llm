const OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function createAuthorizationUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${OAUTH_URL}?${params.toString()}`;
}

async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
}) {
  return await postToken({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code,
  });
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return await postToken({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

async function postToken(body) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error)
    throw new Error(
      payload.error_description ||
        payload.error ||
        "Google OAuth token exchange failed."
    );
  return payload;
}

async function driveRequest(accessToken, pathname, params = {}) {
  const url = new URL(`${DRIVE_API}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.error?.message || `Google Drive API returned ${response.status}.`
    );
  return payload;
}

async function getAccount(accessToken) {
  const response = await driveRequest(accessToken, "/about", {
    fields: "user(emailAddress,displayName)",
  });
  return response.user || {};
}

async function listFolders(accessToken, { pageToken = null, query = "" } = {}) {
  const clauses = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ];
  if (query.trim())
    clauses.push(`name contains '${query.trim().replace(/'/g, "\\'")}'`);
  return await driveRequest(accessToken, "/files", {
    q: clauses.join(" and "),
    orderBy: "name",
    pageSize: "100",
    pageToken,
    fields:
      "nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
}

async function listChildren(accessToken, folderId, pageToken = null) {
  return await driveRequest(accessToken, "/files", {
    q: `'${String(folderId).replace(/'/g, "\\'")}' in parents and trashed = false`,
    orderBy: "name",
    pageSize: "1000",
    pageToken,
    fields:
      "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,parents,trashed,size)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
}

async function getStartPageToken(accessToken) {
  return await driveRequest(accessToken, "/changes/startPageToken", {
    supportsAllDrives: "true",
  });
}

async function listChanges(accessToken, pageToken) {
  return await driveRequest(accessToken, "/changes", {
    pageToken,
    pageSize: "1000",
    includeRemoved: "true",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    fields:
      "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,md5Checksum,parents,trashed,size))",
  });
}

async function watchChanges(
  accessToken,
  { pageToken, address, id, token, expiration }
) {
  const url = new URL(`${DRIVE_API}/changes/watch`);
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, type: "web_hook", address, token, expiration }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.error?.message || `Drive watch returned ${response.status}.`
    );
  return payload;
}

async function stopChannel(accessToken, { id, resourceId }) {
  const response = await fetch(`${DRIVE_API}/channels/stop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, resourceId }),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(
      `Could not stop Google Drive notification channel (${response.status}).`
    );
}

async function getFile(accessToken, fileId) {
  return await driveRequest(
    accessToken,
    `/files/${encodeURIComponent(fileId)}`,
    {
      fields: "id,name,mimeType,modifiedTime,md5Checksum,parents,trashed,size",
      supportsAllDrives: "true",
    }
  );
}

async function downloadFile(accessToken, file) {
  const nativeExports = {
    "application/vnd.google-apps.document": ["application/pdf", ".pdf"],
    "application/vnd.google-apps.spreadsheet": ["text/csv", ".csv"],
    "application/vnd.google-apps.presentation": ["application/pdf", ".pdf"],
  };
  const exportConfig = nativeExports[file.mimeType];
  const url = exportConfig
    ? `${DRIVE_API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportConfig[0])}`
    : `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.error?.message || `Drive download returned ${response.status}.`
    );
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    extension: exportConfig?.[1] || "",
    contentType:
      response.headers.get("content-type") || "application/octet-stream",
  };
}

module.exports = {
  DRIVE_SCOPE,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  getAccount,
  listFolders,
  listChildren,
  getStartPageToken,
  listChanges,
  watchChanges,
  stopChannel,
  getFile,
  downloadFile,
};
