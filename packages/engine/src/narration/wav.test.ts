import { describe, expect, it } from 'vitest';
import {
  CANONICAL_RATE,
  decodeWavToMono,
  encodeWavPcm16,
  parseWavHeader,
  pcmS16leToFloat,
  readCanonicalWav,
  wavDurationSec,
} from './wav.ts';

/** Build a WAV by hand so the tests do not depend on the writer under test. */
function rawWav(options: {
  tag: number;
  channels: number;
  rate: number;
  bits: number;
  data: Buffer;
  extraChunk?: boolean;
  dataSize?: number;
}): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(options.tag, 0);
  fmt.writeUInt16LE(options.channels, 2);
  fmt.writeUInt32LE(options.rate, 4);
  fmt.writeUInt32LE((options.rate * options.channels * options.bits) / 8, 8);
  fmt.writeUInt16LE((options.channels * options.bits) / 8, 12);
  fmt.writeUInt16LE(options.bits, 14);
  const chunks: Buffer[] = [];
  if (options.extraChunk) {
    const junk = Buffer.alloc(8 + 5 + 1);
    junk.write('JUNK', 0, 'ascii');
    junk.writeUInt32LE(5, 4);
    chunks.push(junk); // odd size plus one pad byte
  }
  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write('fmt ', 0, 'ascii');
  fmtHeader.writeUInt32LE(16, 4);
  chunks.push(fmtHeader, fmt);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(options.dataSize ?? options.data.length, 4);
  chunks.push(dataHeader, options.data);
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, body]);
}

describe('encodeWavPcm16', () => {
  it('writes a 44-byte canonical header', () => {
    const wav = encodeWavPcm16(Int16Array.from([0, 1000, -1000, 32767]), CANONICAL_RATE);
    expect(wav.length).toBe(44 + 8);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt32LE(28)).toBe(96_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(8);
  });

  it('round-trips through readCanonicalWav', () => {
    const samples = Int16Array.from({ length: 1000 }, (_, i) => Math.round(Math.sin(i / 7) * 20000));
    const back = readCanonicalWav(encodeWavPcm16(samples, CANONICAL_RATE));
    expect(Array.from(back)).toEqual(Array.from(samples));
  });

  it('reports the duration from the header', () => {
    const wav = encodeWavPcm16(new Int16Array(24_000), CANONICAL_RATE);
    expect(wavDurationSec(wav)).toBeCloseTo(0.5, 6);
  });
});

describe('readCanonicalWav', () => {
  it('rejects other sample rates and channel counts', () => {
    expect(() => readCanonicalWav(encodeWavPcm16(new Int16Array(10), 24_000))).toThrow(/48 kHz/);
    expect(() => readCanonicalWav(encodeWavPcm16(new Int16Array(10), CANONICAL_RATE, 2))).toThrow(/mono/);
  });
});

describe('parseWavHeader', () => {
  it('rejects files that are not WAV', () => {
    expect(() => parseWavHeader(Buffer.from('not a wav file at all'))).toThrow(/RIFF/);
    expect(() => parseWavHeader(Buffer.alloc(4))).toThrow(/RIFF/);
  });

  it('skips unknown chunks, including odd-sized ones', () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(1234, 0);
    const wav = rawWav({ tag: 1, channels: 1, rate: 24_000, bits: 16, data, extraChunk: true });
    const info = parseWavHeader(wav);
    expect(info).toMatchObject({
      encoding: 'pcm',
      bitsPerSample: 16,
      channels: 1,
      sampleRate: 24_000,
      dataBytes: 8,
    });
    expect(wav.readInt16LE(info.dataOffset)).toBe(1234);
  });

  it('uses the real data length when a streamed file declares 0xFFFFFFFF', () => {
    const wav = rawWav({
      tag: 1,
      channels: 1,
      rate: 24_000,
      bits: 16,
      data: Buffer.alloc(100),
      dataSize: 0xffffffff,
    });
    expect(parseWavHeader(wav).dataBytes).toBe(100);
  });

  it('rejects compressed encodings', () => {
    const wav = rawWav({ tag: 2, channels: 1, rate: 24_000, bits: 4, data: Buffer.alloc(8) });
    expect(() => parseWavHeader(wav)).toThrow(/Unsupported/);
  });
});

describe('decodeWavToMono', () => {
  it('decodes 16-bit PCM', () => {
    const data = Buffer.alloc(4);
    data.writeInt16LE(16384, 0);
    data.writeInt16LE(-16384, 2);
    const { samples, sampleRate } = decodeWavToMono(
      rawWav({ tag: 1, channels: 1, rate: 22_050, bits: 16, data }),
    );
    expect(sampleRate).toBe(22_050);
    expect(Array.from(samples)).toEqual([0.5, -0.5]);
  });

  it('decodes 32-bit float written by neural voices', () => {
    const data = Buffer.alloc(8);
    data.writeFloatLE(0.25, 0);
    data.writeFloatLE(-0.75, 4);
    const { samples } = decodeWavToMono(rawWav({ tag: 3, channels: 1, rate: 24_000, bits: 32, data }));
    expect(Array.from(samples)).toEqual([0.25, -0.75]);
  });

  it('decodes 8-bit and 24-bit PCM', () => {
    const eight = decodeWavToMono(
      rawWav({ tag: 1, channels: 1, rate: 8000, bits: 8, data: Buffer.from([128, 255, 0]) }),
    );
    expect(eight.samples[0]).toBe(0);
    expect(eight.samples[1]).toBeCloseTo(127 / 128, 6);
    expect(eight.samples[2]).toBe(-1);
    const data = Buffer.alloc(3);
    data.writeIntLE(4194304, 0, 3);
    const twentyFour = decodeWavToMono(rawWav({ tag: 1, channels: 1, rate: 8000, bits: 24, data }));
    expect(twentyFour.samples[0]).toBeCloseTo(0.5, 6);
  });

  it('averages stereo channels', () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(8192, 0);
    data.writeInt16LE(-8192, 2);
    data.writeInt16LE(16384, 4);
    data.writeInt16LE(16384, 6);
    const { samples } = decodeWavToMono(rawWav({ tag: 1, channels: 2, rate: 48_000, bits: 16, data }));
    expect(Array.from(samples)).toEqual([0, 0.5]);
  });
});

describe('pcmS16leToFloat', () => {
  it('converts raw samples and ignores a trailing odd byte', () => {
    const bytes = Buffer.from([0x00, 0x40, 0x00, 0xc0, 0x7f]);
    expect(Array.from(pcmS16leToFloat(bytes))).toEqual([0.5, -0.5]);
  });
});
