import { readFile } from "fs/promises";

export interface DiagnosisFinding {
  id: string;
  title: string;
  description: string;
  score: number | null;
  metricSavings?: {
    lcpMs?: number;
    tbtMs?: number;
  };
}

export async function parseLighthouseDiagnosis(
  lighthouseJsonPath: string,
): Promise<DiagnosisFinding[]> {
  const rawData = await readFile(lighthouseJsonPath, "utf-8");
  const lh = JSON.parse(rawData);
  const audits = lh.audits || {};
  const findings: DiagnosisFinding[] = [];

  // Check for render-blocking resources
  const blockingAudit = audits["render-blocking-resources"];
  if (blockingAudit && blockingAudit.details?.items?.length > 0) {
    findings.push({
      id: "render-blocking-resources",
      title: blockingAudit.title,
      description: blockingAudit.description,
      score: blockingAudit.score,
      metricSavings: {
        lcpMs: blockingAudit.details.overallSavingsMs,
      },
    });
  }

  // Check for unoptimized large images
  const offscreenImages = audits["offscreen-images"];
  if (offscreenImages && offscreenImages.score !== 1) {
    findings.push({
      id: "offscreen-images",
      title: offscreenImages.title,
      description: offscreenImages.description,
      score: offscreenImages.score,
    });
  }

  // Check for long main-thread tasks
  const longTasks = audits["long-tasks"];
  if (longTasks && longTasks.details?.items?.length > 0) {
    findings.push({
      id: "long-tasks",
      title: longTasks.title,
      description: longTasks.description,
      score: longTasks.score,
      metricSavings: {
        tbtMs: longTasks.details.overallSavingsMs,
      },
    });
  }

  return findings;
}
