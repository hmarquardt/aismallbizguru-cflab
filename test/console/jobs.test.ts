import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron } from '../../src/console/jobs';

describe('cron reading for job observability', () => {
  it('computes the next UTC run for the schedules this deployment declares', () => {
    const from = new Date('2026-10-26T16:10:41.987Z');
    expect(nextCronRun('7 * * * *', from)).toBe('2026-10-26T17:07:00.000Z');
    expect(nextCronRun('41 6 * * *', from)).toBe('2026-10-27T06:41:00.000Z');
    expect(nextCronRun('17 * * * *', from)).toBe('2026-10-26T16:17:00.000Z');
    expect(nextCronRun('37 3 * * *', from)).toBe('2026-10-27T03:37:00.000Z');
  });

  it('returns null instead of guessing at an expression it does not support', () => {
    expect(parseCron('*/5 * * * *')).toMatchObject({ minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55] });
    expect(nextCronRun('*/15 * * * *', new Date('2026-10-26T16:02:00.000Z'))).toBe('2026-10-26T16:15:00.000Z');
    expect(nextCronRun('0 0 1 * *', new Date('2026-10-26T16:00:00.000Z'))).toBeNull();
    expect(nextCronRun('0 0 * * 1', new Date('2026-10-26T16:00:00.000Z'))).toBeNull();
    expect(nextCronRun('not a cron', new Date())).toBeNull();
    expect(nextCronRun('99 * * * *', new Date())).toBeNull();
  });

  it('never returns a time in the past for a matching schedule', () => {
    const from = new Date('2026-10-26T16:07:00.000Z');
    const next = nextCronRun('7 * * * *', from);
    expect(Date.parse(next!)).toBeGreaterThan(from.getTime());
  });
});
