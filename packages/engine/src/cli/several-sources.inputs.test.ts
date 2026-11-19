import { describe, expect, it } from 'vitest';
import { followUpFor } from './options.ts';

describe('the commands for the next step with several sources', () => {
  it('repeat every --source and every input of the caller', () => {
    const { source, args } = followUpFor(
      '',
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
      ['/work/orders-api:main..fix/x', 'https://github.com/acme/storefront/pull/7'],
    );
    expect(source).toBe('');
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
