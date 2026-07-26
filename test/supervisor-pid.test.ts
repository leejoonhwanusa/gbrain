/**
 * Unit tests for the shared supervisor PID-file reader (issue #1815, Q4).
 * One regression point now backs `jobs supervisor status`, `jobs stats`, and
 * `gbrain doctor`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { readSupervisorPid } from '../src/core/minions/supervisor-pid.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-suppid-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('readSupervisorPid', () => {
  test('default PID file uses the Windows profile when HOME is unset', () => {
    const env = { ...process.env, USERPROFILE: dir } as Record<string, string | undefined>;
    delete env.HOME;
    const output = execFileSync(
      'bun',
      ['-e', "import { DEFAULT_PID_FILE } from './src/core/minions/supervisor.ts'; console.log(DEFAULT_PID_FILE)"],
      { cwd: join(__dirname, '..'), env: env as Record<string, string>, encoding: 'utf-8' },
    ).trim();

    expect(output.replaceAll('\\', '/')).toStartWith(dir.replaceAll('\\', '/') + '/.gbrain/supervisor-');
  });

  test('present + alive → running', () => {
    const f = join(dir, 'sup.pid');
    writeFileSync(f, `${process.pid}\n`);
    const r = readSupervisorPid(f);
    expect(r.pid).toBe(process.pid);
    expect(r.running).toBe(true);
  });

  test('present + dead → pid set, not running', () => {
    const f = join(dir, 'sup.pid');
    writeFileSync(f, '2147483600\n');
    const r = readSupervisorPid(f);
    expect(r.pid).toBe(2147483600);
    expect(r.running).toBe(false);
  });

  test('missing file → null, not running', () => {
    const r = readSupervisorPid(join(dir, 'nope.pid'));
    expect(r.pid).toBeNull();
    expect(r.running).toBe(false);
  });

  test('corrupt content → null, not running', () => {
    const f = join(dir, 'sup.pid');
    writeFileSync(f, 'not-a-pid\n');
    const r = readSupervisorPid(f);
    expect(r.pid).toBeNull();
    expect(r.running).toBe(false);
  });
});
