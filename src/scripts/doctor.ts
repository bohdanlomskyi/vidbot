import { type CheckStatus, runDiagnostics } from '../app/diagnostics.js';
import { loadDotEnv } from '../app/env.js';

const LABELS: Record<CheckStatus, string> = { ok: 'ОК', fail: 'ОШИБКА', skip: 'ПРОПУСК' };

async function main(): Promise<void> {
  loadDotEnv(process.cwd());
  const results = await runDiagnostics(process.env, process.cwd());
  for (const result of results) {
    process.stdout.write(`[${LABELS[result.status]}] ${result.name}: ${result.detail}\n`);
  }
  const failures = results.filter((result) => result.status === 'fail').length;
  process.stdout.write(
    failures === 0 ? '\nВсе проверки пройдены.\n' : `\nПроверок с ошибками: ${String(failures)}.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Диагностика прервана: ${error instanceof Error ? error.message : 'неизвестная ошибка'}\n`,
  );
  process.exitCode = 1;
});
