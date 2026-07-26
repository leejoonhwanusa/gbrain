import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const TEST_ROOT = join(tmpdir(), `gbrain-schema-compiled-${process.pid}`);
const BIN_PATH = join(TEST_ROOT, process.platform === 'win32' ? 'gbrain.exe' : 'gbrain');
const HOME_PATH = join(TEST_ROOT, 'home');

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('compiled schema-pack assets', () => {
  test('compiled CLI resolves the configured gbrain-base-v2 manifest', () => {
    mkdirSync(join(HOME_PATH, '.gbrain'), { recursive: true });
    writeFileSync(
      join(HOME_PATH, '.gbrain', 'config.json'),
      JSON.stringify({ schema_pack: 'gbrain-base-v2' }),
      'utf-8',
    );

    const build = spawnSync(
      'bun',
      ['build', '--compile', '--outfile', BIN_PATH, 'src/cli.ts'],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    expect(build.status).toBe(0);

    const run = spawnSync(BIN_PATH, ['schema', 'active'], {
      cwd: TEST_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, GBRAIN_HOME: HOME_PATH },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Active pack: gbrain-base-v2');
  }, 30_000);
});
