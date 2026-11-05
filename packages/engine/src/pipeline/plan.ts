/** The dry-run plan: what a real run would do, spend and send, without doing any of it. */
import { describeProblem, type MergeStoryError } from '../core/errors.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { PlanResult, UsageRecord } from '../core/types.ts';
import { estimateNarrationCost, kokoroInstallNote, selectTtsProvider } from '../narration/index.ts';
import { estimateVideoSeconds } from './fit-duration.ts';
import { planEgress } from './planned-egress.ts';
import type { Prepared } from './prepare.ts';
import type { StoryboardChoice } from './storyboard-choice.ts';

/** Rough size of a finished video, per second of it, for the plan of what an upload would send. */
const ESTIMATED_VIDEO_BYTES_PER_SEC = 120_000;

/** The plan for a run that has chosen its storyboard. `warnings` are the ones found so far. */
export async function planResult(
  p: Prepared,
  choice: StoryboardChoice,
  storyboard: Storyboard,
  warnings: string[],
  publishProblem: MergeStoryError | null,
): Promise<PlanResult> {
  const { ctx } = p;
  const tts = await selectTtsProvider(ctx);
  const speech = estimateNarrationCost(storyboard, tts, ctx);
  const estimatedDurationSec = Math.round(
    estimateVideoSeconds(storyboard, {
      language: p.config.language,
      maskEmails: p.config.privacy.maskEmails,
    }),
  );
  const planned = choice.source === 'llm' ? choice.plannedLlm : null;
  const records: UsageRecord[] = [];
  if (choice.source === 'llm' && planned) {
    records.push({
      provider: choice.provider.id,
      kind: 'llm',
      model: choice.provider.model,
      inputTokens: planned.inputTokens,
      outputTokens: planned.outputTokens,
      costUsd: planned.costUsd ?? 0,
      estimated: true,
    });
  }
  records.push({
    provider: tts.id,
    kind: 'tts',
    model: tts.model(ctx),
    characters: speech.characters,
    costUsd: speech.costUsd,
    estimated: true,
  });
  const totalUsd = records.reduce((s, r) => s + r.costUsd, 0);
  const notes = [...warnings];
  // A dry run never installs: it says what the first real run downloads.
  const install = tts.id === 'kokoro' ? await kokoroInstallNote(ctx) : null;
  if (install) notes.push(install);
  if (publishProblem) {
    notes.push(
      `Publishing would fail: ${describeProblem(publishProblem)} A real run stops before it spends anything.`,
    );
  }
  if (totalUsd > p.config.budgetUsd) {
    notes.push(
      `Estimated cost $${totalUsd.toFixed(4)} is above the budget of $${p.config.budgetUsd.toFixed(2)}.`,
    );
  }
  const egress = await planEgress({
    ctx,
    changeSet: p.changeSet,
    llm:
      choice.source === 'llm' && planned
        ? { host: choice.provider.endpointHost, promptBytes: planned.promptBytes }
        : null,
    tts,
    narrationChars: speech.characters,
    estimatedVideoBytes: estimatedDurationSec * ESTIMATED_VIDEO_BYTES_PER_SEC,
    publishBlocked: publishProblem !== null,
  });
  notes.push(...egress.warnings);
  return {
    ok: true,
    dryRun: true,
    runId: ctx.runId,
    runDir: ctx.runDir,
    title: storyboard.title,
    storyboardSource: choice.source,
    estimatedDurationSec,
    scenes: storyboard.scenes.map((s) => ({ id: s.id, role: s.role, title: s.title, visual: s.visual.type })),
    providers: {
      llm:
        choice.source === 'llm'
          ? `${choice.provider.id}:${choice.provider.model}`
          : choice.source === 'agent'
            ? 'agent-supplied'
            : 'none (offline)',
      tts: tts.id,
      publish: p.config.publish.provider,
    },
    estimatedCost: { totalUsd: Math.round(totalUsd * 1e6) / 1e6, budgetUsd: p.config.budgetUsd, records },
    plannedEgress: egress.egress,
    warnings: notes,
  };
}
