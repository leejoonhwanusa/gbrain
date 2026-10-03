/** Deliberate rollback of one exclusive, local claim in an inactive brain. */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { assertWriterAdminState, writerAdminState } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';
import { deactivationBlockers } from './deactivation.ts';
import { existingLocalHostId } from './identity.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import { assertNoPhysicalRootOverlap } from './physical-root-record.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { lockTopologyPrincipal, lockTopologyRows, topologyPrincipal, withTopologyLocks } from './topology-locks.ts';
import { priorTopologyChange, recordTopologyChange } from './topology-receipts.ts';
import { assertNoReleaseRootSharing, captureReleaseMarkers, cleanupReleasedManagedMarkers } from './release-markers.ts';
import { topologyDirectoryIdentity } from './topology-filesystem.ts';
import { planHoldCarry } from '../connectors/item-holds-store.ts';

async function inspect(engine: BrainEngine, sourceId: string): Promise<WorktreeBinding & { brain_id: string; root: string }> {
  await assertWriterAdminUnlocked(engine);
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  if (!brain || brain.enabled) throw new OperationError('writer_release_requires_classic', 'Release is available only while managed persistence is disabled.');
  const binding = await getWorktreeBinding(engine, sourceId, existingLocalHostId());
  if (!binding || binding.owner_host_id !== existingLocalHostId() || !binding.local_path || !binding.coordination_path) {
    throw new OperationError('owner_unavailable', 'An active claim owned by this host is required.');
  }
  if (binding.state !== 'active' || binding.relative_path !== '') throw new OperationError('source_changed', 'Only an exclusive active worktree root may be released.');
  const members = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid', [binding.worktree_id]);
  const hosts = await engine.executeRaw<{ host_id: string }>('SELECT host_id FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [binding.worktree_id]);
  if (members.length !== 1 || members[0].source_id !== sourceId || hosts.length !== 1 || hosts[0].host_id !== existingLocalHostId()) {
    throw new OperationError('source_changed', 'Shared worktrees or host bindings cannot be released individually.');
  }
  const root = canonicalFilesystemPath(binding.local_path);
  const sources = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; archived: boolean }>('SELECT id,incarnation,local_path,archived FROM sources');
  const selected = sources.find(row => row.id === sourceId);
  if (!selected || selected.archived || selected.incarnation !== binding.source_incarnation || !selected.local_path
    || canonicalFilesystemPath(selected.local_path) !== root) throw new OperationError('source_changed', 'The canonical source identity or path changed.');
  await assertNoReleaseRootSharing(engine, { root, source_id: sourceId, source_incarnation: binding.source_incarnation }, binding.worktree_id);
  assertPhysicalRoot(root, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
  assertNoPhysicalRootOverlap(root);
  const blockers = await deactivationBlockers(engine);
  const holds = (await planHoldCarry(engine, existingLocalHostId())).filter(row => row.items > 0);
  if (blockers.length || holds.length) throw new OperationError('writer_not_quiesced', 'Pending requests, effects, recovery, leases or connector holds prevent release.',
    [...blockers.map(row => `${row.kind} ${row.id}: ${row.exit}`),
      ...holds.map(row => `connector_holds ${row.source_id}: inspect gbrain sources status ${row.source_id}`)].slice(0, 10).join(' | '));
  return { ...binding, brain_id: brain.brain_id, root };
}

export async function releaseSourceClaim(engine: BrainEngine, sourceId: string,
  opts: { dryRun?: boolean; expectedState?: string; requestId?: string } = {}): Promise<Record<string, unknown>> {
  if (!isValidSourceId(sourceId)) throw new OperationError('invalid_params', 'An explicit valid source ID is required.');
  if (!opts.dryRun && (!opts.expectedState || !/^[a-f0-9]{64}$/.test(opts.expectedState))) {
    throw new OperationError('writer_admin_intent_required', 'A reviewed expected-state is required for release.');
  }
  const principal = await topologyPrincipal(engine);
  const intent = { operation: 'writer_release', source_id: sourceId };
  const requestId = opts.requestId ?? randomUUID();
  if (opts.dryRun) {
    const before = await writerAdminState(engine);
    const binding = await inspect(engine, sourceId);
    captureReleaseMarkers(binding);
    if (await writerAdminState(engine) !== before) throw new OperationError('writer_admin_state_changed', 'Topology changed during release preview.');
    return { dry_run: true, released: false, source_id: sourceId, binding, admin_state: before,
      apply_command: `gbrain sources writer release ${sourceId} --admin-intent writer_release --expected-state ${before} --json` };
  }
  const prior = await priorTopologyChange(engine, principal, requestId, intent);
  if (prior) {
    if (prior.state !== 'committed' || !prior.outcome) throw new OperationError('recovery_required', 'The prior release is not committed.');
    return { ...prior.outcome, request_id: requestId, local_markers: await cleanupReleasedManagedMarkers(engine, requestId) };
  }
  return withTopologyLocks(engine, sourceId, async bindings => {
    const before = await inspect(engine, sourceId);
    const markers = captureReleaseMarkers(before);
    const outcome = await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','5000ms',true),set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, opts.expectedState);
      await lockTopologyRows(tx, sourceId, bindings);
      await lockTopologyPrincipal(tx, principal);
      const current = await inspect(tx, sourceId);
      const again = await priorTopologyChange(tx, principal, requestId, intent);
      if (again) throw new OperationError('writer_admin_state_changed', 'This release completed concurrently; inspect its receipt.');
      const result = { released: true, brain_id: current.brain_id, source_id: sourceId,
        source_incarnation: current.source_incarnation, worktree_id: current.worktree_id, root: current.root,
        coordination_path: current.coordination_path!, owner_host_id: current.owner_host_id,
        owner_epoch: String(current.owner_epoch), topology_generation: String(current.topology_generation), marker_digests: markers,
        physical_identity: topologyDirectoryIdentity(current.root) };
      const removed = await tx.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1 AND worktree_id=$2::uuid AND source_incarnation=$3::uuid RETURNING source_id',
        [sourceId, current.worktree_id, current.source_incarnation]);
      if (removed.length !== 1) throw new OperationError('source_changed', 'The selected binding changed.');
      await tx.executeRaw('DELETE FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [current.worktree_id]);
      await tx.executeRaw("UPDATE persistence_worktrees SET state='retired' WHERE id=$1::uuid", [current.worktree_id]);
      await recordTopologyChange(tx, { principal, requestId, intent, operation: 'writer_release', sourceId,
        incarnation: current.source_incarnation, worktrees: [current.worktree_id] }, result);
      return result;
    });
    // Keep the native worktree lock through filesystem cleanup. No database transaction spans it.
    return { ...outcome, request_id: requestId,
      local_markers: await cleanupReleasedManagedMarkers(engine, requestId, true) };
  });
}
