/**
 * Keeping a storyboard within the maximum video length (--max-duration).
 *
 * The real length is only known once speech exists, and speech is the step that can cost money. So
 * the storyboard is trimmed before narration, against an estimate: every line takes as long as its
 * words need at the speaking rate of the silent provider, and the title, pauses, minimum scene
 * lengths, transitions and end card are added the way the real timeline adds them.
 *
 * Whole scenes go first, the least important first: the wrap-up, the overview, then the code
 * scenes, later ones before earlier ones. When a scene only has to lose a little, it loses its last
 * lines instead of disappearing. The mission and review scenes are never dropped, and every scene
 * keeps at least one line. If those scenes alone are too long, the result says so.
 *
 * What this guarantees: the estimate fits, or the result says that it cannot. It does not
 * guarantee the length of the finished video, because a real voice is a little faster or slower than
 * the estimate.
 */
import { beatHolders, isSimulated } from '../core/storyboard-facts.ts';
import { type Scene, type SceneRole, STORYBOARD_LIMITS, type Storyboard } from '../core/storyboard-schema.ts';
import { naturalList, plural } from '../core/text.ts';
import { estimateNarration } from '../narration/index.ts';
import { buildTimeline } from '../visuals/timeline.ts';

/** Scenes of these roles are never dropped. */
const PROTECTED_ROLES: ReadonlySet<SceneRole> = new Set(['mission', 'review']);

/** Which scenes go first: a lower number is dropped earlier. Scenes with the same number go last to first. */
const DROP_ORDER: Record<SceneRole, number> = {
  conclusion: 0,
  'big-picture': 1,
  'under-the-hood': 2,
  'before-after': 2,
  mission: 3,
  review: 3,
};

export interface EstimateOptions {
  /** Narration language, which decides how identifiers are spoken. */
  language: string;
  /** Whether e-mail addresses are masked, as they are in narration and captions. */
  maskEmails: boolean;
}

export interface FitOptions extends EstimateOptions {
  /** The limit in seconds. */
  maxSec: number;
  /** Ids of the changed files, hunks and symbols. A simulated scene keeps a line that cites one of them. */
  backingEvidence: ReadonlySet<string>;
}

export interface FitResult {
  /** The storyboard to use: the one that was given when it already fits, else a trimmed copy. */
  storyboard: Storyboard;
  /** Estimated length before and after trimming, in seconds. */
  beforeSec: number;
  afterSec: number;
  droppedScenes: { id: string; title: string; role: SceneRole }[];
  /** Lines that were dropped from scenes that stayed. */
  droppedLines: number;
  /** false when only the scenes that are never dropped are left and they are still too long. */
  fits: boolean;
}

/** Estimated length of the finished video, in seconds, including the title and the end card. */
export function estimateVideoSeconds(storyboard: Storyboard, options: EstimateOptions): number {
  return buildTimeline(storyboard, estimateNarration(storyboard, options)).durationSec;
}

/** Whether the last line of a scene can go. A simulated scene must stay backed by a changed file, hunk or symbol. */
function canDropLastLine(scene: Scene, backing: ReadonlySet<string>): boolean {
  if (scene.narration.length < 2) return false;
  if (!isSimulated(scene.visual)) return true;
  return scene.narration.slice(0, -1).some((line) => line.evidence.some((id) => backing.has(id)));
}

/** Drop the last line. Elements that appeared on it appear on the new last line instead. */
function dropLastLine(scene: Scene): void {
  scene.narration.pop();
  const last = scene.narration.length - 1;
  for (const holder of beatHolders(scene.visual)) {
    if (holder.beat > last) holder.beat = last;
  }
}

type Step = { kind: 'scene' | 'line'; index: number };

