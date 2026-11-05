import { describe, expect, it } from 'vitest';
import { byId, doctor } from '../testing/doctor.ts';

describe('MergeStory home', () => {
  it('fails when the home cannot be written', async () => {
    const report = await doctor({}, { isWritable: async () => false });
    expect(byId(report.checks, 'home')).toMatchObject({ status: 'fail' });
    expect(byId(report.checks, 'home').fix).toContain('MERGESTORY_HOME');
  });

  it('checks the nearest folder that exists when the home is not there yet', async () => {
    const asked: string[] = [];
    await doctor(
      {},
      {
        existingAncestor: async () => '/data',
        isWritable: async (path) => {
          asked.push(path);
          return true;
        },
        freeBytes: async (path) => {
          asked.push(path);
          return 10 * 1024 ** 3;
        },
      },
    );
    expect(asked).toEqual(['/data', '/data']);
  });

  it('warns under 2 GB free and passes at 2 GB', async () => {
    const low = await doctor({}, { freeBytes: async () => 1.5 * 1024 ** 3 });
    expect(byId(low.checks, 'disk')).toMatchObject({ status: 'warn' });
    expect(byId(low.checks, 'disk').detail).toContain('1.5 GB free');
    expect(low.ok).toBe(true);
    const enough = await doctor({}, { freeBytes: async () => 2 * 1024 ** 3 });
    expect(byId(enough.checks, 'disk').status).toBe('pass');
    const unknown = await doctor({}, { freeBytes: async () => null });
    expect(byId(unknown.checks, 'disk').status).toBe('pass');
  });
});
