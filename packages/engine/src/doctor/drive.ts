/**
 * Checks of Google Drive publishing: the sign-in and the permission it has, and with --online the
 * organization of the signed-in account. The verdict on the sign-in is the publisher's own (check).
 */
import { isMergeStoryError } from '../core/errors.ts';
import { check } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

const SETUP =
  'Run: mergestory setup drive (see https://github.com/PiniShv/MergeStory/blob/main/docs/drive.md).';
const VISIBILITY = {
  private: 'only you can open the link',
  protected: 'people in your Google Workspace organization can open the link',
  public: 'anyone with the link can open it',
} as const;

export async function checkDrive({ config, ctx, deps, online }: DoctorContext): Promise<DoctorCheck[]> {
  // The repository is not known here, so it is taken as public: the privacy rule is left to the run.
  const refused = (await (await deps.publisher(config))?.check(ctx, false)) ?? null;
  if (refused) {
    const detail = refused.message.startsWith('No Google Drive sign-in')
      ? 'Google Drive: not signed in. Run: mergestory setup drive'
      : `Google Drive: ${refused.message}`;
    // Videos are made on this machine without it; the sign-in is needed only to share, and takes one click.
    return [check('publish', 'Publishing', 'warn', detail, refused.hint ?? SETUP)];
  }
  const [{ loadCredentials }, { DRIVE }, { parseScopes, shortScope }] = await Promise.all([
    import('../publish/google/credentials.ts'),
    import('../publish/drive/provider.ts'),
    import('../publish/google/oauth.ts'),
  ]);
  const scopes = parseScopes((await loadCredentials(ctx, DRIVE)).scope);
  const { visibility } = config.publish;
  const checks = [
    check('publish', 'Publishing', 'pass', 'Google Drive (signed in)'),
    check(
      'publish-credentials',
      'Google Drive login',
      'pass',
      `permission: ${scopes ? scopes.map(shortScope).join(', ') : 'not recorded (the sign-in comes from the environment)'}; ` +
        `visibility ${visibility}: ${VISIBILITY[visibility]}`,
    ),
  ];
  if (online) checks.push(await checkAccount({ config, ctx, deps }));
  return checks;
}

/** Which organization the account belongs to. Only the domain is shown, never the e-mail address. */
async function checkAccount({
  config,
  ctx,
  deps,
}: Pick<DoctorContext, 'config' | 'ctx' | 'deps'>): Promise<DoctorCheck> {
  const name = 'Google Drive account';
  const { isWorkspaceDomain } = await import('../publish/drive/publisher.ts');
  try {
    const domain = await deps.driveDomain(config, ctx);
    const protectedLinks = config.publish.visibility === 'protected';
    if (domain && isWorkspaceDomain(domain))
      return check('publish-account', name, 'pass', `organization: ${domain}`);
    const detail = domain
      ? `a personal Google account (${domain}), not part of an organization`
      : 'Google did not say which organization the account belongs to';
    return protectedLinks
      ? check(
          'publish-account',
          name,
          'fail',
          detail,
          'Protected links need a Google Workspace account. Use --visibility private, or public for public code.',
        )
      : check('publish-account', name, 'pass', detail);
  } catch (err) {
    const problem = isMergeStoryError(err) ? err : null;
    return check(
      'publish-account',
      name,
      'fail',
      problem?.message ?? 'Google Drive could not be reached',
      problem?.hint ?? SETUP,
    );
  }
}
