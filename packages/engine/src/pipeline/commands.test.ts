import { describe, expect, it } from 'vitest';
import { type ConfigInput, resolveConfig } from '../core/config.ts';
import { commandLine, publishCommand } from './commands.ts';

describe('commandLine', () => {
  it('quotes each word that needs it and joins the words with spaces', () => {
    expect(commandLine(['mergestory', 'validate', '/work/my storyboard.json', 'feature/retry'])).toBe(
      "mergestory validate '/work/my storyboard.json' feature/retry",
    );
  });

  it('keeps a multi-line task as one word', () => {
    expect(commandLine(['--task', 'first line\nsecond line'])).toBe("--task 'first line\nsecond line'");
  });

  it('quotes a task that starts with #, which a shell would take for a comment', () => {
    expect(commandLine(['analyze', '.', '--task', '#42'])).toBe("analyze . --task '#42'");
  });
});

describe('publishCommand', () => {
  const config = (overrides: ConfigInput) => resolveConfig({ skipFile: true, env: {}, overrides });

  it('repeats the settings that decide where the video goes', () => {
    expect(publishCommand('/runs/r1', config({ publish: { provider: 's3', visibility: 'protected' } }))).toBe(
      'mergestory publish /runs/r1 --publish s3 --visibility protected',
    );
    expect(
      publishCommand(
        '/runs/r1',
        config({ publish: { provider: 'youtube' }, github: { comment: true, updateDescription: true } }),
      ),
    ).toBe('mergestory publish /runs/r1 --publish youtube --comment --update-description');
    expect(
      publishCommand('/runs/r1', config({ publish: { provider: 'drive', visibility: 'protected' } })),
    ).toBe('mergestory publish /runs/r1 --publish drive --visibility protected');
  });

  it('quotes a folder with a space, and never suggests publishing to "none"', () => {
    expect(publishCommand('/my runs/r1', config({ publish: { provider: 'none' } }))).toBe(
      "mergestory publish '/my runs/r1' --publish local",
    );
  });
});
