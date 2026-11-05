/** Check of the way GitHub is reached. */
import { check } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

export async function checkGithub({ config, secrets, deps }: DoctorContext): Promise<DoctorCheck> {
  if (secrets.has('GITHUB_TOKEN')) return check('github', 'GitHub access', 'pass', 'token from GITHUB_TOKEN');
  if (secrets.has('GH_TOKEN')) return check('github', 'GitHub access', 'pass', 'token from GH_TOKEN');
  if (config.github.useGhCli && (await deps.which('gh'))) {
    return check(
      'github',
      'GitHub access',
      'pass',
      'no token variable set; the gh CLI is available and its login is used when needed',
    );
  }
  return check(
    'github',
    'GitHub access',
    'warn',
    'no token: public pull requests only, with low rate limits',
    'Set GITHUB_TOKEN, or log in with the GitHub CLI: gh auth login',
  );
}
