import { describe, expect, test } from 'bun:test';
import { buildDetachedSupervisorArgs } from '../src/core/minions/detached-stderr.ts';
import {
  hasLifecycleStdinDetachConflict,
  parseLifecycleStdinFlag,
} from '../src/core/minions/supervisor.ts';

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

describe('parseLifecycleStdinFlag', () => {
  test('is opt-in and recognizes the exact foreground flag', () => {
    expect(parseLifecycleStdinFlag(['jobs', 'supervisor', 'start'])).toBe(false);
    expect(parseLifecycleStdinFlag(['jobs', 'supervisor', 'start', '--lifecycle-stdin'])).toBe(true);
  });
});

describe('lifecycle stdin / detach validation', () => {
  test('rejects the conflict before detached spawn can be selected', () => {
    expect(hasLifecycleStdinDetachConflict([
      'jobs', 'supervisor', 'start', '--lifecycle-stdin', '--detach',
    ])).toBe(true);
    expect(hasLifecycleStdinDetachConflict([
      'jobs', 'supervisor', 'start', '--lifecycle-stdin',
    ])).toBe(false);
    expect(hasLifecycleStdinDetachConflict([
      'jobs', 'supervisor', 'start', '--detach',
    ])).toBe(false);
  });
});
