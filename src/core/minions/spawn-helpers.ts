/**
 * Pure helpers for spawning the gbrain worker, optionally wrapped in tini.
 *
 * Background: zombie children spawned by the worker (shell jobs, embed
 * batches, sub-agents) need a SIGCHLD handler to be reaped. The cli.ts
 * SIGCHLD handler covers JS-spawned children that exit while the parent is
 * alive; tini wraps the worker process tree to also reap native-addon
 * descendants and orphans. Together the two layers compose with AlphaClaw's
 * container-level tini-as-PID-1.
 *
 * `detectTini()` is called once at supervisor / autopilot startup. The
 * resolved path is reused on every respawn — we do NOT shell out per spawn.
 * `buildSpawnInvocation()` is a pure function describing the (cmd, args)
 * tuple to pass to `child_process.spawn`. Tests call it directly without
 * any module mocking.
 */

import { execFileSync } from 'child_process';
import type { SupervisorOpts } from './supervisor.ts';

/**
 * Resolve the tini binary path, or return an empty string when not on PATH.
 * Resolved once at startup so we don't shell out on every respawn.
 */
export function detectTini(): string {
  try {
    // Pass `env: process.env` explicitly: Bun's execFileSync does NOT
    // inherit the current process env by default (Bun snapshots env at
    // startup). Without this, runtime mutations to PATH (including in
    // tests) are invisible to `which`.
    return execFileSync('which', ['tini'], {
      encoding: 'utf8',
      timeout: 2000,
      env: process.env,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Build the (cmd, args) tuple for spawning the gbrain worker, optionally
 * wrapped in tini. When `tiniPath` is non-empty, returns
 *   { cmd: tiniPath, args: ['--', cliPath, ...args] }
 * which makes tini PID 1 of the spawned subtree. When empty, returns
 *   { cmd: cliPath, args }
 * for a direct spawn. Pure function, no side effects.
 */
export function buildSpawnInvocation(
  tiniPath: string,
  cliPath: string,
  args: string[],
): { cmd: string; args: string[] } {
  return tiniPath
    ? { cmd: tiniPath, args: ['--', cliPath, ...args] }
    : { cmd: cliPath, args };
}

/**
 * Build the argv the supervisor uses to spawn `gbrain jobs work`. Extracted from
 * runSuperviseLoop so it's unit-testable (issue #1815, Codex). Appends `--nice N`
 * when the operator requested a niceness, alongside the existing concurrency /
 * queue / max-rss flags. The spawned worker re-applies the niceness to itself;
 * niceness also inherits to the worker's own children automatically.
 */
export function buildWorkerArgs(
  opts: Pick<SupervisorOpts, 'concurrency' | 'queue' | 'maxRssMb' | 'nice_requested' | 'jobIsolation'> &
    Partial<Pick<SupervisorOpts, 'allowShellJobs'>>,
): string[] {
  const args = [
    'jobs', 'work',
    '--concurrency', String(opts.concurrency),
    '--queue', opts.queue,
  ];
  if (opts.maxRssMb > 0) {
    args.push('--max-rss', String(opts.maxRssMb));
  }
  if (opts.nice_requested !== undefined) {
    args.push('--nice', String(opts.nice_requested));
  }
  // Conditional push (issue #5): omitted for inline so existing deployments'
  // argv is byte-identical (pinned by supervisor-build-worker-args.test.ts).
  if (opts.jobIsolation === 'process') {
    args.push('--job-isolation', 'process');
  }
  // Conditional push: the shell opt-in travels as a flag as well as env. The
  // worker's startup cwd-.env quarantine (core/env-trust.ts) drops
  // GBRAIN_ALLOW_SHELL_JOBS whenever a .env in the worker's cwd assigns it,
  // so an env-only handoff could silently disable shell jobs; `jobs work`
  // re-asserts the env from this flag after its preflight.
  if (opts.allowShellJobs) {
    args.push('--allow-shell-jobs');
  }
  return args;
}
