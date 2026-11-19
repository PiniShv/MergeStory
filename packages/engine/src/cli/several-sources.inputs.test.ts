import { describe, expect, it } from 'vitest';
import { followUpFor, sourceWordsOf } from './options.ts';

describe('the source words of the commands for the next step', () => {
  const local = (repoPath: string, base: string | null = null, head: string | null = null) =>
    ({ kind: 'local', repoPath, base, head }) as const;

  it('are the source with its refs, or one --source for each source', () => {
    expect(sourceWordsOf('repo', { source: '/w/repo' }, { base: 'main', head: 'x' })).toEqual([
      '/w/repo',
      '--base',
      'main',
      '--head',
      'x',
    ]);
    expect(
      sourceWordsOf(undefined, { source: local('/w/a', 'main', 'x') }, { source: ['a:main..x'] }),
    ).toEqual(['--source', '/w/a:main..x']);
    expect(
      sourceWordsOf(
        undefined,
        { source: local('/w/a'), sources: [local('/w/a'), local('/w/b')] },
        { source: ['a', 'b'] },
      ),
    ).toEqual(['--source', '/w/a', '--source', '/w/b']);
  });
});

describe('the commands for the next step with several sources', () => {
  it('repeat every --source and every input of the caller', () => {
    const { args } = followUpFor(
      ['--source', '/work/orders-api:main..fix/x', '--source', 'https://github.com/acme/storefront/pull/7'],
      {
        task: 'Fix it',
        taskFile: 'task.md',
        notesFile: 'notes.md',
        testsFile: 'tests.json',
        reproFile: 'repro.json',
        screenshot: ['page.png:The page'],
        screenshotsDir: 'shots',
        recording: ['clip.mp4'],
        log: ['run.log:Test run'],
        redact: 'redact.json',
      },
      '/work',
    );
    expect(args).toEqual([
      '--source',
      '/work/orders-api:main..fix/x',
      '--source',
      'https://github.com/acme/storefront/pull/7',
      '--task',
      'Fix it',
      '--task-file',
      '/work/task.md',
      '--notes-file',
      '/work/notes.md',
      '--tests-file',
      '/work/tests.json',
      '--repro-file',
      '/work/repro.json',
      '--screenshot',
      '/work/page.png:The page',
      '--screenshots-dir',
      '/work/shots',
      '--recording',
      '/work/clip.mp4',
      '--log',
      '/work/run.log:Test run',
      '--redact',
      '/work/redact.json',
    ]);
  });
});
