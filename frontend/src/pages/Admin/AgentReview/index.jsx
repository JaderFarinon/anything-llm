import { useCallback, useEffect, useState } from "react";
import { Check, CircleNotch, ThumbsDown, X } from "@phosphor-icons/react";
import Sidebar from "@/components/SettingsSidebar";
import System from "@/models/system";
import showToast from "@/utils/toast";
import { isMobile } from "react-device-detect";

export default function AgentReview() {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [workingId, setWorkingId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [nextCandidates, nextSuggestions] = await Promise.all([
      System.agentReviewCandidates(),
      System.agentReviewSuggestions(),
    ]);
    setCandidates(nextCandidates);
    setSuggestions(nextSuggestions);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function generateSuggestion(chatId) {
    setWorkingId(`generate-${chatId}`);
    const result = await System.generateAgentSuggestion(chatId);
    if (!result?.success) {
      showToast(result?.error || "Não foi possível gerar a sugestão.", "error");
      setWorkingId(null);
      return;
    }
    showToast("Sugestão criada e aguardando sua revisão.", "success");
    await refresh();
    setWorkingId(null);
  }

  async function decideSuggestion(eventId, decision) {
    setWorkingId(`decision-${eventId}`);
    const result = await System.decideAgentSuggestion(eventId, decision);
    if (!result?.success) {
      showToast(result?.error || "Não foi possível salvar a decisão.", "error");
      setWorkingId(null);
      return;
    }
    showToast(
      decision === "approve"
        ? "Sugestão aprovada e aplicada ao catálogo de consultas."
        : "Sugestão rejeitada.",
      "success"
    );
    await refresh();
    setWorkingId(null);
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <main
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16 gap-y-6">
          <header className="w-full flex flex-col gap-y-2 pb-6 border-white/10 border-b-2">
            <h1 className="text-lg leading-6 font-bold text-theme-text-primary">
              Revisão do agente
            </h1>
            <p className="text-xs leading-[18px] text-theme-text-secondary">
              Revise respostas marcadas como incorretas. O agente pode sugerir
              exemplos de perguntas e uma descrição melhor para uma consulta SQL.
              Nada é aplicado sem sua aprovação.
            </p>
            <p className="text-xs leading-[18px] text-theme-text-secondary">
              Ao gerar uma sugestão, a pergunta e a resposta selecionadas são
              enviadas ao modelo configurado para o workspace. O conteúdo das
              linhas SQL, parâmetros e credenciais não é incluído. A aprovação
              altera apenas a descrição e as frases de exemplo; o SQL permanece
              intacto.
            </p>
          </header>

          <section className="flex flex-col gap-y-3">
            <div>
              <h2 className="font-semibold text-theme-text-primary">
                Sugestões aguardando aprovação ({suggestions.length})
              </h2>
              <p className="mt-1 text-xs text-theme-text-secondary">
                Confira a pergunta original e as mudanças propostas antes de
                aprovar ou rejeitar.
              </p>
            </div>
            {loading ? (
              <Loading />
            ) : suggestions.length === 0 ? (
              <EmptyState>Não há sugestões pendentes.</EmptyState>
            ) : (
              suggestions.map((item) => (
                <SuggestionCard
                  key={item.suggestionId}
                  item={item}
                  working={workingId === `decision-${item.id}`}
                  onApprove={() => decideSuggestion(item.id, "approve")}
                  onReject={() => decideSuggestion(item.id, "reject")}
                />
              ))
            )}
          </section>

          <section className="flex flex-col gap-y-3">
            <div>
              <h2 className="font-semibold text-theme-text-primary">
                Respostas sinalizadas ({candidates.length})
              </h2>
              <p className="mt-1 text-xs text-theme-text-secondary">
                Estas respostas receberam avaliação negativa. Gere uma sugestão
                para encaminhá-la à fila de aprovação.
              </p>
            </div>
            {loading ? (
              <Loading />
            ) : candidates.length === 0 ? (
              <EmptyState>
                Nenhuma resposta foi marcada como incorreta. Use o ícone de
                avaliação negativa abaixo de uma resposta no chat.
              </EmptyState>
            ) : (
              candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  working={workingId === `generate-${candidate.id}`}
                  onGenerate={() => generateSuggestion(candidate.id)}
                />
              ))
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function SuggestionCard({ item, working, onApprove, onReject }) {
  const suggestion = item.suggestion || {};
  return (
    <article className="rounded-xl border border-white/10 p-4 flex flex-col gap-y-4">
      <QuestionAndAnswer item={item} />
      <div className="rounded-lg bg-theme-bg-primary p-4 flex flex-col gap-y-2 text-sm">
        <p className="font-semibold text-theme-text-primary">
          {suggestion.queryTitle || "Consulta SQL"} · {suggestion.databaseId}
        </p>
        {suggestion.rationale && (
          <p className="text-theme-text-secondary">{suggestion.rationale}</p>
        )}
        {suggestion.suggestedDescription && (
          <div className="grid gap-2 md:grid-cols-2">
            <SuggestionText label="Descrição atual" text={suggestion.previousDescription} />
            <SuggestionText label="Descrição sugerida" text={suggestion.suggestedDescription} />
          </div>
        )}
        {suggestion.exampleQuestions?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-theme-text-primary mb-1">
              Frases que serão adicionadas
            </p>
            <ul className="list-disc pl-5 text-xs text-theme-text-secondary">
              {suggestion.exampleQuestions.map((example) => (
                <li key={example}>{example}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onReject}
          disabled={working}
          className="rounded-lg border border-white/20 px-4 py-2 text-sm text-theme-text-secondary disabled:opacity-50"
        >
          <X className="inline mr-1" /> Rejeitar
        </button>
        <button
          onClick={onApprove}
          disabled={working}
          className="rounded-lg bg-primary-button px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {working ? <CircleNotch className="inline mr-1 animate-spin" /> : <Check className="inline mr-1" />}
          Aprovar e aplicar
        </button>
      </div>
    </article>
  );
}

function CandidateCard({ candidate, working, onGenerate }) {
  return (
    <article className="rounded-xl border border-white/10 p-4 flex flex-col gap-y-3">
      <div className="flex items-center gap-x-2 text-xs text-theme-text-secondary">
        <ThumbsDown size={16} />
        <span>{candidate.workspace}</span>
        {candidate.username && <span>· {candidate.username}</span>}
      </div>
      <QuestionAndAnswer item={candidate} />
      <button
        onClick={onGenerate}
        disabled={working}
        className="self-end rounded-lg border border-sky-500 px-4 py-2 text-sm text-sky-300 disabled:opacity-50"
      >
        {working && <CircleNotch className="inline mr-2 animate-spin" />}
        Gerar sugestão para revisão
      </button>
    </article>
  );
}

function QuestionAndAnswer({ item }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-theme-text-secondary mb-1">
          Pergunta
        </p>
        <p className="text-sm text-theme-text-primary whitespace-pre-wrap break-words">
          {item.prompt}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-theme-text-secondary mb-1">
          Resposta
        </p>
        <p className="text-sm text-theme-text-primary whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {item.response}
        </p>
      </div>
    </div>
  );
}

function SuggestionText({ label, text }) {
  return (
    <div className="rounded border border-white/10 p-3">
      <p className="text-xs text-theme-text-secondary mb-1">{label}</p>
      <p className="text-xs text-theme-text-primary whitespace-pre-wrap">
        {text || "(sem alteração)"}
      </p>
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="rounded-xl border border-white/10 p-5 text-sm text-theme-text-secondary">
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-8">
      <CircleNotch size={24} className="animate-spin text-theme-text-secondary" />
    </div>
  );
}
