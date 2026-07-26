// Bun only embeds non-code assets referenced through `type: 'file'` imports.
// Keep every loadable bundled schema pack in this single registry so source
// execution, compiled binaries, and `gbrain schema list` cannot drift.

// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainBasePath from './base/gbrain-base.yaml' with { type: 'file' };
// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainRecommendedPath from './base/gbrain-recommended.yaml' with { type: 'file' };
// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainCreatorPath from './base/gbrain-creator.yaml' with { type: 'file' };
// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainInvestorPath from './base/gbrain-investor.yaml' with { type: 'file' };
// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainEngineerPath from './base/gbrain-engineer.yaml' with { type: 'file' };
// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainEverythingPath from './base/gbrain-everything.yaml' with { type: 'file' };
// @ts-ignore — `type: 'file'` is Bun ESM syntax not represented in lib.d.ts.
import gbrainBaseV2Path from './base/gbrain-base-v2.yaml' with { type: 'file' };

export const LOADABLE_BUNDLED_PACK_NAMES = [
  'gbrain-base',
  'gbrain-recommended',
  'gbrain-creator',
  'gbrain-investor',
  'gbrain-engineer',
  'gbrain-everything',
  'gbrain-base-v2',
] as const;

const BUNDLED_PACK_PATHS: Record<(typeof LOADABLE_BUNDLED_PACK_NAMES)[number], string> = {
  'gbrain-base': gbrainBasePath,
  'gbrain-recommended': gbrainRecommendedPath,
  'gbrain-creator': gbrainCreatorPath,
  'gbrain-investor': gbrainInvestorPath,
  'gbrain-engineer': gbrainEngineerPath,
  'gbrain-everything': gbrainEverythingPath,
  'gbrain-base-v2': gbrainBaseV2Path,
};

export function bundledPackPath(name: string): string | null {
  return BUNDLED_PACK_PATHS[name as keyof typeof BUNDLED_PACK_PATHS] ?? null;
}
