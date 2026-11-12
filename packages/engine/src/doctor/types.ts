/** What `mergestory doctor` reports, and everything its checks touch outside this folder. */
import type { Config, Secrets } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import type { Publisher } from '../core/providers.ts';
import type { AccessProbeResult } from '../publish/access-probe.ts';
import type { BucketCheck } from '../publish/s3/index.ts';

/** Outcome of one check. Only "fail" makes the report fail. */
export type CheckStatus = 'pass' | 'warn' | 'fail';

/** One line of the report. */
export interface DoctorCheck {
  /** Stable machine name, for example "ffmpeg". */
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do when the check does not pass. */
  fix: string | null;
}

/** The result of `mergestory doctor`. */
export interface DoctorReport {
  /** false when any check failed. Warnings do not change it. */
  ok: boolean;
  /** true when the checks also contacted the services you configured (--online). */
  online?: boolean;
  version: string;
  summary: Record<CheckStatus, number>;
  checks: DoctorCheck[];
}

/** Outcome of running a program: exit code and output. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Which values the saved YouTube sign-in holds. */
export interface YouTubeLoginFile {
  clientId: boolean;
  clientSecret: boolean;
  refreshToken: boolean;
}

/** Everything the checks touch outside this folder, so tests can replace it. */
export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which(command: string): Promise<string | null>;
  /** Runs a program and never throws: a program that cannot start gives code -1. */
  run(command: string, args: string[]): Promise<RunResult>;
  resolveFfmpeg(config: Config): Promise<{ ffmpeg: string; ffprobe: string }>;
  resolveBrowser(config: Config): Promise<{ path: string; source: string }>;
  kokoroStatus(config: Config): Promise<{ installed: boolean; version: string | null; modelCached: boolean }>;
  /** Free bytes on the disk that holds `path`, or null when unknown. */
  freeBytes(path: string): Promise<number | null>;
  /** The path itself when it exists, otherwise its nearest parent that does. */
  existingAncestor(path: string): Promise<string>;
  isWritable(path: string): Promise<boolean>;
  /** Asks the storage service about the bucket with the real credentials (HeadBucket). Never throws. */
  headBucket(config: Config, secrets: Secrets): Promise<BucketCheck>;
  /** Asks the public link address, without any credentials, whether it needs a sign-in. */
  probeAccess(url: string, folder: string): Promise<AccessProbeResult>;
  /**
   * Which values the saved YouTube sign-in holds, or null when there is no file. Never the values.
   * Throws when the file is there but cannot be used (for example when other users can read it).
   */
  readYouTubeLogin(path: string): Promise<YouTubeLoginFile | null>;
  /** The organization domain of the Google Drive account (about.get), or null when Google does not say. Throws when it fails. */
  driveDomain(config: Config, ctx: RunContext): Promise<string | null>;
  /**
   * The publisher that the settings name, built as a run builds it, or null when nothing is published.
   * The report asks it what an upload would refuse (check), so the report and the upload apply the same
   * rules, for example that a client id from the environment must be the one the saved sign-in was made with.
   */
  publisher(config: Config): Promise<Pick<Publisher, 'check'> | null>;
}

/** What every group of checks works with. */
export interface DoctorContext {
  config: Config;
  secrets: Secrets;
  /** The run that the speech and publishing rules are asked about: these settings, these secrets, this machine. */
  ctx: RunContext;
  deps: DoctorDeps;
  /** Also contact the services you configured (storage, link protection). */
  online: boolean;
}
