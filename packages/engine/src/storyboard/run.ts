/**
 * State shared by the validation steps: the issue lists, indexes of what the change contains,
 * the corpus of known names, and the sentence-level checks used for narration and on-screen text.
 */

import { findEvidence } from '../analyzer/evidence.ts';
import type { Config } from '../core/config.ts';
import { changeLabelOf } from '../core/labels.ts';
import { isShowable } from '../core/path-policy.ts';
import { isJoined, type SourceView, sourcesOf } from '../core/source-views.ts';
import { truncate } from '../core/text.ts';
import type {
  EvidenceItem,
  LogInput,
  RecordingInput,
  ReproInput,
  ScreenshotInput,
  TestEvidence,
} from '../core/types.ts';
import { backingHint, CLAIM_LABELS, claimIsSupported, findClaim } from './claims.ts';
import { createRefResolver, type RefResolver } from './coderef.ts';
import {
  addCorpusPaths,
  addCorpusText,
  addProseText,
  createCorpus,
  type KnownCorpus,
  proseSources,
  unknownTokens,
} from './identifiers.ts';
import { joinSentences, splitSentences } from './text.ts';
import type { IssueCode, ValidationDeps, ValidationIssue } from './types.ts';
import { codeTextOf, foreignUrls, hostsIn } from './urls.ts';

/** MergeStory's own words for its input. A viewer has never seen the evidence pack. */
const INTERNAL_TERM =
  /\b(?:evidence pack|the pack (?:flags?|says?|shows?|lists?|notes?|reports?|marks?|has|contains?))\b/i;

/** A sentence on one line, cut to 80 characters, for a message that quotes it. */
function quoted(sentence: string): string {
  return truncate(sentence.replace(/\s+/g, ' ').trim(), 80);
}

/** Evidence kinds whose labels come from the code and its analysis. The others quote text that people wrote. */
const CODE_EVIDENCE = new Set<EvidenceItem['kind']>([
  'file',
  'hunk',
  'symbol',
  'component',
  'risk',
  'dependency',
  'repo',
]);

/**
 * Everything the validator may treat as "named in the change". Names from the code and the analysis
 * count everywhere. Names from text that people wrote (the pull request, commits, issues, the README,
 * the task, the notes and the reported results) count only on a line that cites that text.
 */
function buildKnownCorpus(deps: ValidationDeps): KnownCorpus {
  const { changeSet, analysis, inputs } = deps;
  const corpus = createCorpus();
  const paths = new Set<string>();
  for (const file of changeSet.files) {
    paths.add(file.path);
    if (file.oldPath) paths.add(file.oldPath);
  }
  for (const path of changeSet.repoContext.tree) paths.add(path);
  for (const file of analysis.files) paths.add(file.path);
  for (const symbol of analysis.symbols) paths.add(symbol.path);
  for (const list of [analysis.tests.added, analysis.tests.modified, analysis.tests.removed]) {
    for (const path of list) paths.add(path);
  }
  addCorpusPaths(corpus, paths);

  const code = (text: string | null | undefined): void => {
    if (text) addCorpusText(corpus, text);
  };
  const prose = (id: string, text: string | null | undefined): void => {
    if (text) addProseText(corpus, id, text);
  };
  // With several sources the names and the texts of every one of them count, each under its own ids.
  const sources = sourcesOf(changeSet);
  for (const source of sources) {
    code(source.repo.name);
    code(source.repo.owner);
    code(source.folder);
    // The title card of a joined change may name a local change by its branch (see the title rule).
    if (isJoined(changeSet)) code(source.head.ref);
    const pr = source.pr;
    const id = `${source.idPrefix}PR`;
    if (pr) {
      prose(id, pr.title);
      prose(id, pr.body);
      prose(id, pr.headRef);
      prose(id, pr.baseRef);
      for (const label of pr.labels) prose(id, label);
    }
  }
  for (const commit of changeSet.commits) {
    prose(commit.id, commit.subject);
    prose(commit.id, commit.body);
  }
  for (const issue of changeSet.linkedIssues) {
    prose(issue.id, issue.title);
    prose(issue.id, issue.body);
  }
  for (const source of sources) prose(`${source.idPrefix}REPO`, source.readmeExcerpt);
  for (const manifest of changeSet.repoContext.manifests) code(manifest.excerpt);
  prose('TASK', inputs.task);
  prose('NOTES', inputs.notes);
  for (const test of inputs.tests) {
    prose(test.id, test.command);
    prose(test.id, test.summary);
  }
  for (const shot of inputs.screenshots) prose(shot.id, shot.caption);
  for (const rec of inputs.recordings) prose(rec.id, rec.caption);
  if (inputs.repro) {
    prose('REPRO', inputs.repro.title);
    prose('REPRO', inputs.repro.environment);
    for (const [i, step] of inputs.repro.steps.entries()) prose(`REPRO.${i + 1}`, step.text);
  }

  // Content of sensitive or excluded files never seeds the corpus.
  for (const file of changeSet.files) {
    if (!isShowable(file)) continue;
    for (const hunk of file.hunks) {
      code(hunk.header);
      for (const line of hunk.lines) code(line.text);
    }
  }

  for (const component of analysis.components) {
    code(component.name);
    code(component.path);
  }
  for (const symbol of analysis.symbols) code(symbol.name);
  for (const risk of analysis.risks) {
    code(risk.title);
    code(risk.detail);
  }
  analysis.architectureSignals.forEach(code);
  for (const dependency of analysis.dependencies) {
    code(dependency.name);
    code(dependency.from);
    code(dependency.to);
  }
  for (const item of analysis.evidence) if (CODE_EVIDENCE.has(item.kind)) code(item.label);
  return corpus;
}

