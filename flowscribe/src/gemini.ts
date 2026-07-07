/**
 * Minimal Gemini API client (REST, no SDK dependency).
 * Requires the GEMINI_API_KEY environment variable.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiImage {
  mimeType: string;
  /** Base64-encoded image data. */
  data: string;
}

export interface GeminiRequest {
  prompt: string;
  images?: GeminiImage[];
  /** Ask the model to return raw JSON (sets responseMimeType). */
  json?: boolean;
  model?: string;
  temperature?: number;
}

export function defaultModel(): string {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

export async function geminiGenerate(req: GeminiRequest): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey ' +
        'and export it: export GEMINI_API_KEY=...',
    );
  }
  const model = req.model || defaultModel();

  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
  for (const img of req.images ?? []) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: req.temperature ?? 0.4,
      ...(req.json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    try {
      const res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Retry on rate limits / transient server errors only.
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`);
          continue;
        }
        throw new Error(`Gemini API ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('');
      if (!text) throw new Error('Gemini returned an empty response.');
      return text;
    } catch (err) {
      lastError = err as Error;
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|429|5\d\d/.test(String(err))) {
        throw err;
      }
    }
  }
  throw lastError ?? new Error('Gemini request failed.');
}

/** Parse a JSON response, tolerating markdown code fences. */
export function parseJsonResponse<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  return JSON.parse(cleaned) as T;
}
