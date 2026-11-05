import { describe, expect, it } from 'vitest';
import { byId, doctor } from '../testing/doctor.ts';

describe('GitHub access', () => {
  it('names the source of the token', async () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const fromEnv = await doctor({}, {}, { GITHUB_TOKEN: token });
    expect(byId(fromEnv.checks, 'github')).toMatchObject({
      status: 'pass',
      detail: 'token from GITHUB_TOKEN',
    });
    expect(JSON.stringify(fromEnv)).not.toContain(token);
    const fromGh = await doctor({}, {}, { GH_TOKEN: token });
    expect(byId(fromGh.checks, 'github').detail).toBe('token from GH_TOKEN');
    const cli = await doctor();
    expect(byId(cli.checks, 'github').detail).toContain('gh CLI is available');
  });

  it('warns when there is no way to authenticate', async () => {
    const report = await doctor({}, { which: async () => null });
    const github = byId(report.checks, 'github');
    expect(github.status).toBe('warn');
    expect(github.detail).toContain('public pull requests only');
    expect(github.fix).toContain('gh auth login');
    const disabled = await doctor({ github: { useGhCli: false } });
    expect(byId(disabled.checks, 'github').status).toBe('warn');
  });
});