/** Hosts named in the code itself (and in the caller's own context), which narration may mention. */
function collectCodeHosts(deps: ValidationDeps): Set<string> {
  const hosts = new Set<string>();
  const add = (text: string | null | undefined) => {
    if (text) for (const host of hostsIn(text)) hosts.add(host);
  };
  for (const file of deps.changeSet.files) {
    if (!isShowable(file)) continue;
    for (const hunk of file.hunks) for (const line of hunk.lines) add(line.text);
  }
  add(deps.inputs.task);
  add(deps.inputs.notes);
  for (const text of [deps.inputs.repro?.title, deps.inputs.repro?.environment]) add(text);
  for (const step of deps.inputs.repro?.steps ?? []) add(step.text);
  return hosts;
}

/** Why a sentence was dropped: the code of the warning and what the writer can do about it. */
export interface Dropped {
  code: 'url-in-text' | 'unverified-claim' | 'unknown-identifier';
  advice: string;
}

export class Run {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  readonly fixes: string[] = [];
  readonly config: Config;
  readonly evidence: Map<string, EvidenceItem>;
  readonly tests: readonly TestEvidence[];
  readonly screenshots: Map<string, ScreenshotInput>;
  readonly recordings: Map<string, RecordingInput>;
  readonly repro: ReproInput | null;
  readonly logs: Map<string, LogInput>;
  readonly corpus: KnownCorpus;
  /** Hosts of web addresses that appear in visible code or in the caller's task and notes. */
  readonly codeHosts: ReadonlySet<string>;
  /** Lower-case code and file paths of the visible files. */
  readonly codeText: string;
  readonly refs: RefResolver;
  /** The storyboard is the offline one, written in English by MergeStory itself. */
  readonly offline: boolean;
  /** The change was joined from several sources. */
  readonly joined: boolean;
  /** The sources of the change: one for an ordinary change. */
  readonly sources: readonly SourceView[];
  /** The words that name the change; for a joined change every change in it ("orders-api #3 + storefront #7"). */
  readonly changeLabel: string;
  private readonly filePaths: ReadonlySet<string>;
  /** An agent or a person wrote the storyboard and reads the result (see ValidationDeps.authored). */
  readonly authored: boolean;
  /** The target length in seconds (see ValidationDeps.targetSec). */
  readonly targetSec: number;

  constructor(deps: ValidationDeps) {
    this.config = deps.config;
    this.joined = isJoined(deps.changeSet);
    this.sources = sourcesOf(deps.changeSet);
    this.changeLabel = changeLabelOf(deps.changeSet);
    this.filePaths = new Set(deps.changeSet.files.map((f) => f.path));
    this.offline = deps.offline ?? false;
    this.authored = deps.authored ?? false;
    this.targetSec = deps.targetSec;
    this.evidence = new Map(deps.analysis.evidence.map((item) => [item.id, item]));
    this.tests = deps.inputs.tests;
    this.screenshots = new Map(deps.inputs.screenshots.map((shot) => [shot.id, shot]));
    this.recordings = new Map(deps.inputs.recordings.map((rec) => [rec.id, rec]));
    this.repro = deps.inputs.repro;
    this.logs = new Map(deps.inputs.logs.map((log) => [log.id, log]));
    this.corpus = buildKnownCorpus(deps);
    this.codeHosts = collectCodeHosts(deps);
    this.codeText = codeTextOf(
      deps.changeSet.files,
      deps.analysis.symbols.map((symbol) => symbol.name),
    );
    this.refs = createRefResolver(deps.changeSet.files, deps.reader);
  }

