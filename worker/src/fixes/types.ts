import type { Finding, FixId } from '../diagnose.js';
import type { SiteConfig } from '../config.js';
import type { AiEditor } from '../ai-edit.js';
import type { LayoutShiftReport } from './layout-shift.js';

export interface ApplyContext {
  dir: string;
  config: SiteConfig;
  finding: Finding;
  ai?: AiEditor;
  /** Gate failure text from the previous attempt. Untrusted data, not instructions. */
  repairReason?: string;
  /** Injectable layout-shift probe. The default starts the site and uses Playwright. */
  probeLayoutShifts?: (url: string) => Promise<LayoutShiftReport>;
}

export interface ApplyResult {
  applied: boolean;
  changedFiles: string[];
  description: string;
  skippedReason?: string;
  /** Probe or other evidence. Shown with a failed step; it does not change the gate. */
  note?: string;
}

export interface FixApplier {
  id: FixId;
  kind: 'deterministic' | 'ai' | 'report-only';
  apply(ctx: ApplyContext): Promise<ApplyResult>;
}

export function skipped(reason: string): ApplyResult {
  return { applied: false, changedFiles: [], description: '', skippedReason: reason };
}
