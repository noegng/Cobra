/**
 * Optional speech-to-text for voice notes: Whisper on Groq (OpenAI-compatible endpoint), behind env GROQ_API_KEY.
 * Plain `fetch` + `FormData`, no extra dependency.
 */
export const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";

export type Transcribe = (audio: ArrayBuffer, mime: string) => Promise<string>;

export function createGroqTranscriber(opts: {
  apiKey: string;
  model?: string;
  /** Hint ("es", "pt", "en") improves accuracy; omit for auto-detect. */
  language?: string;
  fetch?: typeof fetch;
}): Transcribe {
  const f = opts.fetch ?? fetch;
  return async (audio, mime) => {
    const form = new FormData();
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "m4a";
    form.append("file", new Blob([audio], { type: mime }), `voice.${ext}`);
    form.append("model", opts.model ?? GROQ_DEFAULT_MODEL);
    form.append("response_format", "json");
    if (opts.language) form.append("language", opts.language);
    const res = await f(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`groq transcription failed: HTTP ${res.status}`);
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== "string") throw new Error("groq transcription: no text");
    return body.text.trim();
  };
}

/** Returns a transcriber when GROQ_API_KEY is set, else undefined (voice notes then get a polite "type it" reply). */
export function groqTranscriberFromEnv(env: Record<string, string | undefined> = process.env): Transcribe | undefined {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return undefined;
  return createGroqTranscriber({ apiKey, model: env.GROQ_WHISPER_MODEL || undefined });
}
