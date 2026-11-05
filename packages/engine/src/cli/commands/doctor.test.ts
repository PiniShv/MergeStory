import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DoctorReport, runDoctor } from '../../doctor/index.ts';
import { runCli } from '../program.ts';

vi.mock('../../doctor/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../doctor/index.ts')>()),
  runDoctor: vi.fn(),
}));

const doctorMock = vi.mocked(runDoctor);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-doctor-'));
  doctorMock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { MERGESTORY_HOME: join(dir, 'home') },
    cwd: dir,
    handleSignals: false,
    stdoutIsTty: false,
    stderrIsTty: false,
  });
  return { code, stdout, stderr };
}

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    online: false,
    version: '1.0.0',
    summary: { pass: 2, warn: 0, fail: 0 },
    checks: [
      { id: 'node', name: 'Node.js', status: 'pass', detail: 'v24.0.0', fix: null },
      { id: 'publish', name: 'Publishing', status: 'pass', detail: 'local: the run folder', fix: null },
    ],
    ...overrides,
  };
}

describe('doctor --online', () => {
  it('stays offline unless it is asked to go online', async () => {
    doctorMock.mockResolvedValue(report());
    const { code } = await run(['doctor']);
    expect(code).toBe(0);
    expect(doctorMock.mock.calls[0]?.[0].online).toBe(false);
  });

  it('asks the checks to contact the services that were set up', async () => {
    doctorMock.mockResolvedValue(report({ online: true }));
    const { code } = await run(['doctor', '--online']);
    expect(code).toBe(0);
    expect(doctorMock.mock.calls[0]?.[0].online).toBe(true);
  });

  it('accepts the flag after the global flags, too', async () => {
    doctorMock.mockResolvedValue(report({ online: true }));
    const { code, stdout } = await run(['doctor', '--json', '--online']);
    expect(code).toBe(0);
    expect(doctorMock.mock.calls[0]?.[0].online).toBe(true);
    expect(JSON.parse(stdout).online).toBe(true);
  });

  it('exits 1 when an online check failed', async () => {
    doctorMock.mockResolvedValue(
      report({
        ok: false,
        online: true,
        summary: { pass: 1, warn: 0, fail: 1 },
        checks: [
          {
            id: 'publish-bucket',
            name: 'Storage access',
            status: 'fail',
            detail: 'bucket videos was not found',
            fix: 'Check the bucket name',
          },
        ],
      }),
    );
    const { code, stdout } = await run(['doctor', '--online']);
    expect(code).toBe(1);
    expect(stdout).toContain('Storage access');
    expect(stdout).toContain('fix: Check the bucket name');
  });

  it('says in its help that nothing is sent without the flag', async () => {
    const { code, stdout } = await run(['doctor', '--help']);
    expect(code).toBe(0);
    const text = stdout.replace(/\s+/g, ' ');
    expect(text).toContain('--online');
    expect(text).toContain('Without it nothing is sent over the network');
    expect(doctorMock).not.toHaveBeenCalled();
  });
});
