/**
 * Languages in which the analyzer reads neither declarations nor imports. It knows how their comments
 * start and whether indentation carries meaning, which is enough to judge a change to them.
 */
import { C_COMMENTS, HASH_COMMENTS, MARKUP_COMMENTS, SQL_COMMENTS } from './shared.ts';
import type { LanguageSupport } from './types.ts';

export const OTHERS: readonly LanguageSupport[] = [
  {
    extensions: [
      '.scala',
      '.swift',
      '.c',
      '.h',
      '.cpp',
      '.cc',
      '.hpp',
      '.dart',
      '.css',
      '.scss',
      '.less',
      '.proto',
      '.groovy',
    ],
    comments: C_COMMENTS,
  },
  {
    extensions: ['.sh', '.bash', '.zsh', '.toml', '.r', '.ex', '.exs', '.tf', '.hcl', '.nix'],
    names: ['dockerfile'],
    comments: HASH_COMMENTS,
  },
  { extensions: ['.yaml', '.yml'], comments: HASH_COMMENTS, indentSensitive: true },
  { extensions: ['.sql', '.lua', '.hs', '.elm'], comments: SQL_COMMENTS },
  { extensions: ['.html', '.htm', '.xml'], comments: MARKUP_COMMENTS },
  // Indentation structures the text; how a comment starts is not known.
  {
    extensions: ['.pug', '.haml', '.slim', '.coffee', '.styl', '.nim', '.mk', '.md'],
    names: ['makefile'],
    indentSensitive: true,
  },
];
