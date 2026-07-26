import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMigration } from '../src/commands/migrations/index.ts';
import { withEnv } from './helpers/with-env.ts';

describe('migration orchestrator dry-run ledger isolation', () => {
  for (const version of ['0.16.0', '0.18.0']) {
    test(`${version} dry-run does not append completed.jsonl`, async () => {
      const home = mkdtempSync(join(tmpdir(), `gbrain-${version}-dry-run-`));
      try {
        await withEnv({ GBRAIN_HOME: home }, async () => {
          const migration = getMigration(version);
          expect(migration).not.toBeNull();
          const result = await migration!.orchestrator({
            dryRun: true,
            yes: true,
            noAutopilotInstall: true,
          });
          expect(result.phases.every(phase => phase.status === 'skipped')).toBe(true);
          expect(existsSync(join(home, 'migrations', 'completed.jsonl'))).toBe(false);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
