import { describe, expect, it } from 'vitest';
import { cleanCommitMessage, cutText, excerptLines, sanitizeText, splitCommitMessage } from './text.ts';

const privacy = { maskEmails: true };

describe('splitCommitMessage', () => {
  it('uses the first paragraph as the subject', () => {
    expect(splitCommitMessage('Add retry\n\nRetries three times.\nBacks off.\n')).toEqual({
      subject: 'Add retry',
      body: 'Retries three times.\nBacks off.',
    });
    expect(splitCommitMessage('one line only')).toEqual({ subject: 'one line only', body: '' });
    expect(splitCommitMessage('wrapped\nsubject\n\nbody')).toEqual({
      subject: 'wrapped subject',
      body: 'body',
    });
    expect(splitCommitMessage('  \n')).toEqual({ subject: '', body: '' });
    expect(splitCommitMessage('a\r\n\r\nb\r\n')).toEqual({ subject: 'a', body: 'b' });
  });
});

describe('cleanCommitMessage', () => {
  it('drops trailers that name people and masks e-mails and secrets', () => {
    const message = [
      'Fix login (#12)',
      '',
      'Contact me at jane.doe@example.com for details.',
      'Token used while testing: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      '',
      'Co-authored-by: Jane Doe <jane.doe@example.com>',
      'Signed-off-by: John Roe <john@example.org>',
      'Reviewed-on: https://example.com/review/1',
    ].join('\n');
    const { subject, body } = cleanCommitMessage(message, privacy);
    expect(subject).toBe('Fix login (#12)');
    expect(body).not.toContain('Jane Doe');
    expect(body).not.toContain('John Roe');
    expect(body).not.toContain('jane.doe@example.com');
    expect(body).not.toContain('ghp_');
    expect(body).toContain('Reviewed-on: https://example.com/review/1');
    expect(body).toContain('j•••@example.com');
  });

  it('keeps e-mail addresses when masking is off, but still masks secrets', () => {
    const { body } = cleanCommitMessage('s\n\nmail a@b.example key sk-ant-api03-abcdefghijklmnop', {
      maskEmails: false,
    });
    expect(body).toContain('a@b.example');
    expect(body).not.toContain('sk-ant');
  });

  it('caps very long messages', () => {
    const { subject, body } = cleanCommitMessage(`${'s'.repeat(2000)}\n\n${'b'.repeat(9000)}`, privacy);
    expect(subject.length).toBe(500);
    expect(body.length).toBe(2000);
  });
});

describe('text helpers', () => {
  it('cuts text without splitting a surrogate pair', () => {
    expect(cutText('abcdef', 3)).toBe('abc');
    expect(cutText('abc', 10)).toBe('abc');
    const cut = cutText('a😀b', 2);
    expect(cut).toBe('a');
  });

  it('takes whole lines for an excerpt', () => {
    const text = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n');
    expect(excerptLines(text, 2, 1000)).toBe('line 1\nline 2');
    expect(excerptLines(text, 10, 14)).toBe('line 1\nline 2');
    expect(excerptLines('x'.repeat(50), 5, 10)).toBe('x'.repeat(10));
    expect(excerptLines('', 5, 10)).toBe('');
  });

  it('masks secrets in free text', () => {
    expect(sanitizeText('password = "hunter2hunter2"', privacy)).not.toContain('hunter2');
    expect(sanitizeText('mail me: a.b@example.com', privacy)).toContain('a•••@example.com');
    expect(sanitizeText('mail me: a.b@example.com', { maskEmails: false })).toContain('a.b@example.com');
  });
});
