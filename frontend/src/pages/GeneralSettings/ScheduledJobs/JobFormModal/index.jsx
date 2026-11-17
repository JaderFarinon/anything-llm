import { useState, useEffect } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import ScheduledJobs from "@/models/scheduledJobs";
import showToast from "@/utils/toast";
import { safeJsonParse } from "@/utils/request";
import { useTranslation } from "react-i18next";
import { ModalHeader, ModalBody } from "@/components/lib/Modal";
import JobDescription from "./JobDescription";
import JobSchedule from "./JobSchedule";
import ToolsSelector from "./ToolsSelector";
import FormActions from "./FormActions";

function setDefaultFormState(job) {
  return {
    name: job?.name || "",
    prompt: job?.prompt || "",
    schedule: job?.schedule || "0 9 * * *",
    scheduleMode: "builder",
    selectedTools: job?.tools ? safeJsonParse(job.tools, []) : [],
    selectedTelegramRecipientIds: job?.telegramRecipientIds ? safeJsonParse(job.telegramRecipientIds, []) : [],
  };
}

export default function JobFormModal({ job = null, onClose, onSaved }) {
  const { t } = useTranslation();
  const isEditing = !!job;
  const [form, setForm] = useState(setDefaultFormState(job));
  const [availableTools, setAvailableTools] = useState([]);
  const [telegramUsers, setTelegramUsers] = useState([]);
  const [telegramUsersLoading, setTelegramUsersLoading] = useState(true);
  const [telegramUsersError, setTelegramUsersError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({
    name: false,
    prompt: false,
    schedule: false,
  });
  const hasErrors = () => Object.values(errors).some(Boolean);

  const clearError = (field) => {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: false } : prev));
  };

  useEffect(() => {
    ScheduledJobs.availableTools().then(({ tools }) => {
      setAvailableTools(tools || []);
    });
    ScheduledJobs.linkedTelegramUsers()
      .then(({ users, error }) => {
        setTelegramUsers(users || []);
        setTelegramUsersError(Boolean(error));
        setTelegramUsersLoading(false);
      })
      .catch(() => {
        setTelegramUsersError(true);
        setTelegramUsersLoading(false);
      });
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    clearError(name);
  };

  const handleScheduleChange = (cron) => {
    setForm((prev) => ({ ...prev, schedule: cron }));
    clearError("schedule");
  };

  const handleModeChange = (mode) => {
    setForm((prev) => ({ ...prev, scheduleMode: mode }));
  };

  const setSelectedTools = (selectedTools) => {
    setForm((prev) => ({ ...prev, selectedTools }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const nextErrors = {
      name: !form.name.trim(),
      prompt: !form.prompt.trim(),
      schedule: !form.schedule.trim(),
    };
    if (nextErrors.name || nextErrors.prompt || nextErrors.schedule) {
      setErrors(nextErrors);
      return;
    }

    setSaving(true);
    const data = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      schedule: form.schedule.trim(),
      tools: form.selectedTools,
      telegramRecipientIds: form.selectedTelegramRecipientIds,
    };

    const result = isEditing
      ? await ScheduledJobs.update(job.id, data)
      : await ScheduledJobs.create(data);

    setSaving(false);

    if (result.error) {
      showToast(result.error, "error");
      return;
    }

    showToast(
      isEditing
        ? t("scheduledJobs.modal.jobUpdated")
        : t("scheduledJobs.modal.jobCreated"),
      "success"
    );
    onSaved();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-y-5">
      <ModalHeader
        title={
          isEditing
            ? t("scheduledJobs.modal.titleEdit")
            : t("scheduledJobs.modal.titleNew")
        }
        onClose={onClose}
      >
        {hasErrors() && (
          <div className="flex gap-1 items-center mt-1">
            <WarningCircle size={16} className="text-red-400 shrink-0" />
            <p className="text-sm text-red-400">
              {t(
                "scheduledJobs.modal.requiredFieldsBanner",
                "Please fill out all required fields in order to create job."
              )}
            </p>
          </div>
        )}
      </ModalHeader>
      <ModalBody>
        <JobDescription form={form} errors={errors} onChange={handleChange} />

        <JobSchedule
          schedule={form.schedule}
          scheduleMode={form.scheduleMode}
          error={errors.schedule}
          onScheduleChange={handleScheduleChange}
          onModeChange={handleModeChange}
        />

        <section className="flex flex-col gap-2 rounded-lg border border-zinc-700 light:border-slate-300 p-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100 light:text-slate-900">
              {t("scheduledJobs.modal.deliveryTitle")}
            </h3>
            <p className="text-xs text-zinc-400 light:text-slate-600 mt-1">
              {t("scheduledJobs.modal.deliveryDescription")}
            </p>
          </div>
          <span className="text-sm font-medium text-zinc-200 light:text-slate-800">
            {t("scheduledJobs.modal.telegram")}
          </span>
          {telegramUsersLoading ? (
            <p className="text-sm text-zinc-400 light:text-slate-600">
              {t("scheduledJobs.modal.telegramLoading")}
            </p>
          ) : telegramUsersError ? (
            <p role="alert" className="text-sm text-red-400">
              {t("scheduledJobs.modal.telegramLoadError")}
            </p>
          ) : telegramUsers.length === 0 ? (
            <p className="text-sm text-zinc-400 light:text-slate-600">
              {t("scheduledJobs.modal.telegramNoRecipients")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {telegramUsers.map((recipient) => {
                const selected = form.selectedTelegramRecipientIds
                  .map(Number)
                  .includes(Number(recipient.id));
                return (
                  <label
                    key={recipient.id}
                    className="flex items-center gap-2 text-sm text-zinc-200 light:text-slate-800 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          selectedTelegramRecipientIds: event.target.checked
                            ? [
                                ...prev.selectedTelegramRecipientIds,
                                recipient.id,
                              ]
                            : prev.selectedTelegramRecipientIds.filter(
                                (id) => Number(id) !== Number(recipient.id)
                              ),
                        }))
                      }
                    />
                    {recipient.username}
                  </label>
                );
              })}
            </div>
          )}
        </section>

        {availableTools.length > 0 && (
          <ToolsSelector
            availableTools={availableTools}
            selectedTools={form.selectedTools}
            onChange={setSelectedTools}
          />
        )}

        <FormActions isEditing={isEditing} saving={saving} onClose={onClose} />
      </ModalBody>
    </form>
  );
}
