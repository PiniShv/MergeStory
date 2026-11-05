/** Severity levels shared by the watch page and the pull request comment. */

/** Most severe first. */
export const SEVERITIES = ['high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/** Unknown values count as "info". */
export function severityOf(value: unknown): Severity {
  return SEVERITIES.find((s) => s === value) ?? 'info';
}

/** Rank for sorting, most severe first. */
export function severityRank(value: unknown): number {
  return SEVERITIES.indexOf(severityOf(value));
}
