const prisma = require("./prisma");
const { safeJsonParse } = require("./http");
const { EventLogs } = require("../models/eventLogs");

const REPORT_EVENT = "agent_daily_quality_report";
const DATA_LOOKUP_TERMS =
  /clinic|sql|banco|faturamento|conv[eê]nio|contrato|agenda|m[eé]dico|documento|drive|arquivo|pasta/i;

function utcDayRange(dateValue) {
  const date = dateValue ? new Date(`${dateValue}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("Invalid report date.");
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, date: start.toISOString().slice(0, 10) };
}

function metricsFromResponse(response) {
  const parsed =
    typeof response === "string" ? safeJsonParse(response, {}) : response;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function summarizeChats(chats, reportDate) {
  const durations = [];
  const requestDurations = [];
  const sourceCounts = {};
  let ratedGood = 0;
  let ratedBad = 0;
  let emptyResponses = 0;
  let withSources = 0;
  let likelyLookupWithoutSources = 0;

  for (const chat of chats) {
    if (chat.feedbackScore === true) ratedGood++;
    if (chat.feedbackScore === false) ratedBad++;
    const data = metricsFromResponse(chat.response);
    const answer = String(data.text || "").trim();
    if (!answer) emptyResponses++;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.length) withSources++;
    if (sources.length === 0 && DATA_LOOKUP_TERMS.test(chat.prompt || ""))
      likelyLookupWithoutSources++;

    const duration = Number(data.metrics?.duration);
    if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
    const requestDuration = Number(data.metrics?.requestDurationMs);
    if (Number.isFinite(requestDuration) && requestDuration >= 0)
      requestDurations.push(requestDuration / 1000);
    for (const source of sources) {
      const kind = String(
        source?.sourceType || source?.type || source?.provider || "outro"
      ).toLowerCase();
      const group = /drive|google/.test(kind)
        ? "google_drive"
        : /sql|database|banco/.test(kind)
          ? "sql"
          : /document|vector|workspace/.test(kind)
            ? "documentos"
            : "outros";
      sourceCounts[group] = (sourceCounts[group] || 0) + 1;
    }
  }

  durations.sort((a, b) => a - b);
  requestDurations.sort((a, b) => a - b);
  const average = durations.length
    ? durations.reduce((total, item) => total + item, 0) / durations.length
    : null;
  const p95 = durations.length
    ? durations[
        Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)
      ]
    : null;

  return {
    date: reportDate,
    totalInteractions: chats.length,
    ratedGood,
    ratedBad,
    unrated: chats.length - ratedGood - ratedBad,
    emptyResponses,
    withSources,
    withoutSources: chats.length - withSources,
    likelyLookupWithoutSources,
    measuredResponses: durations.length,
    averageDurationSeconds: average,
    p95DurationSeconds: p95,
    measuredEndToEndResponses: requestDurations.length,
    averageEndToEndSeconds: requestDurations.length
      ? requestDurations.reduce((total, item) => total + item, 0) /
        requestDurations.length
      : null,
    p95EndToEndSeconds: requestDurations.length
      ? requestDurations[
          Math.min(
            requestDurations.length - 1,
            Math.ceil(requestDurations.length * 0.95) - 1
          )
        ]
      : null,
    sourceCounts,
    generatedAt: new Date().toISOString(),
  };
}

async function buildDailyQualityReport(dateValue, { persist = true } = {}) {
  const { start, end, date } = utcDayRange(dateValue);
  const chats = await prisma.workspace_chats.findMany({
    where: { include: true, createdAt: { gte: start, lt: end } },
    select: { prompt: true, response: true, feedbackScore: true },
  });
  const report = summarizeChats(chats, date);

  if (persist) {
    const prior = await EventLogs.where({ event: REPORT_EVENT }, 500, {
      id: "desc",
    });
    const existing = prior.find(
      (event) => safeJsonParse(event.metadata, {})?.date === date
    );
    if (existing) {
      await prisma.event_logs.update({
        where: { id: existing.id },
        data: { metadata: JSON.stringify(report), occurredAt: new Date() },
      });
    } else {
      await EventLogs.logEvent(REPORT_EVENT, report);
    }
  }
  return report;
}

module.exports = { REPORT_EVENT, utcDayRange, buildDailyQualityReport };
