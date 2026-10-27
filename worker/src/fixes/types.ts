import type { Finding, FixId } from '../diagnose.js';
import type { SiteConfig } from '../config.js';
import type { AiEditor } from '../ai-edit.js';

export interface ApplyContext {
  dir: string;
  config: SiteConfig;
  finding: Finding;
  ai?: AiEditor;
}

export interface ApplyResult {
  applied: boolean;
  changedFiles: string[];
  description: string;
  skippedReason?: string;
}

export interface FixApplier {
  id: FixId;
  kind: 'deterministic' | 'ai' | 'report-only';
  apply(ctx: ApplyContext): Promise<ApplyResult>;
}

export function skipped(reason: string): ApplyResult {
  return { applied: false, changedFiles: [], description: '', skippedReason: reason };
}
