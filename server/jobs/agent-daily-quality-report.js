const { buildDailyQualityReport } = require("../utils/agentQuality");
const { log, conclude } = require("./helpers/index.js");

(async () => {
  try {
    // The daily review is generated after the UTC day closes so the report is
    // stable. The worker runs hourly and upserts the same date if retried.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const report = await buildDailyQualityReport(yesterday);
    log(
      `Relatório diário de qualidade atualizado para ${report.date}: ${report.totalInteractions} interações.`
    );
  } catch (error) {
    log(`Falha ao gerar relatório diário de qualidade: ${error.message}`);
    process.exitCode = 1;
  } finally {
    conclude();
  }
})();
