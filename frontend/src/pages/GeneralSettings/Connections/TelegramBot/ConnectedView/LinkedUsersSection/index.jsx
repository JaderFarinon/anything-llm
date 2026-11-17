import Telegram from "@/models/telegram";
import showToast from "@/utils/toast";

export default function LinkedUsersSection({ users, onRefresh }) {
  if (!users.length) return null;
  async function unlink(user) {
    const result = await Telegram.unlinkUser(user.id);
    if (!result.success) return showToast(result.error || "Não foi possível desvincular.", "error");
    showToast("Telegram desvinculado de " + user.username + ".", "success");
    onRefresh();
  }
  return (
    <section className="flex flex-col gap-y-3 w-[700px]">
      <div>
        <p className="text-base font-semibold text-white light:text-slate-900">Contas vinculadas</p>
        <p className="text-xs text-zinc-400 light:text-slate-600">Somente usuários atribuídos a workspaces podem consultar esses conteúdos pelo bot.</p>
      </div>
      <div className="flex flex-col divide-y divide-zinc-700 light:divide-slate-200 border-y border-zinc-700 light:border-slate-200">
        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between py-3">
            <span className="text-sm text-white light:text-slate-900">{user.username}</span>
            <button type="button" onClick={() => unlink(user)} className="text-sm text-red-400 hover:text-red-300">Desvincular</button>
          </div>
        ))}
      </div>
    </section>
  );
}
