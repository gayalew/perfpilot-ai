import type { FixId } from '../diagnose.js';
import { cacheHeaders, compressText, reportOnly, reserveSpace, splitLongTasks } from './ai.js';
import { deferScripts, imageDimensions, lazyLoadImages, minifyAssets, optimizeImages, preloadLcpImage } from './deterministic.js';
import type { FixApplier } from './types.js';

export const APPLIERS: FixApplier[] = [
  deferScripts,
  lazyLoadImages,
  preloadLcpImage,
  imageDimensions,
  optimizeImages,
  minifyAssets,
  compressText,
  cacheHeaders,
  reserveSpace,
  splitLongTasks,
  reportOnly('remove-unused-code'),
  reportOnly('reduce-dom'),
  reportOnly('preconnect'),
];

const BY_ID = new Map<FixId, FixApplier>(APPLIERS.map((applier) => [applier.id, applier]));

export function applierFor(id: FixId): FixApplier | undefined {
  return BY_ID.get(id);
}

export type { ApplyContext, ApplyResult, FixApplier } from './types.js';
