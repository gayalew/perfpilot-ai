import { GoogleGenAI } from "@google/genai";
import { DiagnosisFinding } from "./diagnosis.js";

export async function rankFindingsWithGemini(
  findings: DiagnosisFinding[],
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const prompt = `
You are a web performance expert. Given the following Lighthouse audit findings, rank them by impact and ease of fix to maximize LCP and TBT improvements. Provide a JSON-structured recommendation plan.

Findings:
${JSON.stringify(findings, null, 2)}
  `;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: prompt,
  });

  return response.text || "{}";
}
