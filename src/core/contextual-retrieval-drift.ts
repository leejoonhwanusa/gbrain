import type { BrainEngine } from './engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import {
  computeCorpusGeneration,
  DEFAULT_CONTEXTUAL_RETRIEVAL_HAIKU_MODEL,
} from './contextual-retrieval-service.ts';
import { resolveContextualRetrievalMode } from './contextual-retrieval-resolver.ts';
import { loadSearchModeConfig, resolveSearchMode } from './search/mode.ts';
import type { CRMode } from './types.ts';

interface ContextualRetrievalStateRow {
  id: number | string;
  slug: string;
  source_id: string;
  source_path: string | null;
  chunker_version: number | string | null;
  contextual_retrieval_mode: string | null;
  corpus_generation: string | null;
  frontmatter: Record<string, unknown> | string | null;
  source_contextual_retrieval_mode: string | null;
  trust_frontmatter_overrides: boolean | null;
}

export interface ContextualRetrievalDriftPage {
  id: number;
  slug: string;
  sourceId: string;
  sourcePath: string | null;
  expectedMode: CRMode;
  actualMode: string | null;
  expectedGeneration: string | null;
  actualGeneration: string | null;
  chunkerDrift: boolean;
  modeDrift: boolean;
  generationDrift: boolean;
}

export interface ContextualRetrievalStateInspection {
  activeSearchMode: string;
  globalMode: CRMode;
  killSwitchDisabled: boolean;
  totalMarkdownPages: number;
  chunkerDrift: number;
  modeDrift: number;
  generationDrift: number;
  expectedModeCounts: Record<CRMode, number>;
  driftedPages: ContextualRetrievalDriftPage[];
}

function normalizeFrontmatter(
  value: ContextualRetrievalStateRow['frontmatter'],
): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function expectedGenerationForMode(mode: CRMode): string | null {
  if (mode === 'none') return null;
  return computeCorpusGeneration({
    crMode: mode,
    haikuModel: DEFAULT_CONTEXTUAL_RETRIEVAL_HAIKU_MODEL,
  });
}

/**
 * Inspect the full persisted contextual-retrieval contract against the active
 * configuration: chunker generation, exact effective mode (including trusted
 * page/source overrides and the kill switch), and corpus-generation hash.
 *
 * Returning the compact drift rows lets doctor and reindex share one source of
 * truth. It also closes the prior false-green state where any non-NULL mode was
 * treated as aligned after the active search mode changed.
 */
export async function inspectContextualRetrievalState(
  engine: BrainEngine,
): Promise<ContextualRetrievalStateInspection> {
  const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
  const globalMode = knobs.contextual_retrieval;
  const killSwitchDisabled = knobs.contextual_retrieval_disabled;
  const rows = await engine.executeRaw<ContextualRetrievalStateRow>(
    `SELECT p.id, p.slug, p.source_id, p.source_path, p.chunker_version,
            p.contextual_retrieval_mode, p.corpus_generation, p.frontmatter,
            s.contextual_retrieval_mode AS source_contextual_retrieval_mode,
            s.trust_frontmatter_overrides
       FROM pages p
       LEFT JOIN sources s ON s.id = p.source_id
      WHERE p.page_kind = 'markdown'
        AND p.deleted_at IS NULL
      ORDER BY p.id ASC`,
  );

  const expectedModeCounts: Record<CRMode, number> = {
    none: 0,
    title: 0,
    per_chunk_synopsis: 0,
  };
  const driftedPages: ContextualRetrievalDriftPage[] = [];
  let chunkerDrift = 0;
  let modeDrift = 0;
  let generationDrift = 0;

  for (const row of rows) {
    const expectedMode = resolveContextualRetrievalMode({
      pageFrontmatter: normalizeFrontmatter(row.frontmatter),
      source: {
        id: row.source_id,
        contextual_retrieval_mode: row.source_contextual_retrieval_mode,
        trust_frontmatter_overrides: row.trust_frontmatter_overrides === true,
      },
      globalMode,
      killSwitchDisabled,
    }).mode;
    const expectedGeneration = expectedGenerationForMode(expectedMode);
    const hasChunkerDrift = Number(row.chunker_version ?? 0) < MARKDOWN_CHUNKER_VERSION;
    const hasModeDrift = row.contextual_retrieval_mode !== expectedMode;
    const hasGenerationDrift = row.corpus_generation !== expectedGeneration;
    expectedModeCounts[expectedMode] += 1;
    if (hasChunkerDrift) chunkerDrift += 1;
    if (hasModeDrift) modeDrift += 1;
    if (hasGenerationDrift) generationDrift += 1;
    if (!hasChunkerDrift && !hasModeDrift && !hasGenerationDrift) continue;

    driftedPages.push({
      id: Number(row.id),
      slug: row.slug,
      sourceId: row.source_id,
      sourcePath: row.source_path,
      expectedMode,
      actualMode: row.contextual_retrieval_mode,
      expectedGeneration,
      actualGeneration: row.corpus_generation,
      chunkerDrift: hasChunkerDrift,
      modeDrift: hasModeDrift,
      generationDrift: hasGenerationDrift,
    });
  }

  return {
    activeSearchMode: knobs.resolved_mode,
    globalMode,
    killSwitchDisabled,
    totalMarkdownPages: rows.length,
    chunkerDrift,
    modeDrift,
    generationDrift,
    expectedModeCounts,
    driftedPages,
  };
}