  error(path: string, code: IssueCode, message: string): void {
    this.errors.push({ path, code, message });
  }

  warn(path: string, code: IssueCode, message: string): void {
    this.warnings.push({ path, code, message });
  }

  /** Record an automatic fix. The path is part of the text so the list reads on its own. */
  fix(path: string, message: string): void {
    this.fixes.push(`${path}: ${message}`);
  }

  /** The other forms of a path that are changed files (the path with the folder of a source in front), as a hint to add to a message. */
  pathHint(path: string): string {
    const forms = this.sources
      .map((s) => `${s.pathPrefix}${path}`)
      .filter((x) => x !== path && this.filePaths.has(x));
    return forms.length > 0
      ? ` (a path starts with the folder of its source: did you mean ${forms.join(' or ')}?)`
      : '';
  }

  /** The other forms of an id that exist (the id with the letter of a source in front: "A.F1 or B.F1"). */
  private idHint(id: string): string {
    const forms = this.sources
      .map((s) => `${s.idPrefix}${id}`)
      .filter((x) => x !== id && this.evidence.has(x));
    return forms.length > 0
      ? ` (an id of a repository starts with its letter: did you mean ${forms.join(' or ')}?)`
      : '';
  }

  /** Cited ids that exist in the evidence index, without duplicates. Unknown ids are reported as fixes. */
  validEvidence(ids: readonly string[], path: string): string[] {
    const valid: string[] = [];
    const unknown: string[] = [];
    for (const raw of ids) {
      const id = raw.trim();
      if (findEvidence(this.evidence, id)) {
        if (!valid.includes(id)) valid.push(id);
      } else if (id) {
        unknown.push(id);
      }
    }
    if (unknown.length > 0) {
      this.fix(
        path,
        `removed unknown evidence id${unknown.length > 1 ? 's' : ''} ${unknown.map((id) => `"${id}"${this.idHint(id)}`).join(', ')}`,
      );
    }
    return valid;
  }

  /**
   * Split text into sentences and check each one (see checkSentence). `kept` holds the sentences that
   * stay, `dropped` why each of the others went, and `all` is every sentence of the text.
   */
  sentences(
    text: string,
    cited: readonly string[],
    path: string,
  ): { all: string[]; kept: string[]; dropped: Dropped[] } {
    const all = splitSentences(text);
    const kept: string[] = [];
    const dropped: Dropped[] = [];
    for (const sentence of all) {
      const why = this.checkSentence(sentence, cited, path);
      if (why) dropped.push(why);
      else kept.push(sentence);
    }
    return { all, kept, dropped };
  }

  /**
   * Check one sentence of narration or on-screen text. A web address, a claim that no passing test
   * result backs, or a code-like name that the change does not contain drops it. A name that only
   * text written by people holds (the pull request, a commit, the task, the notes) is accepted when
   * `cited` cites that text. Returns null when the sentence stays, and why it went when it does not.
   */
  checkSentence(sentence: string, cited: readonly string[], path: string): Dropped | null {
    const internal = INTERNAL_TERM.exec(sentence);
    if (internal) {
      this.warn(
        path,
        'internal-term',
        `says "${internal[0]}", which means nothing to a viewer; say what the change shows`,
      );
    }
    if (foreignUrls(sentence, this.codeHosts, this.codeText).length > 0) {
      this.fix(path, `removed a sentence with a web address that is not in the code: "${quoted(sentence)}"`);
      this.warn(
        path,
        'url-in-text',
        'contains a web address whose host does not appear in the code change, so the sentence was removed',
      );
      return {
        code: 'url-in-text',
        advice: 'contains only a web address that is not in the code; rewrite it without the address',
      };
    }
    const claim = findClaim(sentence);
    if (claim && !claimIsSupported(claim, cited, this.tests)) {
      const backing = backingHint(claim, this.tests);
      this.fix(path, `removed a sentence that claims ${CLAIM_LABELS[claim.kind]}: "${quoted(sentence)}"`);
      this.warn(
        path,
        'unverified-claim',
        `claims ${CLAIM_LABELS[claim.kind]} without evidence ("${claim.match}").${backing}`,
      );
      return {
        code: 'unverified-claim',
        advice: 'contains only an unverifiable claim; rewrite it to say what the change shows',
      };
    }
    const unknown = unknownTokens(sentence, this.corpus, cited);
    if (unknown.length > 0) {
      const list = unknown
        .slice(0, 3)
        .map((token) => `"${token.text}"`)
        .join(', ');
      // A name that only people's text holds is not wrong, it is unsupported: it needs the line to cite that text.
      const sources = [...new Set(unknown.flatMap((token) => proseSources(token, this.corpus)))];
      const where =
        sources.length > 0
          ? `which only the text of ${sources.join(', ')} mentions and the line does not cite`
          : 'which does not appear in the change';
      this.fix(path, `removed a sentence that names ${list}, ${where}: "${quoted(sentence)}"`);
      this.warn(path, 'unknown-identifier', `names ${list}, ${where}; sentence removed`);
      return {
        code: 'unknown-identifier',
        advice:
          sources.length > 0
            ? `names ${list}, which only the text of ${sources.join(', ')} mentions; cite ${sources.join(' or ')} on the line, or leave the names out`
            : `names ${list}, which does not appear in the change; rewrite it with names from the change`,
      };
    }
    return null;
  }
}

