/**
 * v0.32.7 CJK wave — `gbrain reindex --markdown` sweep.
 *
 * Walks markdown pages whose `chunker_version` is below
 * MARKDOWN_CHUNKER_VERSION and re-imports each through the standard
 * `importFromFile` / `importFromContent` path. Bumps `chunker_version` on
 * success so re-runs are idempotent and a partial sweep can resume.
 *
 * Driven by:
 *   - `gbrain upgrade` post-upgrade hook (after the cost-estimate prompt).
 *   - Operators running `gbrain reindex --markdown` directly.
 *
 * Performance: batched 100 at a time so a 50K-page brain reindex doesn't
 * hold a single transaction open. `--limit` caps total work for triage
 * runs; `--dry-run` reports the count without writing.
 *
 * Codex outside-voice C2 — the original PR #599 `MARKDOWN_CHUNKER_VERSION`
 * fold into content_hash was a no-op because `performSync` only re-imports
 * files whose content actually changed, not files whose hash WOULD change
 * if recomputed. This sweep + the migration v54 column are how the bump
 * actually reaches existing markdown pages.
 */

import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../core/chunkers/recursive.ts';
import { importFromContent, importFromFile } from '../core/import-file.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { existsSync } from 'fs';
import { resolve } from 'path';
// v0.41.15.0 (T10, D9): per-batch parallel workers.
import { runSlidingPool } from '../core/worker-pool.ts';
import { resolveWorkersWithClamp } from '../core/sync-concurrency.ts';
import { inspectContextualRetrievalState } from '../core/contextual-retrieval-drift.ts';

interface ReindexOpts {
  /** Cap total pages reindexed. Useful for triage runs on huge brains. */
  limit?: number;
  /** Report would-do count; don't actually reindex. */
  dryRun?: boolean;
  /** Emit JSON envelope on stdout. */
  json?: boolean;
  /** Brain repo path (for reading source files). Falls back to sync.repo_path config or process.cwd(). */
  repoPath?: string;
  /**
   * Skip the embedding call during re-chunk. New chunks land with NULL
   * embedding and the next `gbrain embed --stale` pass fills them in.
   * Useful for offline / no-API-key brains and for tests.
   */
  noEmbed?: boolean;
  /**
   * v0.41.15.0 (T10, D9): in-process per-batch parallel workers.
   * Default 1. PGLite clamps to 1. Recommended 4-8 for large brains.
   * Each worker calls importFromFile / importFromContent independently;
   * the counters (reindexed/skipped/failed) are JS-single-thread atomic.
   */
  workers?: number;
}

export interface ReindexResult {
  pending: number;
  reindexed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  chunkerVersion: number;
}

function parseArgs(args: string[]): ReindexOpts {
  const out: ReindexOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--markdown') continue; // routing flag, no value
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-embed') out.noEmbed = true;
    else if (a === '--limit') {
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v > 0) out.limit = v;
    } else if (a === '--repo') {
      out.repoPath = args[++i];
    } else if (a === '--workers' || a === '--concurrency') {
      // v0.41.15.0 (T10, D9): per-batch parallel workers.
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 1) out.workers = v;
    }
  }
  return out;
}

