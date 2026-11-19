/**
 * Storyboards: generation (LLM or heuristic) and the grounding validator that every
 * storyboard passes through, whoever wrote it.
 */
export { AUTHORING_VALUES, EXAMPLE_STORYBOARD, guideFor } from './authoring.ts';
export { estimateStoryboardCost, generateStoryboard } from './generate.ts';
export { heuristicStoryboard } from './heuristic.ts';
export { buildSystemPrompt, buildUserPrompt, sceneRange } from './prompts.ts';
export type {
  GenerateStoryboardInput,
  GenerateStoryboardOutput,
  IssueCode,
  ValidationDeps,
  ValidationIssue,
  ValidationResult,
} from './types.ts';
export { validateStoryboard } from './validate.ts';
