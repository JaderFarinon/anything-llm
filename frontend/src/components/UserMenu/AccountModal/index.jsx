import { useLanguageOptions } from "@/hooks/useLanguageOptions";
import usePfp from "@/hooks/usePfp";
import System from "@/models/system";
import Appearance from "@/models/appearance";
import { AUTH_USER } from "@/utils/constants";
import showToast from "@/utils/toast";
import { Info, Plus } from "@phosphor-icons/react";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalInput,
  ModalTextarea,
  ModalLabel,
  ModalPrimaryButton,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import paths from "@/utils/paths";
import { Tooltip } from "react-tooltip";
import { safeJsonParse } from "@/utils/request";
import Toggle from "@/components/lib/Toggle";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";

export default function AccountModal({ user, hideModal }) {
  const { pfp, setPfp } = usePfp();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [telegramLink, setTelegramLink] = useState(null);
  const [telegramLinked, setTelegramLinked] = useState(!!user?.telegramChatId);

  useEffect(() => {
    if (!user?.role) return;
    System.telegramLinkStatus().then(({ linked }) => setTelegramLinked(!!linked));
  }, [user?.role]);

  useEffect(() => {
    if (!telegramLink) return;
    let active = true;
    const interval = setInterval(async () => {
      if (Date.now() >= telegramLink.expiresAt) {
        setTelegramLink(null);
        showToast("O código expirou. Gere um novo para vincular o Telegram.", "error");
        return;
      }
      const { linked } = await System.telegramLinkStatus();
      if (!active || !linked) return;
      setTelegramLinked(true);
      setTelegramLink(null);
      showToast("Telegram vinculado à sua conta.", "success");
    }, 2500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [telegramLink]);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return false;

    const formData = new FormData();
    formData.append("file", file);
    const { success, error } = await System.uploadPfp(formData);
    if (!success) {
      showToast(t("profile_settings.failed_upload", { error }), "error");
      return;
    }

    const pfpUrl = await System.fetchPfp(user.id);
    setPfp(pfpUrl);
    showToast(t("profile_settings.upload_success"), "success");
  };

  const handleRemovePfp = async () => {
    const { success, error } = await System.removePfp();
    if (!success) {
      showToast(t("profile_settings.failed_remove", { error }), "error");
      return;
    }

    setPfp(null);
  };

  const handleUpdate = async (e) => {
    e.preventDefault();

    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) {
      if (!value && key !== "bio") continue;
      data[key] = value;
    }

    const { success, error } = await System.updateUser(data);
    if (success) {
      let storedUser = safeJsonParse(localStorage.getItem(AUTH_USER), null);
      if (storedUser) {
        storedUser.username = data.username;
        storedUser.bio = data.bio;
        localStorage.setItem(AUTH_USER, JSON.stringify(storedUser));
      }
      showToast(t("profile_settings.profile_updated"), "success", {
        clear: true,
      });
      hideModal();
    } else {
      showToast(t("profile_settings.failed_update_user", { error }), "error");
    }
  };
  return (
    <Modal isOpen={true} onClose={hideModal} size="lg">
      <form onSubmit={handleUpdate} className="flex flex-col gap-y-5">
        <ModalHeader
          title={t("profile_settings.edit_account")}
          onClose={hideModal}
        />
        <ModalBody>
          <div className="flex flex-col md:flex-row items-center justify-center gap-8">
            <div className="flex flex-col items-center">
              <label className="group w-48 h-48 flex flex-col items-center justify-center bg-zinc-800 hover:bg-zinc-700 light:bg-sky-100 light:hover:bg-transparent transition-colors duration-300 rounded-full border-2 border-dashed border-white light:border-slate-400 cursor-pointer hover:opacity-60">
                <input
                  id="logo-upload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                {pfp ? (
                  <img
                    src={pfp}
                    alt="User profile picture"
                    className="w-48 h-48 rounded-full object-cover bg-white"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-3">
                    <Plus className="w-8 h-8 text-zinc-400 light:text-slate-500 m-2" />
                    <span className="text-zinc-400 light:text-slate-500 text-sm font-semibold">
                      {t("profile_settings.profile_picture")}
                    </span>
                    <span className="text-zinc-400 light:text-slate-500 text-xs">
                      800 x 800
                    </span>
                  </div>
                )}
              </label>
              {pfp && (
                <button
                  type="button"
                  onClick={handleRemovePfp}
                  className="border-none bg-transparent mt-3 text-zinc-400 light:text-slate-500 text-sm font-medium hover:underline"
                >
                  {t("profile_settings.remove_profile_picture")}
                </button>
              )}
            </div>
          </div>
          <ModalInput
            label={t("profile_settings.username")}
            name="username"
            type="text"
            placeholder="User's username"
            minLength={USERNAME_MIN_LENGTH}
            maxLength={USERNAME_MAX_LENGTH}
            pattern={USERNAME_PATTERN}
            defaultValue={user.username}
            required
            autoComplete="off"
            hint={t("common.username_requirements")}
          />
          <ModalInput
            label={t("profile_settings.new_password")}
            name="password"
            type="password"
            placeholder={`${user.username}'s new password`}
            minLength={8}
            hint={t("profile_settings.password_description")}
          />
          <ModalTextarea
            label="Bio"
            name="bio"
            placeholder="Tell us about yourself..."
            defaultValue={user.bio}
            rows={4}
          />
          {user?.role && (
            <section className="flex flex-col gap-2 rounded-lg border border-white/10 light:border-slate-300 p-4">
              <div className="font-semibold text-zinc-100 light:text-slate-900">
                Telegram
              </div>
              <p className="text-sm text-zinc-400 light:text-slate-600">
                {telegramLinked
                  ? "Conta vinculada. O bot usa as permissões e o histórico desta conta."
                  : "Vincule sua conta do Telegram para conversar com a IA pelo bot."}
              </p>
              {telegramLink && (
                <div className="flex flex-col gap-2 rounded bg-zinc-800/70 p-3 light:bg-slate-100">
                  <span className="text-xs text-zinc-400 light:text-slate-600">
                    Copie este código e envie como mensagem privada ao bot. Ele
                    expira em 10 minutos e só pode ser usado uma vez.
                  </span>
                  <code className="select-all break-all rounded bg-black/20 p-2 text-sm text-sky-300 light:bg-white light:text-sky-700">
                    {telegramLink.token}
                  </code>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="px-3 py-2 rounded bg-zinc-700 text-white text-sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(telegramLink.token);
                          showToast("Código copiado.", "success");
                        } catch {
                          showToast("Selecione e copie o código acima.", "error");
                        }
                      }}
                    >
                      Copiar código
                    </button>
                    <a
                      className="inline-flex items-center rounded bg-sky-600 px-3 py-2 text-sm text-white"
                      href={telegramLink.botUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Abrir bot no Telegram
                    </a>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                {!telegramLinked && (
                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-sky-600 text-white text-sm"
                    onClick={async () => {
                      const result = await System.createTelegramLink();
                      if (result.token && result.botUrl)
                        setTelegramLink({
                          token: result.token,
                          botUrl: result.botUrl,
                          expiresAt:
                            Date.now() + (result.expiresInSeconds || 600) * 1000,
                        });
                      else
                        showToast(
                          result.error || "Não foi possível gerar o link.",
                          "error"
                        );
                    }}
                  >
                    Gerar link de vínculo
                  </button>
                )}
                {telegramLinked && (
                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-zinc-700 text-white text-sm"
                    onClick={async () => {
                      const result = await System.unlinkTelegram();
                      if (result.success) {
                        setTelegramLinked(false);
                        setTelegramLink(null);
                        showToast("Telegram desvinculado.", "success");
                      } else
                        showToast(
                          result.error || "Não foi possível desvincular.",
                          "error"
                        );
                    }}
                  >
                    Desvincular Telegram
                  </button>
                )}
              </div>
            </section>
          )}
          <section className="rounded-lg border border-white/10 p-4">
            <h3 className="text-sm font-semibold text-zinc-100 light:text-slate-800">
              Google Drive
            </h3>
            <p className="mt-1 text-xs text-zinc-400 light:text-slate-600">
              Conecte seu Drive pessoal e envie pastas para aprovação do admin.
            </p>
            <button
              type="button"
              onClick={() => {
                hideModal();
                navigate(paths.settings.googleDrive());
              }}
              className="mt-3 px-3 py-2 rounded bg-zinc-700 text-white text-sm"
            >
              Gerenciar Google Drive
            </button>
          </section>
          <div className="flex gap-x-16">
            <div className="flex flex-col gap-y-6">
              <ThemePreference />
              <LanguagePreference />
            </div>
            <div className="flex flex-col gap-y-6">
              <AutoSubmitPreference />
              <AutoSpeakPreference />
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <ModalSecondaryButton type="button" onClick={hideModal}>
            {t("profile_settings.cancel")}
          </ModalSecondaryButton>
          <ModalPrimaryButton type="submit">
            {t("profile_settings.update_account")}
          </ModalPrimaryButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function LanguagePreference() {
  const {
    currentLanguage,
    supportedLanguages,
    getLanguageName,
    changeLanguage,
  } = useLanguageOptions();
  const { t } = useTranslation();
  return (
    <div>
      <ModalLabel htmlFor="userLang" className="block mb-2">
        {t("profile_settings.language")}
      </ModalLabel>
      <select
        name="userLang"
        className="bg-zinc-800 border border-zinc-800 light:bg-white light:border-slate-300 w-fit mt-2 px-4 outline-none focus:border-sky-500 light:focus:border-sky-500 text-zinc-100 light:text-slate-900 text-sm rounded-lg block py-2"
        defaultValue={currentLanguage || "en"}
        onChange={(e) => changeLanguage(e.target.value)}
      >
        {supportedLanguages.map((lang) => {
          return (
            <option key={lang} value={lang}>
              {getLanguageName(lang)}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function ThemePreference() {
  const { theme, setTheme, availableThemes } = useTheme();
  const { t } = useTranslation();
  return (
    <div>
      <ModalLabel htmlFor="theme" className="block mb-2">
        {t("profile_settings.theme")}
      </ModalLabel>
      <select
        name="theme"
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        className="bg-zinc-800 border border-zinc-800 light:bg-white light:border-slate-300 w-fit px-4 outline-none focus:border-sky-500 light:focus:border-sky-500 text-zinc-100 light:text-slate-900 text-sm rounded-lg block py-2"
      >
        {Object.entries(availableThemes).map(([key, value]) => (
          <option key={key} value={key}>
            {value}
          </option>
        ))}
      </select>
    </div>
  );
}

function AutoSubmitPreference() {
  const [autoSubmitSttInput, setAutoSubmitSttInput] = useState(true);
  const { t } = useTranslation();

  useEffect(() => {
    const settings = Appearance.getSettings();
    setAutoSubmitSttInput(settings.autoSubmitSttInput ?? true);
  }, []);

  const handleChange = (checked) => {
    setAutoSubmitSttInput(checked);
    Appearance.updateSettings({ autoSubmitSttInput: checked });
  };

  return (
    <div>
      <div className="flex items-center gap-x-1 mb-2">
        <label
          htmlFor="autoSubmit"
          className="block text-sm font-medium text-white"
        >
          {t("customization.chat.auto_submit.title")}
        </label>
        <div
          data-tooltip-id="auto-submit-info"
          data-tooltip-content={t("customization.chat.auto_submit.description")}
          className="cursor-pointer h-fit"
        >
          <Info size={16} weight="bold" className="text-white" />
        </div>
      </div>
      <Toggle size="lg" enabled={autoSubmitSttInput} onChange={handleChange} />
      <Tooltip
        id="auto-submit-info"
        place="bottom"
        delayShow={300}
        className="allm-tooltip !allm-text-xs"
      />
    </div>
  );
}

function AutoSpeakPreference() {
  const [autoPlayAssistantTtsResponse, setAutoPlayAssistantTtsResponse] =
    useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    const settings = Appearance.getSettings();
    setAutoPlayAssistantTtsResponse(
      settings.autoPlayAssistantTtsResponse ?? false
    );
  }, []);

  const handleChange = (checked) => {
    setAutoPlayAssistantTtsResponse(checked);
    Appearance.updateSettings({ autoPlayAssistantTtsResponse: checked });
  };

  return (
    <div>
      <div className="flex items-center gap-x-1 mb-2">
        <label
          htmlFor="autoSpeak"
          className="block text-sm font-medium text-white"
        >
          {t("customization.chat.auto_speak.title")}
        </label>
        <div
          data-tooltip-id="auto-speak-info"
          data-tooltip-content={t("customization.chat.auto_speak.description")}
          className="cursor-pointer h-fit"
        >
          <Info size={16} weight="bold" className="text-white" />
        </div>
      </div>
      <Toggle
        size="lg"
        enabled={autoPlayAssistantTtsResponse}
        onChange={handleChange}
      />
      <Tooltip
        id="auto-speak-info"
        place="bottom"
        delayShow={300}
        className="allm-tooltip !allm-text-xs"
      />
    </div>
  );
}
