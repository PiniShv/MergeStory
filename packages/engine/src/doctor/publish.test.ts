import { describe, expect, it } from 'vitest';
import { byId, doctor } from '../testing/doctor.ts';

describe('publishing: local and none', () => {
  it('need nothing', async () => {
    expect(byId((await doctor({ publish: { provider: 'none' } })).checks, 'publish').status).toBe('pass');
    const local = await doctor({ publish: { provider: 'local', localDir: '/srv/videos' } });
    expect(byId(local.checks, 'publish').detail).toContain('/srv/videos');
    expect(local.checks.filter((c) => c.id.startsWith('publish'))).toHaveLength(1);
  });
});
