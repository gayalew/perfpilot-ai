/** Ambient types for the unused starter ranker. The package is not installed. */
declare module '@google/genai' {
  export class GoogleGenAI {
    constructor(options: { apiKey?: string });
    models: {
      generateContent(request: { model: string; contents: string }): Promise<{ text?: string }>;
    };
  }
}
