/** Checks of publishing: nothing and the local folder need none, S3, YouTube and Google Drive have their own groups. */
import { check } from './check.ts';
import { checkDrive } from './drive.ts';
import { checkS3 } from './s3.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';
import { checkYouTube } from './youtube.ts';

export async function checkPublish(c: DoctorContext): Promise<DoctorCheck[]> {
  const { provider, localDir } = c.config.publish;
  if (provider === 'none')
    return [check('publish', 'Publishing', 'pass', 'none: files stay in the run folder')];
  if (provider === 'local') {
    return [
      check('publish', 'Publishing', 'pass', `local: ${localDir ?? 'the run folder'}. Nothing is uploaded.`),
    ];
  }
  if (provider === 'drive') return checkDrive(c);
  return provider === 'youtube' ? checkYouTube(c) : checkS3(c);
}
