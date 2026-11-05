/** Checks of the MergeStory home folder: that it can be written to, and the room left on its disk. */
import { homeLayout } from '../core/paths.ts';
import { check } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

const MIN_FREE_BYTES = 2 * 1024 ** 3;

export async function checkHome({ config, deps }: DoctorContext): Promise<DoctorCheck[]> {
  const home = homeLayout(config.home).home;
  const base = await deps.existingAncestor(home);
  const writable = await deps.isWritable(base);
  const checks: DoctorCheck[] = [
    writable
      ? check('home', 'MergeStory home', 'pass', `${home} is writable`)
      : check(
          'home',
          'MergeStory home',
          'fail',
          `${home} is not writable`,
          'Fix the permissions, or set MERGESTORY_HOME to a folder you can write to.',
        ),
  ];
  const free = await deps.freeBytes(base);
  if (free === null) {
    checks.push(check('disk', 'Free disk space', 'pass', 'not measured on this system'));
  } else {
    const gb = (free / 1024 ** 3).toFixed(1);
    checks.push(
      free < MIN_FREE_BYTES
        ? check(
            'disk',
            'Free disk space',
            'warn',
            `${gb} GB free next to ${home} (videos and caches need room)`,
            'Free up disk space, or set MERGESTORY_HOME to a bigger disk.',
          )
        : check('disk', 'Free disk space', 'pass', `${gb} GB free`),
    );
  }
  return checks;
}
