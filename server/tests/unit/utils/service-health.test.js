import { describe, expect, it } from 'vitest';
import { testExports } from '../../../src/utils/service-health.js';

const {
  parseSystemctlShow,
  parseJournalLine,
  classifyJournalLine,
  findRecentCrash,
} = testExports;

describe('service health parsing', () => {
  it('parses systemctl show key-value output', () => {
    expect(parseSystemctlShow('ActiveState=active\nNRestarts=4\nResult=success\n')).toEqual({
      ActiveState: 'active',
      NRestarts: '4',
      Result: 'success',
    });
  });

  it('parses short-iso journal lines', () => {
    expect(parseJournalLine('2026-05-29T12:30:00-0400 testerella node[123]: FATAL ERROR: Reached heap limit')).toEqual({
      timestamp: '2026-05-29T12:30:00-0400',
      message: 'node[123]: FATAL ERROR: Reached heap limit',
    });
  });

  it('classifies Node heap OOM lines', () => {
    const line = '2026-05-29T12:30:00-0400 testerella node[123]: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
    expect(classifyJournalLine(line)).toMatchObject({
      type: 'oom',
      timestamp: '2026-05-29T12:30:00-0400',
    });
  });

  it('prefers the useful crash reason over the follow-on systemd exit line', () => {
    const output = [
      '2026-05-29T12:29:58-0400 testerella node[123]: ordinary startup line',
      '2026-05-29T12:30:00-0400 testerella node[123]: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      '2026-05-29T12:31:00-0400 testerella systemd[1]: cidrella.service: Main process exited, code=killed, status=6/ABRT',
    ].join('\n');

    expect(findRecentCrash(output)).toMatchObject({
      type: 'oom',
      timestamp: '2026-05-29T12:30:00-0400',
    });
  });
});
