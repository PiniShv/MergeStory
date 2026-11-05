/**
 * Narration: speech synthesis behind the TtsProvider interface, audio assembly and captions.
 *
 * - selectTtsProvider picks the voice (free local providers only unless one is chosen) and
 *   installs the free Kokoro voice on first use.
 * - synthesizeNarration turns every narration line into a cached, loudness-matched clip.
 * - assembleNarrationTrack places the clips on the timeline (and mixes optional music).
 * - buildCaptionCues, toWebVtt and toSrt produce captions from the same timeline.
 */
export { assembleNarrationTrack } from './assemble.ts';
export { buildCaptionCues, captionText, toSrt, toWebVtt } from './captions.ts';
export { createElevenLabsProvider } from './elevenlabs.ts';
export { createKokoroProvider } from './kokoro.ts';
export { kokoroInstallNote, setupKokoro } from './kokoro-install.ts';
export { installKokoro, kokoroStatus, type LocalVoiceStatus } from './kokoro-plugin.ts';
export { createOpenAiProvider } from './openai.ts';
export { createSayProvider } from './say.ts';
export { selectTtsProvider } from './select.ts';
export { createSilentProvider } from './silent.ts';
export { toSpokenText, toSpokenTextFor } from './speakable.ts';
export { estimateNarration, estimateNarrationCost, synthesizeNarration } from './synthesize.ts';
