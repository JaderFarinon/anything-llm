import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, CircleNotch, Clock, ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import Sidebar from "@/components/SettingsSidebar";
import System from "@/models/system";
import showToast from "@/utils/toast";
import { isMobile } from "react-device-detect";

const today = () => new Date().toISOString().slice(0, 10);

export default function AgentQuality() {
  const [date, setDate] = useState(today());
  const [interactions, setInteractions] = useState([]);
  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const refresh = useCallback(async (nextOffset = 0) => {
    setLoading(true);
    const [result, reportResult] = await Promise.all([
      System.agentQualityInteractions(date, nextOffset),
      System.agentQualityReports(),
    ]);
    setInteractions(result?.interactions || []);
    setTotal(result?.total || 0);
    setReports(reportResult?.reports || []);
    setOffset(nextOffset);
    setLoading(false);
  }, [date]);

  useEffect(() => { refresh(0); }, [refresh]);

  async function generateReport() {
    setGenerating(true);
    const result = await System.generateAgentQualityReport(date);
    if (!result?.success) {
      showToast(result?.error || "Não foi possível gerar o relatório.", "error");
    } else {
      showToast("Relatório diário atualizado.", "success");
      await refresh(0);
    }
    setGenerating(false);
  }

  const selectedReport = reports.find((report) => report.date === date);
  const nextOffset = offset + 1;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <main
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16 gap-y-6">
          <header className="w-full flex flex-col gap-y-2 pb-6 border-white/10 border-b-2">
            <h1 className="text-lg leading-6 font-bold text-theme-text-primary">Qualidade das respostas</h1>
            <p className="text-xs leading-[18px] text-theme-text-secondary">
              A rotina diária consolida avaliações, tempo informado pelo modelo e sinais de respostas sem fontes. As conversas ficam disponíveis aqui para revisão administrativa; nada é alterado ou aprendido automaticamente.
            </p>
          </header>

          <section className="rounded-xl border border-white/10 p-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-theme-text-secondary">
              Dia das conversas
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="rounded-lg bg-theme-bg-primary border border-white/10 px-3 py-2 text-sm text-theme-text-primary"
              />
            </label>
            <button
              onClick={generateReport}
              disabled={generating}
              className="rounded-lg bg-primary-button px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {generating ? <CircleNotch className="inline mr-2 animate-spin" /> : <ArrowClockwise className="inline mr-2" />}
              Gerar/atualizar relatório
            </button>
            <button
              onClick={() => refresh(0)}
              disabled={loading}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm text-theme-text-primary disabled:opacity-50"
            >Atualizar conversas</button>
          </section>

          {selectedReport ? (
            <ReportSummary report={selectedReport} />
          ) : (
            <div className="rounded-xl border border-white/10 p-4 text-sm text-theme-text-secondary">
              O relatório automático é gerado diariamente após o fechamento do dia UTC. Você também pode gerar ou atualizar o resumo acima.
            </div>
          )}

          <section className="flex flex-col gap-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-theme-text-primary">Interações ({total})</h2>
              <p className="mt-1 text-xs text-theme-text-secondary">Perguntas, respostas, fontes, feedback e duração total do fluxo quando disponível.</p>
              </div>
            </div>
            {loading ? <Loading /> : interactions.length === 0 ? (
              <EmptyState>Nenhuma interação salva para este dia.</EmptyState>
            ) : interactions.map((item) => <InteractionCard key={item.id} item={item} />)}
            {!loading && total > (offset + 1) * 25 && (
              <button
                onClick={() => refresh(nextOffset)}
                className="self-center rounded-lg border border-white/15 px-4 py-2 text-sm text-theme-text-primary"
              >Carregar mais</button>
            )}
          </section>

          <section className="flex flex-col gap-y-3">
            <h2 className="font-semibold text-theme-text-primary">Relatórios recentes</h2>
            {reports.length === 0 ? <EmptyState>O primeiro relatório ainda não foi gerado.</EmptyState> : (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-theme-text-secondary bg-theme-bg-primary">
                    <tr><th className="p-3">Data</th><th className="p-3">Interações</th><th className="p-3">Positivas</th><th className="p-3">Negativas</th><th className="p-3">Sem fontes em buscas</th><th className="p-3">P95 do fluxo</th></tr>
                  </thead>
                  <tbody>{reports.map((report) => (
                    <tr key={report.date} className="border-t border-white/10 text-theme-text-primary">
                      <td className="p-3">{report.date}</td><td className="p-3">{report.totalInteractions}</td><td className="p-3">{report.ratedGood}</td><td className="p-3">{report.ratedBad}</td><td className="p-3">{report.likelyLookupWithoutSources}</td><td className="p-3">{formatDuration(report.p95EndToEndSeconds)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function ReportSummary({ report }) {
  const metrics = [
    ["Interações", report.totalInteractions],
    ["Avaliações positivas", report.ratedGood],
    ["Avaliações negativas", report.ratedBad],
    ["Sem avaliação", report.unrated],
    ["Sem fontes", report.withoutSources],
    ["Buscas sem fonte encontrada", report.likelyLookupWithoutSources],
    ["Duração média informada", formatDuration(report.averageDurationSeconds)],
    ["Duração média do fluxo", formatDuration(report.averageEndToEndSeconds)],
    ["P95 do fluxo", formatDuration(report.p95EndToEndSeconds)],
  ];
  const sourceLabels = {
    google_drive: "Google Drive",
    sql: "SQL",
    documentos: "Documentos vetoriais",
    outros: "Outras fontes",
  };
  return (
    <section className="rounded-xl border border-white/10 p-4">
      <h2 className="font-semibold text-theme-text-primary">Resumo diário · {report.date}</h2>
      <div className="mt-3 grid gap-3 grid-cols-2 md:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-theme-bg-primary p-3">
            <p className="text-xs text-theme-text-secondary">{label}</p>
            <p className="mt-1 text-lg font-semibold text-theme-text-primary">{value ?? "—"}</p>
          </div>
        ))}
      </div>
      {Object.keys(report.sourceCounts || {}).length > 0 && (
        <p className="mt-3 text-xs text-theme-text-secondary">
          Fontes citadas: {Object.entries(report.sourceCounts)
            .map(([key, count]) => `${sourceLabels[key] || key}: ${count}`)
            .join(" · ")}
        </p>
      )}
      <p className="mt-3 text-[11px] text-theme-text-secondary">
        Duração do fluxo mede busca, montagem do contexto e geração para novas conversas. Conversas antigas podem não ter essa métrica. “Buscas sem fonte” é um indicador heurístico para revisão, não uma classificação automática de erro.
      </p>
    </section>
  );
}

function InteractionCard({ item }) {
  const status = item.feedbackScore === true ? "positiva" : item.feedbackScore === false ? "negativa" : "sem avaliação";
  const StatusIcon = item.feedbackScore === true ? ThumbsUp : item.feedbackScore === false ? ThumbsDown : Clock;
  return (
    <article className="rounded-xl border border-white/10 p-4 flex flex-col gap-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-theme-text-secondary">
        <StatusIcon size={15} />
        <span>Avaliação {status}</span><span>· {item.workspace}</span><span>· {item.username}</span>
        <span>· {new Date(item.createdAt).toLocaleTimeString()}</span>
        {item.requestDuration !== null && <span>· Fluxo: {formatDuration(item.requestDuration)}</span>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <TextBlock title="Pergunta" text={item.prompt} />
        <TextBlock title="Resposta" text={item.response} />
      </div>
      {item.sources.length > 0 && (
        <div className="text-xs text-theme-text-secondary">
          <span className="font-semibold">Fontes:</span> {item.sources.map((source) => source.title).join(" · ")}
        </div>
      )}
    </article>
  );
}

function TextBlock({ title, text }) {
  return <div className="min-w-0"><p className="mb-1 text-xs font-semibold text-theme-text-secondary">{title}</p><p className="whitespace-pre-wrap break-words text-sm text-theme-text-primary">{text || "(vazio)"}</p></div>;
}

function formatDuration(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(1)} s`;
}

function Loading() { return <div className="py-8 text-center text-sm text-theme-text-secondary"><CircleNotch className="inline mr-2 animate-spin" />Carregando…</div>; }
function EmptyState({ children }) { return <div className="rounded-xl border border-white/10 p-6 text-center text-sm text-theme-text-secondary">{children}</div>; }