export async function runReindex(engine: BrainEngine, args: string[]): Promise<ReindexResult> {
  const opts = parseArgs(args);

  // Require `--markdown` explicitly. Future modes (e.g. --code) get their
  // own routing here.
  if (!args.includes('--markdown')) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: 'gbrain reindex requires a target flag, e.g. --markdown' }) + '\n');
    } else {
      process.stderr.write('Usage: gbrain reindex --markdown [--limit N] [--dry-run] [--json] [--repo PATH]\n');
    }
    setCliExitVerdict(2);
    return { pending: 0, reindexed: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  const inspection = await inspectContextualRetrievalState(engine);
  const pendingRows = inspection.driftedPages;
  const pending = pendingRows.length;

  if (opts.json && pending === 0) {
    process.stdout.write(JSON.stringify({ pending: 0, reindexed: 0, skipped: 0, failed: 0, chunker_version: MARKDOWN_CHUNKER_VERSION }) + '\n');
    return { pending: 0, reindexed: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  if (pending === 0) {
    process.stderr.write(
      `[reindex] All markdown pages aligned to chunker_version ` +
      `${MARKDOWN_CHUNKER_VERSION}, search.mode=${inspection.activeSearchMode}, ` +
      `CR mode=${inspection.globalMode}, and corpus generation. Nothing to do.\n`,
    );
    return { pending: 0, reindexed: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  const target = typeof opts.limit === 'number' ? Math.min(opts.limit, pending) : pending;

  if (opts.dryRun) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ pending, would_reindex: target, dry_run: true, chunker_version: MARKDOWN_CHUNKER_VERSION }) + '\n');
    } else {
      process.stderr.write(`[reindex] DRY-RUN: would re-chunk ${target} of ${pending} pending markdown pages.\n`);
    }
    return { pending, reindexed: 0, skipped: 0, failed: 0, dryRun: true, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('reindex.markdown', target);

  let reindexed = 0;
  let skipped = 0;
  let failed = 0;
  const BATCH = 100;
  const repoPath = opts.repoPath ? resolve(opts.repoPath) : null;
  let nextPendingIndex = 0;

  while (reindexed + skipped + failed < target) {
    const remaining = target - (reindexed + skipped + failed);
    const batchSize = Math.min(BATCH, remaining);
    const batch = pendingRows.slice(nextPendingIndex, nextPendingIndex + batchSize);
    nextPendingIndex += batch.length;
    if (batch.length === 0) break;

    // v0.41.15.0 (T10, D9): per-batch sliding pool. Counters are JS-
    // single-thread atomic so reindexed++ / failed++ are race-free
    // across workers.
    const writersResolved = resolveWorkersWithClamp(
      engine,
      opts.workers,
      'reindex',
      batch.length,
    );
    await runSlidingPool({
      items: batch,
      workers: writersResolved.workers,
      failureLabel: (row) => row.slug,
      onItem: async (row) => {
        reporter.tick();
        try {
          if (row.sourcePath && repoPath) {
            const absPath = resolve(repoPath, row.sourcePath);
            if (existsSync(absPath)) {
              await importFromFile(engine, absPath, row.sourcePath, {
                noEmbed: !!opts.noEmbed,
                sourceId: row.sourceId,
                inferFrontmatter: false,
                forceRechunk: true,
              });
              reindexed++;
              return;
            }
          }
          // No source file on disk (DB-only page, or repo not available) —
          // re-chunk from the stored page. v0.41.37.0 #1621: reconstruct the
          // FULL markdown (frontmatter + body + timeline) via serializeMarkdown
          // and re-import THAT, instead of passing body-only `compiled_truth`
          // to importFromContent. The body-only path re-parsed with empty
          // frontmatter and OVERWROTE the page's real frontmatter / title /
          // timeline (codex catch). The round-trip preserves everything while
          // still re-chunking + bumping chunker_version.
          const page = await engine.getPage(row.slug, { sourceId: row.sourceId });
          if (!page) { skipped++; return; }
          const tags = await engine.getTags(row.slug, { sourceId: row.sourceId });
          const fullMarkdown = serializeMarkdown(
            page.frontmatter ?? {},
            page.compiled_truth ?? '',
            page.timeline ?? '',
            { type: page.type, title: page.title, tags },
          );
          await importFromContent(engine, row.slug, fullMarkdown, {
            sourceId: row.sourceId,
            noEmbed: !!opts.noEmbed,
            forceRechunk: true,
          });
          reindexed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[reindex] ${row.slug}: ${msg}\n`);
          failed++;
        }
      },
    });
  }

  reporter.finish();

  const result: ReindexResult = {
    pending,
    reindexed,
    skipped,
    failed,
    dryRun: false,
    chunkerVersion: MARKDOWN_CHUNKER_VERSION,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      pending, reindexed, skipped, failed,
      chunker_version: MARKDOWN_CHUNKER_VERSION,
    }) + '\n');
  } else {
    process.stderr.write(`[reindex] Done. reindexed=${reindexed} failed=${failed} pending=${Math.max(0, pending - reindexed - failed)}\n`);
  }

  return result;
}
