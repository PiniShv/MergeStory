/** The names the package exports. Adding or removing one is a change to the public API, and shows up here. */
import { describe, expect, it } from 'vitest';
import * as library from '../src/index.ts';

describe('the library exports', () => {
  it('are the names listed here', () => {
    expect(Object.keys(library).sort()).toMatchInlineSnapshot(`
      [
        "ConfigSchema",
        "ENGINE_VERSION",
        "EXIT_CODES",
        "MergeStoryError",
        "QUALITY_PRESETS",
        "SECRET_ENV_VARS",
        "SIMULATED_VISUALS",
        "STORYBOARD_LIMITS",
        "STORYBOARD_VERSION",
        "Secrets",
        "StoryboardSchema",
        "USER_CONFIG_FILE",
        "analyze",
        "buildEvidencePack",
        "checkStoryboard",
        "configFromEnv",
        "createLogger",
        "createRunContext",
        "createSourceProvider",
        "detectSourceInput",
        "generate",
        "heuristicStoryboard",
        "isMergeStoryError",
        "loadSecrets",
        "mergeConfigInputs",
        "prepareAuthoring",
        "publishRun",
        "readConfigFile",
        "resolveConfig",
        "silentLogger",
        "startServer",
        "storyboardJsonSchema",
        "storyboardJsonSchemaForLlm",
        "toMergeStoryError",
        "validateStoryboard",
      ]
    `);
  });

  it('include the entry points that the documentation shows', () => {
    for (const name of ['generate', 'prepareAuthoring', 'checkStoryboard', 'publishRun', 'startServer']) {
      expect(typeof (library as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
