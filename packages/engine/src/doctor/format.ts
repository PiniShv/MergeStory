/** The report as text for a terminal. */
import type { CheckStatus, DoctorReport } from './types.ts';

export function formatDoctor(
  report: DoctorReport,
  style: {
    bold(t: string): string;
    dim(t: string): string;
    red(t: string): string;
    green(t: string): string;
    yellow(t: string): string;
  },
): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const mark = (status: CheckStatus): string =>
    status === 'pass' ? style.green('ok  ') : status === 'warn' ? style.yellow('warn') : style.red('FAIL');
  const lines = [style.bold(`MergeStory ${report.version}: environment check`), ''];
  for (const item of report.checks) {
    lines.push(`  ${mark(item.status)}  ${item.name.padEnd(width)}  ${item.detail}`);
    if (item.fix) lines.push(`        ${' '.repeat(width)}  ${style.dim('fix:')} ${item.fix}`);
  }
  const { pass, warn, fail } = report.summary;
  lines.push('', `${pass} passed, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failed.`);
  lines.push(
    fail > 0
      ? 'Fix the failed checks above before generating a video.'
      : warn > 0
        ? 'Everything needed is in place. The warnings are optional improvements.'
        : 'Everything needed is in place.',
  );
  return `${lines.join('\n')}\n`;
}
