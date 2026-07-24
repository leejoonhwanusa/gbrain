import { describe, expect, test } from 'bun:test';
import { buildSupervisorDetachInvocation } from '../src/commands/jobs.ts';

describe('buildSupervisorDetachInvocation', () => {
  test('compiled Bun executable omits the virtual embedded entrypoint', () => {
    expect(buildSupervisorDetachInvocation(
      'C:\\gbrain\\bin\\gbrain.exe',
      [
        'C:\\gbrain\\bin\\gbrain.exe',
        'B:/~BUN/root/gbrain',
        'jobs',
        'supervisor',
        'start',
        '--detach',
        '--json',
      ],
    )).toEqual({
      command: 'C:\\gbrain\\bin\\gbrain.exe',
      args: ['jobs', 'supervisor', 'start', '--json'],
    });
  });

  test('source execution preserves the TypeScript entrypoint', () => {
    expect(buildSupervisorDetachInvocation(
      'C:\\Users\\operator\\.bun\\bin\\bun.exe',
      [
        'C:\\Users\\operator\\.bun\\bin\\bun.exe',
        'C:\\gbrain\\src\\cli.ts',
        'jobs',
        'supervisor',
        '--detach',
      ],
    )).toEqual({
      command: 'C:\\Users\\operator\\.bun\\bin\\bun.exe',
      args: ['C:\\gbrain\\src\\cli.ts', 'jobs', 'supervisor'],
    });
  });
});
