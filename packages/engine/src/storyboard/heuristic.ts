/**
 * The offline storyboard. It is built from the analysis alone: no network, no model, the same
 * output for the same input. It names the real functions, classes and constants that changed,
 * shows the code around the most important one, and states the values the analysis found. It
 * never claims behaviour, intent or results that the data does not show. Text that comes from the
 * author (PR title, description, task, notes) is quoted and attributed, never restated as fact.
 */
import type { Config } from '../core/config.ts';
import { narrationWords, wordBudget } from '../core/storyboard-facts.ts';
import {
  STORYBOARD_LIMITS as LIMITS,
  type Scene,
  STORYBOARD_VERSION,
  type Storyboard,
} from '../core/storyboard-schema.ts';
import { countWords, naturalList, plural } from '../core/text.ts';
import type { Analysis, ChangeSet, ContextInputs, SymbolChange } from '../core/types.ts';
import { type Ctx, cite, createCtx, type Line, safeSentence, safeText } from './heuristic-context.ts';
import { authorStatements, recap, reportedRuns, testsLine, topSymbols } from './heuristic-facts.ts';
import { bigPictureScene } from './heuristic-overview.ts';
import { type Review, reviewScene } from './heuristic-review.ts';
import { codeScenes } from './heuristic-scenes.ts';
import {
  type Build,
  componentName,
  type Level,
  meaningfulComponents,
  scene,
  sizeText,
  topFiles,
} from './heuristic-shared.ts';
import { firstMeaningfulSentence, stripMarkdown, truncateText } from './text.ts';

/** From the richest storyboard to the leanest. The first one that fits the word budget wins. */
const LEVELS: Level[] = [
  {
    codeScenes: 3,
    codeLines: 4,
    reviewItems: 5,
    missionLines: 3,
    bigPictureLines: 4,
    conclusionLines: 3,
    quotes: true,
  },
  {
    codeScenes: 3,
    codeLines: 3,
    reviewItems: 4,
    missionLines: 3,
    bigPictureLines: 3,
    conclusionLines: 3,
    quotes: true,
  },
  {
    codeScenes: 2,
    codeLines: 3,
    reviewItems: 4,
    missionLines: 3,
    bigPictureLines: 2,
    conclusionLines: 2,
    quotes: true,
  },
  {
    codeScenes: 2,
    codeLines: 2,
    reviewItems: 3,
    missionLines: 2,
    bigPictureLines: 2,
    conclusionLines: 2,
    quotes: true,
  },
  {
    codeScenes: 1,
    codeLines: 2,
    reviewItems: 3,
    missionLines: 2,
    bigPictureLines: 2,
    conclusionLines: 2,
    quotes: true,
  },
  {
    codeScenes: 1,
    codeLines: 1,
    reviewItems: 2,
    missionLines: 1,
    bigPictureLines: 1,
    conclusionLines: 1,
    quotes: false,
  },
];

/** The sentence after the first meaningful one, for a task or description that has two. */
function secondSentence(ctx: Ctx, raw: string | null | undefined, maxWords = 34): string | null {
  if (!raw) return null;
  const flat = stripMarkdown(raw).replace(/\s*\n\s*/g, ' ');
  const first = firstMeaningfulSentence(raw);
  if (!first) return null;
  const at = flat.indexOf(first);
  if (at < 0) return null;
  const next = firstMeaningfulSentence(flat.slice(at + first.length));
  const text = next ? safeText(ctx, next) : null;
  return text && countWords(text) <= maxWords ? text : null;
}

