/**
 * The pipeline: source -> analysis -> storyboard -> grounding -> narration -> visuals -> render
 * -> publish -> notify. This is the engine's main entry point; the CLI, the HTTP API, the job
 * runner and library users all call these functions.
 */
export { checkStoryboard, prepareAuthoring } from './authoring.ts';
export { publishRun } from './publish-run.ts';
export { generate } from './run.ts';
export type {
  AuthoringOptions,
  AuthoringResult,
  ContextOptions,
  GenerateHooks,
  GenerateOptions,
  PublishRunOptions,
} from './types.ts';
