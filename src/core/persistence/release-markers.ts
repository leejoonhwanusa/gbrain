/** Receipt-bound cleanup of one released root; never authorizes epoch-wide removal. */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { sha256 } from './digest.ts';
import { existingLocalHostId } from './identity.ts';
import { gitManagedMarker, type LocalMarkerReport } from './deactivation.ts';
import { acquireNativeLock } from './native-lock.ts';
import { containsPath, type WorktreeBinding } from './ownership.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, readPrivate } from './physical-root-record.ts';
import { canonicalFilesystemPath, managedRootRecordPath } from './root-registry.ts';
import { withTopologyLocks } from './topology-locks.ts';
import { OperationError } from '../ops/contract.ts';
import { topologyDirectoryIdentity } from './topology-filesystem.ts';

interface Marker { path: string; digest: string }
interface Released { brain_id: string; source_id: string; source_incarnation: string; worktree_id: string; root: string;
  coordination_path: string; owner_host_id: string; owner_epoch: string; topology_generation: string; marker_digests: Marker[];
  physical_identity: ReturnType<typeof topologyDirectoryIdentity> }
const hashRecord = (value: unknown) => sha256(JSON.stringify(value));

/** Registration and claims both veto cleanup of a shared root or Git marker. */
export async function assertNoReleaseRootSharing(engine: BrainEngine,
  row: { root: string; source_id: string; source_incarnation: string }, ownWorktree?: string): Promise<void> {
  const marker = gitManagedMarker(row.root);
  const git = marker ? canonicalFilesystemPath(marker) : null;
  const sources = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null }>('SELECT id,incarnation,local_path FROM sources');
  const hosts = await engine.executeRaw<{ worktree_id: string; local_path: string | null }>('SELECT worktree_id,local_path FROM persistence_host_bindings');
  const paths = [...sources.filter(source => source.id !== row.source_id || source.incarnation !== row.source_incarnation),
    ...hosts.filter(host => host.worktree_id !== ownWorktree)];
  for (const item of paths) if (item.local_path) {
    const root = canonicalFilesystemPath(item.local_path);
    if (containsPath(root, row.root) || containsPath(row.root, root)) throw new OperationError('source_changed', 'Another registered source overlaps this canonical root.');
    const other = gitManagedMarker(root);
    if (git && other && git === canonicalFilesystemPath(other)) throw new OperationError('source_changed', 'Another registered source shares this Git ownership marker.');
  }
}

export function captureReleaseMarkers(binding: WorktreeBinding & { brain_id: string; root: string }): Marker[] {
  const git = gitManagedMarker(binding.root);
  // The reservation is last: no new physical claim may start until every other old marker is removed.
  const paths = [...new Set([managedRootRecordPath(binding.brain_id, binding.root), join(binding.root, '.gbrain-managed'),
    ...(git ? [git] : []), join(binding.root, PHYSICAL_ROOT_MARKER), physicalRootReservationPath(binding.root)])];
  const markers: Marker[] = [];
  for (const path of paths) {
    const value = readPrivate(path) as Record<string, unknown> | null;
    if (value === null) continue;
    if ((value.brain_id ?? value.brainId) !== binding.brain_id
      || (value.worktree_id ?? value.worktreeId) !== undefined && (value.worktree_id ?? value.worktreeId) !== binding.worktree_id) {
      throw new OperationError('recovery_required', 'A marker belongs to another brain or worktree.');
    }
    markers.push({ path, digest: hashRecord(value) });
  }
  if (!markers.some(row => row.path === physicalRootReservationPath(binding.root))
    || !markers.some(row => row.path === join(binding.root, PHYSICAL_ROOT_MARKER))) {
    throw new OperationError('recovery_required', 'The physical claim markers are required before release.');
  }
  return markers;
}

export async function cleanupReleasedManagedMarkers(engine: BrainEngine, requestId?: string, locksHeld = false): Promise<LocalMarkerReport> {
  const report: LocalMarkerReport = { state: 'cleared', removed: [], pending: [] };
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  const rows = await engine.executeRaw<{ outcome: Released }>(
    "SELECT outcome FROM persistence_topology_changes WHERE operation='writer_release' AND state='committed' AND ($1::uuid IS NULL OR request_id=$1::uuid)", [requestId ?? null]);
  for (const { outcome: row } of rows) {
    if (!row || !brain || row.brain_id !== brain.brain_id || row.owner_host_id !== existingLocalHostId()) continue;
    const clean = async () => {
      const surviving = row.marker_digests.filter(marker => readPrivate(marker.path) !== null);
      if (!surviving.length) return;
      const physical = () => {
        const actual = topologyDirectoryIdentity(row.root), expected = row.physical_identity;
        if (!expected || ![expected.device, expected.inode, expected.birthNs].every(value => typeof value === 'string' && /^\d+$/.test(value))
          || actual.device !== expected.device || actual.inode !== expected.inode || actual.birthNs !== expected.birthNs) {
          throw new OperationError('recovery_required', 'The released physical checkout identity changed; its markers were retained.');
        }
      };
      physical();
      const [currentBrain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
      const [owner] = await engine.executeRaw<{ state: string; owner_epoch: string; topology_generation: string }>(
        'SELECT state,owner_epoch::text,topology_generation::text FROM persistence_worktrees WHERE id=$1::uuid', [row.worktree_id]);
      const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null }>('SELECT incarnation,local_path FROM sources WHERE id=$1', [row.source_id]);
      if (!currentBrain || currentBrain.brain_id !== row.brain_id || currentBrain.enabled
        || owner?.state !== 'retired' || owner.owner_epoch !== row.owner_epoch || owner.topology_generation !== row.topology_generation
        || source?.incarnation !== row.source_incarnation || !source.local_path || canonicalFilesystemPath(source.local_path) !== row.root) {
        report.pending.push({ path: row.root, reason: 'released_identity_changed_or_reclaimed' }); return;
      }
      await assertNoReleaseRootSharing(engine, row);
      // Verify the complete surviving set before deleting anything. Changed tokens or new claim markers stay.
      for (const marker of row.marker_digests) {
        const value = readPrivate(marker.path);
        if (value !== null && hashRecord(value) !== marker.digest) {
          report.pending.push({ path: marker.path, reason: 'released_marker_identity_changed' }); return;
        }
      }
      for (const marker of row.marker_digests) {
        const value = readPrivate(marker.path);
        if (value === null) continue;
        await assertNoReleaseRootSharing(engine, row);
        physical();
        const current = readPrivate(marker.path);
        if (current === null) continue;
        if (hashRecord(current) !== marker.digest) { report.pending.push({ path: marker.path, reason: 'changed_while_cleaning' }); return; }
        unlinkSync(marker.path); report.removed.push(marker.path);
      }
    };
    try {
      if (locksHeld) await clean();
      else await withTopologyLocks(engine, row.source_id, async () => {
        const handle = await acquireNativeLock(row.coordination_path, { timeoutMs: 5000 });
        if (!handle) throw new OperationError('write_pending', 'The released root lock is busy.');
        try { await clean(); } finally { await handle.release(); }
      });
    } catch (error) { report.pending.push({ path: row.root, reason: error instanceof OperationError ? error.code : 'released_marker_cleanup_failed' }); }
  }
  if (report.pending.length) { report.state = 'pending'; report.rerun = 'gbrain sources writer status --json'; }
  return report;
}
