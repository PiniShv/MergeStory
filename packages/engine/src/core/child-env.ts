/**
 * Environments for the programs MergeStory starts (git, gh). A child process gets what it needs
 * and none of the API keys and tokens that happen to be set for other parts of the tool.
 */
import { SECRET_ENV_VARS } from './config.ts';

/** Names that look like credentials, even when they are not on the known list. */
const SECRET_LIKE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)/i;

/** Variables that point git at a different repository or change how it prints. */
const GIT_REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_PAGER',
];

/** The environment for git: no credentials, no redirection to another repository, no prompts or optional writes. */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (GIT_REDIRECTS.includes(name)) continue;
    if ((SECRET_ENV_VARS as readonly string[]).includes(name) || SECRET_LIKE.test(name)) continue;
    env[name] = value;
  }
  // Optional locks off: git never refreshes the index of the repository being read.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  // English messages, so the few places that read git's error text are reliable.
  env.LC_ALL = 'C';
  return env;
}

/**
 * The environment for `gh auth token`. Every credential is removed, including gh's own GH_TOKEN,
 * GITHUB_TOKEN, GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN: gh prints those for hosts it has
 * no login for, so a pull request URL on another host would otherwise receive them. What is left
 * is the login stored for that exact host (gh settings such as GH_CONFIG_DIR stay).
 */
export function ghEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if ((SECRET_ENV_VARS as readonly string[]).includes(name) || SECRET_LIKE.test(name)) continue;
    env[name] = value;
  }
  env.GH_PROMPT_DISABLED = '1';
  env.NO_COLOR = '1';
  return env;
}
