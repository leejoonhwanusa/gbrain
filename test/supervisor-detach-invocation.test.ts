import { describe, expect, test } from 'bun:test';
import { buildDetachedSupervisorArgs } from '../src/core/minions/detached-stderr.ts';

describe('buildDetachedSupervisorArgs', () => {
  test('compiled Bun executable omits the virtual embedded entrypoint', () => {
    expect(buildDetachedSupervisorArgs(
      'B:/~BUN/root/gbrain',
      ['jobs', 'supervisor', 'start', '--json'],
    )).toEqual(['jobs', 'supervisor', 'start', '--json']);
  });

  test('source execution preserves the TypeScript entrypoint', () => {
    expect(buildDetachedSupervisorArgs(
      'C:\\gbrain\\src\\cli.ts',
      ['jobs', 'supervisor'],
    )).toEqual(['C:\\gbrain\\src\\cli.ts', 'jobs', 'supervisor']);
  });
});
