/**
 * Minimal WAV reading and writing. Every clip MergeStory stores is mono, 48 kHz, 16-bit PCM,
 * so writing is one fixed layout; reading is tolerant because speech engines differ in the
 * chunks they add and in the sample format they use.
 */

/** Sample rate of every stored clip and of the final narration track. */
export const CANONICAL_RATE = 48_000;

export interface WavInfo {
  /** "pcm" = integer samples, "float" = IEEE float samples. */
  encoding: 'pcm' | 'float';
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
  /** Where the sample data starts inside the file. */
  dataOffset: number;
  dataBytes: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Parse the header of a RIFF/WAVE file. Throws a plain Error when the file is not a usable WAV. */
export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let fmt: { tag: number; channels: number; sampleRate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (declared < 16 || body + 16 > buf.length) throw new Error('Truncated WAV format chunk');
      let tag = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (tag === WAVE_FORMAT_EXTENSIBLE && declared >= 26 && body + 26 <= buf.length) {
        tag = buf.readUInt16LE(body + 24);
      }
      fmt = { tag, channels, sampleRate, bits };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before format chunk');
      // Streamed files may declare 0 or 0xFFFFFFFF; use what is actually there.
      const available = buf.length - body;
      const dataBytes =
        declared === 0 || declared === 0xffffffff || declared > available ? available : declared;
      const encoding = fmt.tag === WAVE_FORMAT_FLOAT ? 'float' : fmt.tag === WAVE_FORMAT_PCM ? 'pcm' : null;
      if (!encoding) throw new Error(`Unsupported WAV encoding ${fmt.tag}`);
      const validBits = encoding === 'float' ? [32, 64] : [8, 16, 24, 32];
      if (!validBits.includes(fmt.bits)) throw new Error(`Unsupported WAV sample size ${fmt.bits}`);
      if (fmt.channels < 1 || fmt.sampleRate < 1) throw new Error('Invalid WAV format chunk');
      return {
        encoding,
        bitsPerSample: fmt.bits,
        channels: fmt.channels,
        sampleRate: fmt.sampleRate,
        dataOffset: body,
        dataBytes,
      };
    }
    offset = body + declared + (declared % 2);
  }
  throw new Error('WAV file has no audio data');
}

/** Encode samples as a 16-bit PCM WAV file. */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  return out;
}

/** Encode mono samples as a 32-bit float WAV (lossless for neural voices that produce floats). */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 4;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(WAVE_FORMAT_FLOAT, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(32, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeFloatLE(samples[i] ?? 0, 44 + i * 4);
  return out;
}

/** Little-endian 16-bit PCM bytes for the given samples. */
export function int16ToPcmS16le(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i] ?? 0, i * 2);
  return out;
}

/** Convert little-endian 16-bit PCM bytes to floats in [-1, 1). A trailing odd byte is ignored. */
export function pcmS16leToFloat(bytes: Buffer): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}

export interface MonoAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** Decode any PCM or float WAV to mono floats at its own sample rate (channels are averaged). */
export function decodeWavToMono(buf: Buffer): MonoAudio {
  const info = parseWavHeader(buf);
  const bytesPerSample = info.bitsPerSample / 8;
  const frameBytes = bytesPerSample * info.channels;
  const frames = Math.floor(info.dataBytes / frameBytes);
  const out = new Float32Array(frames);
  const read = sampleReader(info);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = info.dataOffset + f * frameBytes;
    for (let c = 0; c < info.channels; c++) sum += read(buf, base + c * bytesPerSample);
    out[f] = sum / info.channels;
  }
  return { samples: out, sampleRate: info.sampleRate };
}

function sampleReader(info: WavInfo): (buf: Buffer, at: number) => number {
  if (info.encoding === 'float') {
    return info.bitsPerSample === 32 ? (b, at) => b.readFloatLE(at) : (b, at) => b.readDoubleLE(at);
  }
  switch (info.bitsPerSample) {
    case 8:
      return (b, at) => ((b[at] ?? 128) - 128) / 128;
    case 16:
      return (b, at) => b.readInt16LE(at) / 32768;
    case 24:
      return (b, at) => b.readIntLE(at, 3) / 8388608;
    default:
      return (b, at) => b.readInt32LE(at) / 2147483648;
  }
}

/** Read a clip written by this module: mono, 48 kHz, 16-bit PCM. Throws for any other layout. */
export function readCanonicalWav(buf: Buffer): Int16Array {
  const info = parseWavHeader(buf);
  if (
    info.encoding !== 'pcm' ||
    info.bitsPerSample !== 16 ||
    info.channels !== 1 ||
    info.sampleRate !== CANONICAL_RATE
  ) {
    throw new Error('Clip is not mono 48 kHz 16-bit PCM');
  }
  const count = Math.floor(info.dataBytes / 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(info.dataOffset + i * 2);
  return out;
}

/** Duration in seconds of a WAV file, from its header. */
export function wavDurationSec(buf: Buffer): number {
  const info = parseWavHeader(buf);
  return info.dataBytes / (info.channels * (info.bitsPerSample / 8)) / info.sampleRate;
}