/** The next thing to leave out, or null when only what must stay is left. */
function nextStep(
  storyboard: Storyboard,
  excessSec: number,
  options: FitOptions,
  estimate: (candidate: Storyboard) => number,
  currentSec: number,
): Step | null {
  const { scenes } = storyboard;
  const canDropScene = scenes.length > STORYBOARD_LIMITS.minScenes;

  const optional = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => !PROTECTED_ROLES.has(scene.role))
    .sort((a, b) => DROP_ORDER[a.scene.role] - DROP_ORDER[b.scene.role] || b.index - a.index);

  for (const { scene, index } of optional) {
    if (canDropLastLine(scene, options.backingEvidence)) {
      // Dropping lines is gentler than dropping the scene, so it is used whenever it is enough.
      const trial = structuredClone(storyboard);
      const trialScene = trial.scenes[index] as Scene;
      while (canDropLastLine(trialScene, options.backingEvidence)) dropLastLine(trialScene);
      if (!canDropScene || currentSec - estimate(trial) >= excessSec) return { kind: 'line', index };
    }
    if (canDropScene) return { kind: 'scene', index };
  }

  // Only the scenes that stay are left: shorten the one with the most lines, the later one on a tie.
  const longest = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => canDropLastLine(scene, options.backingEvidence))
    .sort((a, b) => b.scene.narration.length - a.scene.narration.length || b.index - a.index)[0];
  return longest ? { kind: 'line', index: longest.index } : null;
}

/**
 * Trim a storyboard until its estimated length is at most `options.maxSec`, or until only the
 * scenes that must stay are left. The given storyboard is never changed.
 */
export function fitToMaxDuration(storyboard: Storyboard, options: FitOptions): FitResult {
  const estimate = (candidate: Storyboard): number => estimateVideoSeconds(candidate, options);
  const beforeSec = estimate(storyboard);
  if (beforeSec <= options.maxSec) {
    return { storyboard, beforeSec, afterSec: beforeSec, droppedScenes: [], droppedLines: 0, fits: true };
  }

  const work = structuredClone(storyboard);
  // A length hint can only stretch a scene, so it is the first thing to give up.
  for (const scene of work.scenes) scene.targetSeconds = null;
  let seconds = estimate(work);
  const droppedScenes: FitResult['droppedScenes'] = [];
  while (seconds > options.maxSec) {
    const step = nextStep(work, seconds - options.maxSec, options, estimate, seconds);
    if (!step) break;
    if (step.kind === 'scene') {
      const [scene] = work.scenes.splice(step.index, 1) as [Scene];
      droppedScenes.push({ id: scene.id, title: scene.title, role: scene.role });
    } else {
      dropLastLine(work.scenes[step.index] as Scene);
    }
    seconds = estimate(work);
  }
  // Lines that went with a scene that was dropped later are not counted twice.
  const linesBefore = new Map(storyboard.scenes.map((scene) => [scene.id, scene.narration.length]));
  const droppedLines = work.scenes.reduce(
    (sum, scene) => sum + ((linesBefore.get(scene.id) ?? scene.narration.length) - scene.narration.length),
    0,
  );
  return {
    storyboard: work,
    beforeSec,
    afterSec: seconds,
    droppedScenes,
    droppedLines,
    fits: seconds <= options.maxSec,
  };
}

/**
 * What to tell the person about a trim. Nothing when the storyboard already fit. `would` is for
 * `validate`, which only checks: it says what rendering would drop.
 */
export function describeFit(
  result: FitResult,
  maxSec: number,
  mode: 'trimmed' | 'would' = 'trimmed',
): string[] {
  if (result.beforeSec <= maxSec) return [];
  const sec = (value: number): string => `${Math.round(value)} s`;
  const dropped: string[] = [];
  if (result.droppedScenes.length > 0) {
    dropped.push(
      `${result.droppedScenes.length === 1 ? 'the scene' : 'the scenes'} ${naturalList(result.droppedScenes.map((s) => `"${s.title}"`))}`,
    );
  }
  if (result.droppedLines > 0) dropped.push(plural(result.droppedLines, 'narration line'));

  let message = `The storyboard is estimated at ${sec(result.beforeSec)}, over the maximum of ${sec(maxSec)} (--max-duration).`;
  if (dropped.length > 0) {
    message +=
      mode === 'trimmed'
        ? ` Left out to shorten it: ${dropped.join(', and ')}. It is now estimated at ${sec(result.afterSec)}.`
        : ` Rendering would leave out ${dropped.join(', and ')}, which brings it to ${sec(result.afterSec)}.`;
  }
  if (!result.fits) {
    message += ` The mission and review scenes are never dropped, so the maximum of ${sec(maxSec)} cannot be reached with this storyboard. Raise --max-duration, or write shorter narration.`;
  }
  return [message];
}