/** Cleans on-screen text: sentences with an unverifiable claim, a stray web address or a name that is not in the change are removed. */
export class TextCleaner {
  private readonly run: Run;
  /** Evidence ids cited by the narration of the scene (or of the whole video). */
  private readonly narrationEvidence: readonly string[];

  constructor(run: Run, narrationEvidence: readonly string[]) {
    this.run = run;
    this.narrationEvidence = narrationEvidence;
  }

  /** The text without offending sentences; an empty string when nothing is left. */
  clean(text: string, path: string, ownEvidence: readonly string[] = []): string {
    return this.check(text, path, ownEvidence).text;
  }

  private check(
    text: string,
    path: string,
    ownEvidence: readonly string[],
  ): { text: string; dropped: Dropped[] } {
    const { all, kept, dropped } = this.run.sentences(
      text,
      [...this.narrationEvidence, ...ownEvidence],
      path,
    );
    return { text: kept.length === all.length ? text : joinSentences(kept), dropped };
  }

  /** For text that is shown and must not be empty. Nothing left, or nothing there, is an error. */
  required(text: string, path: string): string {
    if (!text.trim()) {
      this.run.error(path, 'empty-text', 'is empty; write the text for this field');
      return text;
    }
    const { text: cleaned, dropped } = this.check(text, path, []);
    if (!cleaned.trim()) {
      // Text that has words loses them only by dropped sentences, so there is always a reason.
      const why = dropped[0]!;
      this.run.error(path, why.code, why.advice);
      return text;
    }
    return cleaned;
  }

  /** For text that may be null. */
  optional(text: string | null, path: string, ownEvidence: readonly string[] = []): string | null {
    if (text === null) return null;
    const cleaned = this.clean(text, path, ownEvidence);
    return cleaned.trim() ? cleaned : null;
  }

  /** Cleans the `text` of each item and drops the items with nothing left. */
  keepTexts<T extends { text: string }>(items: readonly T[], path: string): T[] {
    return items.flatMap((item, index) => {
      const text = this.clean(item.text, `${path}[${index}].text`);
      return text.trim() ? [{ ...item, text }] : [];
    });
  }

  /**
   * Cleans the title of each item (its `label` or `title`) and drops the items with nothing left.
   * The item's own evidence ids count as backing. `detail` says what happens to the item's detail:
   * 'text' cleans it, 'optional' cleans it and turns an empty result into null, 'none' leaves it.
   */
  keepTitled<K extends 'label' | 'title', T extends Record<K, string> & { evidence?: readonly string[] }>(
    items: readonly T[],
    key: K,
    path: string,
    detail: 'none' | 'text' | 'optional' = 'none',
  ): T[] {
    return items.flatMap((item, index) => {
      const at = `${path}[${index}]`;
      const own = item.evidence ?? [];
      const title = this.clean(item[key], `${at}.${key}`, own);
      if (!title.trim()) return [];
      const kept: T = { ...item, [key]: title };
      if (detail !== 'none') {
        const text = (item as { detail?: string | null }).detail ?? null;
        const cleaned =
          detail === 'text'
            ? this.clean(text ?? '', `${at}.detail`, own)
            : this.optional(text, `${at}.detail`, own);
        (kept as { detail?: string | null }).detail = cleaned;
      }
      return [kept];
    });
  }

  /** Cleans a list of strings and drops the ones with nothing left. */
  list(texts: readonly string[], path: string): string[] {
    return texts.flatMap((text, index) => {
      const cleaned = this.clean(text, `${path}[${index}]`);
      return cleaned.trim() ? [cleaned] : [];
    });
  }
}
