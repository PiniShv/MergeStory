/**
 * The run context for tests: silent unless a test asks to read the logs, no cache, no secrets, and no
 * configuration file or environment. Not part of the public API.
 */
import { join } from 'node:path';
import { type Cache, noCache } from '../core/cache.ts';
import { type Config, type ConfigInput, resolveConfig, type SecretName, Secrets } from '../core/config.ts';
import { createRunContext, type RunContext } from '../core/context.ts';
import { createLogger, type Logger, silentLogger } from '../core/logger.ts';
import { Redactor } from '../core/redact.ts';
import type { ProgressEvent } from '../core/types.ts';

export interface TestContextOptions {
  /** Configuration on top of the defaults. */
  config?: ConfigInput;
  /** Sets the home folder. Without it the configuration keeps its default home. */
  home?: string;
  /** Where the run keeps its files. Default: `run` inside `home`, or a folder that does not exist. */
  runDir?: string;
  runId?: string;
  secrets?: Partial<Record<SecretName, string>>;
  cache?: Cache;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Another logger. Ignored when `captureLogs` is set. */
  logger?: Logger;
  /** Collect every log line in `logs`. The lines are not redacted, so tests see what the code wrote. */
  captureLogs?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface TestContext {
  ctx: RunContext;
  logs: string[];
  /** Every progress event the run reported. */
  events: ProgressEvent[];
}

export function testContext(options: TestContextOptions = {}): TestContext {
  const logs: string[] = [];
  const events: ProgressEvent[] = [];
  const overrides = options.home === undefined ? options.config : { ...options.config, home: options.home };
  // Secrets go to the shared redactor, which the code under test uses for its messages. When the test
  // reads the logs, secrets and logger share a private redactor instead.
  const redactor = options.captureLogs ? new Redactor() : undefined;
  const logger = redactor
    ? createLogger({ level: 'debug', write: (line) => logs.push(line), color: false, redactor })
    : (options.logger ?? silentLogger);
  const ctx = createRunContext({
    config: resolveConfig({ skipFile: true, env: {}, overrides }),
    runId: options.runId ?? 'test-run',
    runDir: options.runDir ?? (options.home === undefined ? '/nonexistent' : join(options.home, 'run')),
    logger,
    secrets: new Secrets(options.secrets ?? {}, redactor),
    cache: options.cache ?? noCache,
    dryRun: options.dryRun,
    signal: options.signal,
    onProgress: (event) => {
      events.push(event);
      options.onProgress?.(event);
    },
  });
  return { ctx, logs, events };
}

/** Config with defaults, no config file and no environment. */
export function testConfig(overrides: ConfigInput = {}): Config {
  return resolveConfig({ skipFile: true, env: {}, overrides });
}
