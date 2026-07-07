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

export interface GeminiTtsRequest {
  text: string;
  /** Prebuilt Gemini voice name (e.g. Kore, Puck, Charon, Fenrir, Aoede). */
  voice?: string;
  model?: string;
}

export function defaultTtsModel(): string {
  return process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
}

/** Synthesize speech with Gemini TTS. Returns a playable WAV buffer. */
export async function geminiTts(req: GeminiTtsRequest): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey ' +
        'and export it: export GEMINI_API_KEY=...',
    );
  }
  const model = req.model || defaultTtsModel();
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: req.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: req.voice || 'Kore' },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini TTS ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    }>;
  };
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error('Gemini TTS returned no audio.');
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000);
  return pcmToWav(pcm, rate);
}

/** Wrap raw 16-bit mono PCM in a WAV container. */
function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Parse a JSON response, tolerating markdown code fences. */
export function parseJsonResponse<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  return JSON.parse(cleaned) as T;
}
