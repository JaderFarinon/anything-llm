import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Cloud, FolderOpen } from "@phosphor-icons/react";
import GoogleDrive from "@/models/googleDrive";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";

export default function GoogleDriveIntegrationPanel() {
  const [config, setConfig] = useState({
    clientId: "",
    clientSecret: "",
    baseUrl: window.location.origin,
    configured: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const callbackUrl = `${String(config.baseUrl || "").replace(/\/$/, "")}/api/google-drive/oauth/callback`;

  useEffect(() => {
    GoogleDrive.config()
      .then((result) => {
        const saved = result?.config || {};
        setConfig((current) => ({
          ...current,
          clientId: saved.clientId || "",
          baseUrl: saved.baseUrl || window.location.origin,
          configured: Boolean(saved.configured),
        }));
      })
      .catch((error) => showToast(error.message, "error"))
      .finally(() => setLoading(false));
  }, []);

  async function saveConfig() {
    setSaving(true);
    try {
      const result = await GoogleDrive.saveConfig(config);
      const saved = result?.config || {};
      setConfig((current) => ({
        ...current,
        clientSecret: "",
        callbackUrl: saved.callbackUrl || "",
        configured: Boolean(saved.configured),
      }));
      showToast("Configuração do Google Drive salva.", "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-y-5">
      <div className="flex items-center gap-x-3">
        <Cloud size={28} className="text-sky-400" />
        <div>
          <h2 className="text-lg font-semibold text-theme-text-primary">
            Configuração do Google Drive
          </h2>
          <p className="text-sm text-theme-text-secondary">
            Integração empresarial e indexação de documentos
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-theme-text-secondary">Carregando configuração…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Client ID"
            value={config.clientId}
            onChange={(clientId) => setConfig({ ...config, clientId })}
            placeholder="...apps.googleusercontent.com"
          />
          <TextField
            label="Client Secret"
            value={config.clientSecret}
            onChange={(clientSecret) => setConfig({ ...config, clientSecret })}
            placeholder={config.configured ? "Salvo — deixe vazio para manter" : "Client Secret"}
            type="password"
          />
          <TextField
            label="URL pública da aplicação"
            value={config.baseUrl}
            onChange={(baseUrl) => setConfig({ ...config, baseUrl })}
            placeholder="https://anyhealth.qyvia.com.br"
          />
          <div>
            <label className="mb-1 block text-xs text-theme-text-secondary">
              URI de redirecionamento autorizada
            </label>
            <input
              readOnly
              value={callbackUrl}
              className="h-[36px] w-full rounded-lg border border-white/10 bg-theme-bg-secondary px-3 text-xs text-theme-text-primary"
            />
          </div>
        </div>
      )}

      <p className="text-xs text-theme-text-secondary">
        Habilite a Google Drive API e cadastre essa URI no OAuth Client do tipo
        Web. A conexão usa acesso somente para leitura; o Client Secret é
        criptografado ao salvar.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={saveConfig}
          disabled={loading || saving}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Salvando…" : "Salvar configuração"}
        </button>
        <Link
          to={paths.settings.googleDrive()}
          className="flex items-center gap-x-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-theme-text-primary transition-colors hover:bg-theme-bg-primary"
        >
          <FolderOpen size={18} />
          Gerenciar pastas e moderação
        </Link>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-theme-text-secondary">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
        placeholder={placeholder}
        className="h-[36px] w-full rounded-lg border border-white/10 bg-theme-bg-primary px-3 text-sm text-theme-text-primary"
      />
    </div>
  );
}
