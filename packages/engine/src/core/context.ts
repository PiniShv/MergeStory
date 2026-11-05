/** The run context handed to every stage and provider. */
import { type Cache, FileCache, noCache } from './cache.ts';
import { type Config, loadSecrets, type Secrets } from './config.ts';
import { CostTracker, EgressTracker, type Price, PriceBook } from './cost.ts';
import { createLogger, type Logger } from './logger.ts';
import { type HomeLayout, homeLayout } from './paths.ts';
import { globalRedactor, type Redactor } from './redact.ts';
import type { ProgressEvent } from './types.ts';

export interface RunContext {
  config: Config;
  secrets: Secrets;
  logger: Logger;
  redactor: Redactor;
  cache: Cache;
  cost: CostTracker;
  egress: EgressTracker;
  home: HomeLayout;
  /** Directory for this run's files. Always outside the repository being explained. */
  runDir: string;
  runId: string;
  signal: AbortSignal;
  /** true = no paid calls, no uploads, no GitHub writes. */
  dryRun: boolean;
  progress(event: ProgressEvent): void;
  /** True the first time it sees a key in this run, so a notice is logged once per run. */
  firstTime(key: string): boolean;
}

export interface CreateContextOptions {
  config: Config;
  runId: string;
  runDir: string;
  dryRun?: boolean;
  logger?: Logger;
  secrets?: Secrets;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  cache?: Cache;
}

export function createRunContext(options: CreateContextOptions): RunContext {
  const { config } = options;
  const home = homeLayout(config.home);
  const logger = options.logger ?? createLogger();
  const seen = new Set<string>();
  return {
    config,
    secrets: options.secrets ?? loadSecrets(),
    logger,
    redactor: globalRedactor,
    cache: options.cache ?? (config.cache.enabled ? new FileCache(home.cache) : noCache),
    cost: new CostTracker(config.budgetUsd, new PriceBook(config.pricing as Record<string, Price>)),
    egress: new EgressTracker(),
    home,
    runDir: options.runDir,
    runId: options.runId,
    signal: options.signal ?? new AbortController().signal,
    dryRun: options.dryRun ?? false,
    firstTime: (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    progress: (event) => {
      options.onProgress?.(event);
      const line = `[${event.stage}] ${event.message}`;
      if (event.status === 'warn') logger.warn(line);
      else if (event.status === 'progress') logger.debug(line);
      else logger.info(line);
    },
  };
}