function missionScene(b: Build): { scene: Scene; heading: string } {
  const { ctx, level } = b;
  const { changeSet, inputs } = ctx;
  const pr = changeSet.pr;
  const prTitle = pr ? safeText(ctx, pr.title) : null;
  const taskSentence = safeSentence(ctx, inputs.task);
  const commit = changeSet.commits[changeSet.commits.length - 1];
  const commitSubject = commit ? safeText(ctx, commit.subject) : null;
  const subject = prTitle ?? taskSentence ?? commitSubject ?? null;
  // The heading is the shortest author text that needs no cutting: a task is often a whole sentence.
  const shortTask =
    taskSentence !== null && taskSentence.length <= LIMITS.maxTitleLength ? taskSentence : null;
  const heading = truncateText(
    prTitle ?? shortTask ?? commitSubject ?? taskSentence ?? `Changes in ${changeSet.repo.name}`,
    LIMITS.maxTitleLength,
  );
  // Spoken text quotes the whole title (up to a limit), with inner double quotes made single.
  const spoken = truncateText(subject ?? heading, 100).replace(/"/g, "'");
  const files = topFiles(ctx, 4);

  const lines: Line[] = [];
  if (pr && prTitle) {
    lines.push({
      text: `This video walks through pull request ${pr.number}, titled "${spoken}".`,
      evidence: cite(ctx, 'PR'),
    });
  } else if (taskSentence && subject === taskSentence) {
    lines.push({ text: `The task for this change was: ${taskSentence}`, evidence: cite(ctx, 'TASK') });
  } else if (commit && commitSubject) {
    lines.push({
      text: `This video walks through a change described as "${spoken}".`,
      evidence: cite(ctx, commit.id),
    });
  } else {
    lines.push({
      text: `This video walks through a ${changeSet.source === 'local' ? 'local ' : ''}change.`,
      evidence: cite(ctx, ...files.map((f) => f.id)),
    });
  }

  const bodySentence = pr ? safeSentence(ctx, pr.body) : null;
  if (level.missionLines >= 2) {
    const taskNext = secondSentence(ctx, inputs.task);
    if (bodySentence && bodySentence.toLowerCase() !== (prTitle ?? '').toLowerCase()) {
      lines.push({ text: `The description says: ${bodySentence}`, evidence: cite(ctx, 'PR') });
    } else if (taskSentence && subject !== taskSentence) {
      lines.push({ text: `The task was: ${taskSentence}`, evidence: cite(ctx, 'TASK') });
    } else if (taskSentence && subject === taskSentence && taskNext) {
      lines.push({ text: `The task then asks: ${taskNext}`, evidence: cite(ctx, 'TASK') });
      b.used.add(taskNext);
    }
  }
  if (bodySentence) b.used.add(bodySentence);
  const { files: fileCount, additions, deletions } = changeSet.stats;
  if (level.missionLines >= 3 || lines.length < level.missionLines) {
    lines.push({
      text: `It changes ${plural(fileCount, 'file')}, with ${sizeText(additions, deletions)}.`,
      evidence: cite(ctx, ...files.map((f) => f.id)),
    });
  }

  // Chips preview what the video is about: the names that matter most, or else the components.
  const names = topSymbols(ctx)
    .filter(
      (view) =>
        view.symbol.kind !== 'other' &&
        view.name.length <= 28 &&
        // A bare lowercase word such as "get" says nothing on a title card.
        (view.name.length >= 5 || /[A-Z_.]/.test(view.name)),
    )
    .map((view) => view.name);
  const chips = (
    names.length > 0
      ? [...new Set(names)]
      : meaningfulComponents(ctx).map((component) => componentName(ctx, component))
  ).slice(0, 4);
  const kicker = pr ? `Pull request #${pr.number}` : 'Local change';
  const visual: Scene['visual'] = {
    type: 'title',
    kicker,
    heading,
    subheading: `${plural(fileCount, 'file')} · +${additions} −${deletions}`,
    chips,
  };
  return {
    scene: scene(
      'mission',
      'What this change is',
      lines.slice(0, level.missionLines),
      visual,
      'A title card with the name of the change and its size.',
      'fade',
    ),
    heading,
  };
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

function conclusionScene(b: Build, review: Pick<Review, 'firstSubject' | 'firstEvidence'> | null): Scene {
  const { ctx, level } = b;
  const { changeSet } = ctx;
  const { files: fileCount, additions, deletions } = changeSet.stats;
  const components = meaningfulComponents(ctx);
  const names = components.slice(0, 3).map((component) => componentName(ctx, component));
  const reported = reportedRuns(ctx);
  const summary = recap(ctx);

  const lines: Line[] = [
    summary
      ? { text: `In short, the change ${summary.clause}.`, evidence: cite(ctx, ...summary.ids) }
      : {
          text:
            names.length > 0
              ? `To sum up, the change touches ${plural(fileCount, 'file')} in ${naturalList(names)}.`
              : `To sum up, the change touches ${plural(fileCount, 'file')}.`,
          evidence: cite(
            ctx,
            ...components.slice(0, 3).map((c) => c.id),
            ...topFiles(ctx, 2).map((f) => f.id),
          ),
        },
  ];
  const points: { text: string; beat: number }[] = [
    { text: `${plural(fileCount, 'file')} changed: +${additions} −${deletions}`, beat: 0 },
  ];
  if (summary) {
    const named = topSymbols(ctx).filter((view) => view.symbol.kind !== 'other');
    const list = (change: SymbolChange['change'], max: number): string[] =>
      named
        .filter((view) => view.symbol.change === change)
        .slice(0, max)
        .map((view) => view.name);
    for (const [label, change, max] of [
      ['New', 'added', 3],
      ['Changed', 'modified', 2],
      ['Removed', 'removed', 2],
    ] as const) {
      const found = list(change, max);
      if (found.length > 0) points.push({ text: `${label}: ${found.join(', ')}`, beat: 0 });
    }
  } else if (names.length > 0) {
    points.push({
      text: `Components: ${naturalList(components.slice(0, 5).map((c) => componentName(ctx, c)))}`,
      beat: 0,
    });
  }

  // A run that did not pass is said at every level: it is the one thing a reviewer must not miss.
  if (level.conclusionLines >= 2 || reported?.failed) {
    const tests = testsLine(ctx);
    if (reported) {
      lines.push(reported.line);
      points.push({ text: reported.point, beat: lines.length - 1 });
    } else if (tests) {
      lines.push(tests);
      points.push({ text: tests.text.replace(/\.$/, ''), beat: lines.length - 1 });
    }
  }
  if (level.conclusionLines >= 3 || lines.length < 2) {
    const subject = review?.firstSubject;
    lines.push({
      text: subject ? `Start the review with: ${subject}.` : `Start the review with the largest change.`,
      evidence: review?.firstEvidence.length
        ? review.firstEvidence
        : cite(ctx, ...topFiles(ctx, 1).map((f) => f.id)),
    });
    points.push({
      text: subject ? `Review first: ${subject}` : 'Review the largest change first',
      beat: lines.length - 1,
    });
  }
  const kept = lines.slice(0, LIMITS.maxNarrationLinesPerScene);
  return scene(
    'conclusion',
    'Wrap up',
    kept,
    {
      type: 'summary',
      points: points
        .slice(0, LIMITS.maxBullets)
        .map((point) => ({ ...point, beat: Math.min(point.beat, kept.length - 1) })),
      closing: null,
    },
    'A short list of what changed and what to review first.',
    'fade',
  );
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function buildStoryboard(ctx: Ctx, level: Level): Storyboard {
  const { changeSet, config } = ctx;
  const b: Build = {
    ctx,
    level,
    statements: level.quotes ? authorStatements(ctx) : [],
    used: new Set(),
    quoted: false,
  };
  const mission = missionScene(b);
  const bigPicture = bigPictureScene(b);
  const code = codeScenes(b);
  const review = reviewScene(b);
  const scenes: Scene[] = [mission.scene, bigPicture, ...code];
  if (review) scenes.push(review.scene);
  scenes.push(conclusionScene(b, review));
  scenes.forEach((s, index) => {
    s.id = `s${index + 1}`;
  });

  const { files: fileCount, additions, deletions } = changeSet.stats;
  const names = meaningfulComponents(ctx)
    .slice(0, 3)
    .map((component) => componentName(ctx, component));
  const summary = recap(ctx);
  const description = changeSet.pr
    ? safeSentence(ctx, changeSet.pr.body)
    : safeSentence(ctx, ctx.inputs.task);
  const overview = summary
    ? `The change ${summary.clause}, in ${plural(fileCount, 'file')} (+${additions} −${deletions}).`
    : `${plural(fileCount, 'file')} changed, with ${sizeText(additions, deletions)}${names.length > 0 ? `, in ${naturalList(names)}` : ''}.`;
  const summaryText = [
    overview,
    description ? `${changeSet.pr ? 'The description says' : 'The task was'}: ${description}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  const uncertainties = [
    'This storyboard was built from the diff alone, so it says what changed and not why.',
  ];
  if (b.quoted) {
    uncertainties.push(
      'Statements marked as coming from the notes or the description are the author’s words and were not checked against the code.',
    );
  }
  if (changeSet.limits.filesCapped)
    uncertainties.push(changeSet.limits.note ?? 'Only part of a large change was analysed.');
  if (changeSet.files.some((file) => file.patchTruncated))
    uncertainties.push(
      'The diff of some files was too large to read, so those files are listed without detail.',
    );
  if (!config.language.toLowerCase().startsWith('en'))
    uncertainties.push('The narration of this offline storyboard is written in English.');

  return {
    version: STORYBOARD_VERSION,
    title: truncateText(mission.heading, LIMITS.maxTitleLength),
    summary: summaryText,
    style: config.style,
    language: config.language,
    scenes,
    reviewChecklist: review?.items ?? [],
    uncertainties,
  };
}

/**
 * Deterministic, offline storyboard built only from the analysis. It fits the word budget
 * (target seconds times the speaking rate) by dropping optional scenes and lines, never by cutting sentences.
 */
export function heuristicStoryboard(
  changeSet: ChangeSet,
  analysis: Analysis,
  inputs: ContextInputs,
  config: Config,
  targetSec: number,
): Storyboard {
  const ctx = createCtx(changeSet, analysis, inputs, config);
  const budget = wordBudget(targetSec);
  let last: Storyboard | null = null;
  for (const level of LEVELS) {
    last = buildStoryboard(ctx, level);
    if (narrationWords(last) <= budget) return last;
  }
  return last!;
}
