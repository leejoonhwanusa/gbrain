import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { collectSyncableFiles } from '../src/commands/import.ts';
import {
  loadGbrainIgnoreGlobs,
  matchesGbrainIgnorePath,
  unsyncableReason,
} from '../src/core/sync.ts';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ignore-'));
  execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'GBrain Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'gbrain-test@example.invalid'], { stdio: 'ignore' });
  return dir;
}

describe('.gbrainignore sync boundary', () => {
  test('collectSyncableFiles excludes tracked generated/data files while keeping source logic', () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'data', 'images'), { recursive: true });
      mkdirSync(join(dir, 'fixtures'), { recursive: true });
      writeFileSync(join(dir, '.gbrainignore'), [
        '# high-noise GBrain exclusions',
        '*_manifest.json',
        '**/images/**',
        'fixtures/',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'src', 'train.ts'), 'export const ok = true;\n');
      writeFileSync(join(dir, 'training_eligible_manifest.json'), '{"large":true}\n');
      writeFileSync(join(dir, 'data', 'images', 'sample.json'), '{"not":"logic"}\n');
      writeFileSync(join(dir, 'fixtures', 'golden.json'), '{"fixture":true}\n');
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });

      const rels = collectSyncableFiles(dir, { strategy: 'code' })
        .map((abs) => relative(dir, abs).replace(/\\/g, '/'));

      expect(rels).toContain('src/train.ts');
      expect(rels).not.toContain('training_eligible_manifest.json');
      expect(rels).not.toContain('data/images/sample.json');
      expect(rels).not.toContain('fixtures/golden.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('incremental classifier reports .gbrainignore hits as exclude-glob-hit', () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, '.gbrainignore'), '*_manifest.json\n');
      const globs = loadGbrainIgnoreGlobs(dir);
      expect(matchesGbrainIgnorePath('training_eligible_manifest.json', globs)).toBe(true);
      expect(unsyncableReason('training_eligible_manifest.json', {
        strategy: 'code',
        exclude: globs,
      })).toBe('exclude-glob-hit');
      expect(unsyncableReason('src/train.ts', {
        strategy: 'code',
        exclude: globs,
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
