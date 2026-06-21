import https from 'https';
import http from 'http';
import { URL } from 'url';
import { DEFAULT_HISTORY_SYSTEM_HINT } from './translator-defaults';

export type ApiFormat = 'openai' | 'anthropic' | 'google';

export interface TranslatorConfig {
  baseUrl: string;
  /** Active-format key. Mirrors `apiKeys[apiFormat]`; kept for backward compat. */
  apiKey: string;
  /** Per-format API keys so switching provider doesn't clobber the others. */
  apiKeys: Record<ApiFormat, string>;
  model: string;
  apiFormat: ApiFormat;
  targetLanguage: string;
  enabled: boolean;
  /** When false, only final transcripts are translated (interim/partial ones are skipped). */
  translatePartials: boolean;
  contextPrompt: string;
  useHistory: boolean;
  /** Sliding window size (source+translated pairs), clamped to 1–100. */
  historyMaxPairs: number;
  /** Max chars per history line sent to the API; 0 = no truncation. */
  historyMaxCharsPerEntry: number;
  /** When non-empty, replaces the built-in English history instruction in the system prompt. */
  historySystemHint: string;
}

const HISTORY_MAX_PAIRS_MIN = 1;
const HISTORY_MAX_PAIRS_MAX = 100;

function clampHistoryMaxPairs(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.max(HISTORY_MAX_PAIRS_MIN, Math.min(HISTORY_MAX_PAIRS_MAX, Math.floor(n)));
}

function normalizeHistoryMaxCharsPerEntry(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

const TARGET_LANGUAGES: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  it: 'Italiano',
};

export class Translator {
  private config: TranslatorConfig = {
    baseUrl: 'https://openrouter.ai/api',
    apiKey: '',
    apiKeys: { openai: '', anthropic: '', google: '' },
    model: 'google/gemma-4-31b-it',
    apiFormat: 'openai',
    targetLanguage: 'zh',
    enabled: false,
    translatePartials: false,
    contextPrompt: '',
    useHistory: false,
    historyMaxPairs: 10,
    historyMaxCharsPerEntry: 0,
    historySystemHint: '',
  };

  // Simple cache to avoid re-translating identical text
  private cache = new Map<string, string>();
  private static readonly MAX_CACHE = 200;

  // Track in-flight requests to deduplicate
  private pending = new Map<string, Promise<string>>();

  // Sliding window of recent translation pairs for context
  private history: Array<{ source: string; translated: string }> = [];

  private effectiveHistoryMaxPairs(): number {
    return clampHistoryMaxPairs(this.config.historyMaxPairs);
  }

  /** Record a completed translation pair into the history window. */
  pushHistory(source: string, translated: string) {
    if (!source || !translated) return;
    const max = this.effectiveHistoryMaxPairs();
    this.history.push({ source, translated });
    while (this.history.length > max) {
      this.history.shift();
    }
  }

  setConfig(config: Partial<TranslatorConfig>) {
    Object.assign(this.config, config);
    if (config.historyMaxPairs !== undefined) {
      this.config.historyMaxPairs = clampHistoryMaxPairs(Number(this.config.historyMaxPairs));
      const max = this.effectiveHistoryMaxPairs();
      if (this.history.length > max) {
        this.history = this.history.slice(-max);
      }
    }
    if (config.historyMaxCharsPerEntry !== undefined) {
      this.config.historyMaxCharsPerEntry = normalizeHistoryMaxCharsPerEntry(
        Number(this.config.historyMaxCharsPerEntry),
      );
    }
    const cacheBump =
      config.targetLanguage ||
      config.model ||
      config.contextPrompt !== undefined ||
      config.historySystemHint !== undefined ||
      config.historyMaxPairs !== undefined ||
      config.historyMaxCharsPerEntry !== undefined;
    if (cacheBump) {
      this.cache.clear();
    }
    if (config.useHistory === false) {
      this.history = [];
    }
  }

  getConfig(): TranslatorConfig {
    return { ...this.config };
  }

  /**
   * The key for the active format. Falls back to the flat `apiKey` only for
   * legacy configs that carry no per-format keys at all — never borrow another
   * format's key (that would send e.g. an OpenAI key to the Google endpoint).
   */
  private effectiveApiKey(): string {
    const perFormat = this.config.apiKeys?.[this.config.apiFormat];
    if (perFormat) return perFormat;
    const hasAnyPerFormat = this.config.apiKeys && Object.values(this.config.apiKeys).some(Boolean);
    return hasAnyPerFormat ? '' : (this.config.apiKey || '');
  }

  async translate(text: string): Promise<string> {
    if (!this.config.enabled || !this.effectiveApiKey() || !text.trim()) {
      return '';
    }

    const cacheKey = text.trim();
    const skipCache = this.config.useHistory && this.history.length > 0;

    if (!skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const inflight = this.pending.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.doTranslate(cacheKey);
    this.pending.set(cacheKey, promise);

    try {
      const result = await promise;

      if (this.cache.size >= Translator.MAX_CACHE) {
        const firstKey = this.cache.keys().next().value!;
        this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, result);

      return result;
    } catch (err) {
      console.error('[Translator] Translation failed:', err);
      return '';
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  private doTranslate(text: string): Promise<string> {
    const langName = TARGET_LANGUAGES[this.config.targetLanguage] || this.config.targetLanguage;
    const context = this.config.contextPrompt?.trim();
    const contextLine = context ? ` Context: ${context}.` : '';
    const customHistoryHint = this.config.historySystemHint?.trim();
    const historyHint =
      this.config.useHistory && this.history.length > 0
        ? customHistoryHint
          ? ` ${customHistoryHint}`
          : DEFAULT_HISTORY_SYSTEM_HINT
        : '';
    const systemPrompt = `You are a subtitle translator. Translate the following text to ${langName}. Output ONLY the translation, nothing else. Keep it concise and natural. If the text is already in ${langName}, output it as-is.${contextLine}${historyHint}`;

    // Build message history for context
    const historyMessages = this.buildHistoryMessages();

    if (this.config.apiFormat === 'anthropic') {
      return this.callAnthropic(text, systemPrompt, historyMessages);
    }
    if (this.config.apiFormat === 'google') {
      return this.callGoogle(text, systemPrompt, historyMessages);
    }
    return this.callOpenAI(text, systemPrompt, historyMessages);
  }

  private truncateForHistory(text: string): string {
    const max = normalizeHistoryMaxCharsPerEntry(this.config.historyMaxCharsPerEntry);
    if (max <= 0 || text.length <= max) return text;
    return text.slice(0, max) + '…';
  }

  /** Build multi-turn history messages from the sliding window. */
  private buildHistoryMessages(): Array<{ role: string; content: string }> {
    if (!this.config.useHistory || this.history.length === 0) return [];
    const msgs: Array<{ role: string; content: string }> = [];
    for (const entry of this.history) {
      msgs.push({ role: 'user', content: this.truncateForHistory(entry.source) });
      msgs.push({ role: 'assistant', content: this.truncateForHistory(entry.translated) });
    }
    return msgs;
  }

  /** OpenAI-compatible: /v1/chat/completions */
  private callOpenAI(text: string, systemPrompt: string, historyMessages: Array<{ role: string; content: string }>): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: text },
    ];

    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: 1024,
      messages,
    });

    return this.httpPost('/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.effectiveApiKey()}`,
    }, body).then(({ status, data }) => {
      const json = JSON.parse(data);
      if (json.choices?.[0]?.message?.content) {
        return json.choices[0].message.content.trim();
      }
      if (json.error) {
        // OpenRouter puts details in error.metadata.raw
        const detail = json.error.metadata?.raw || json.error.message || JSON.stringify(json.error);
        throw new Error(`[${status}] ${detail}`);
      }
      throw new Error(`[${status}] ${data.slice(0, 300)}`);
    });
  }

  /** Anthropic: /v1/messages */
  private callAnthropic(text: string, systemPrompt: string, historyMessages: Array<{ role: string; content: string }>): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [
      ...historyMessages,
      { role: 'user', content: text },
    ];

    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    return this.httpPost('/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': this.effectiveApiKey(),
      'anthropic-version': '2023-06-01',
    }, body).then(({ status, data }) => {
      const json = JSON.parse(data);
      if (json.content?.[0]?.text) {
        return json.content[0].text.trim();
      }
      if (json.error) {
        const detail = json.error.message || JSON.stringify(json.error);
        throw new Error(`[${status}] ${detail}`);
      }
      throw new Error(`[${status}] ${data.slice(0, 300)}`);
    });
  }

  /**
   * Google AI Studio (Gemini / Gemma) generateContent endpoint.
   *
   * These models behave very differently from OpenAI's: instruction-tuned Gemma
   * (e.g. gemma-4-31b-it) is effectively a reasoning model — it dumps its full
   * chain-of-thought (echoing the prompt, listing literal/natural alternatives)
   * and buries the real translation at the very end, sometimes duplicated, often
   * with no clean separator. Plain prompts, few-shot examples, and even
   * `system_instruction` do NOT suppress this.
   *
   * The reliable fix is to constrain the *output grammar*: requesting
   * `responseMimeType: application/json` + a `responseSchema` forces the model to
   * emit only `{"translation": "..."}` with no reasoning at all. For the few
   * Google models that reject structured output we fall back to a sentinel-
   * delimited prompt and extract the marked span.
   */
  private callGoogle(text: string, systemPrompt: string, historyMessages: Array<{ role: string; content: string }>): Promise<string> {
    return this.requestGoogle(text, systemPrompt, historyMessages, true).catch((err) => {
      // Older Gemma models don't support structured output — retry with a
      // sentinel-delimited prompt instead of failing the translation.
      if (/mime|schema|json|response/i.test(String(err?.message || ''))) {
        return this.requestGoogle(text, systemPrompt, historyMessages, false);
      }
      throw err;
    });
  }

  private requestGoogle(
    text: string,
    systemPrompt: string,
    historyMessages: Array<{ role: string; content: string }>,
    jsonMode: boolean,
  ): Promise<string> {
    const instruction = jsonMode
      ? `${systemPrompt}\n\nReturn ONLY a JSON object of the form {"translation": "<the translation>"}.`
      : `${systemPrompt}\n\nYou may think first, but your VERY LAST line MUST be only the final translation wrapped exactly as: §§§the translation§§§`;

    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const m of historyMessages) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
    contents.push({ role: 'user', parts: [{ text }] });

    // Fold the instruction into the first user turn — Gemma has no system role,
    // and folding works for Gemini too.
    const firstUser = contents.find((c) => c.role === 'user');
    if (firstUser) {
      firstUser.parts[0].text = `${instruction}\n\n${firstUser.parts[0].text}`;
    }

    const generationConfig: any = { temperature: 0.2, maxOutputTokens: 1024 };
    if (jsonMode) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = {
        type: 'object',
        properties: { translation: { type: 'string' } },
        required: ['translation'],
      };
    }

    const body = JSON.stringify({ contents, generationConfig });

    // Model id may arrive as "models/gemma-..." or with an OpenRouter-style
    // "google/" vendor prefix; the REST path wants the bare id.
    const modelId = this.config.model.replace(/^models\//, '').replace(/^google\//, '');
    const endpoint = `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

    return this.httpPost(endpoint, {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.effectiveApiKey(),
    }, body).then(({ status, data }) => {
      const json = JSON.parse(data);
      if (json.error) {
        const detail = json.error.message || JSON.stringify(json.error);
        throw new Error(`[${status}] ${detail}`);
      }
      const parts = json.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts) && parts.length > 0) {
        const raw = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
        const extracted = this.extractGoogleTranslation(raw, jsonMode);
        if (extracted) return extracted;
      }
      // A candidate with no usable text usually means the reply was blocked/truncated.
      if (json.promptFeedback?.blockReason) {
        throw new Error(`[${status}] blocked: ${json.promptFeedback.blockReason}`);
      }
      const finish = json.candidates?.[0]?.finishReason;
      if (finish && finish !== 'STOP') {
        throw new Error(`[${status}] no text (finishReason: ${finish})`);
      }
      throw new Error(`[${status}] ${data.slice(0, 300)}`);
    });
  }

  /**
   * Pull the clean translation out of a Gemini/Gemma reply. JSON mode yields
   * `{"translation": "..."}` (possibly with a stray code fence); sentinel mode
   * yields reasoning ending in §§§...§§§. Both fall back to heuristic cleanup.
   */
  private extractGoogleTranslation(raw: string, jsonMode: boolean): string {
    const s = raw.trim();
    if (!s) return '';

    if (jsonMode) {
      const obj = this.tryParseJsonObject(s);
      if (obj && typeof obj.translation === 'string') {
        return this.cleanGoogleOutput(obj.translation);
      }
    } else {
      // Take the LAST sentinel-wrapped span — earlier ones may appear in reasoning.
      const matches = [...s.matchAll(/§§§([\s\S]*?)§§§/g)];
      if (matches.length > 0) {
        return this.cleanGoogleOutput(matches[matches.length - 1][1]);
      }
    }
    // Last resort: best-effort cleanup of whatever came back.
    return this.cleanGoogleOutput(s);
  }

  /** Parse a JSON object, tolerating leading prose or a wrapping code fence. */
  private tryParseJsonObject(s: string): any {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') return o;
    } catch { /* fall through to brace extraction */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const o = JSON.parse(s.slice(start, end + 1));
        if (o && typeof o === 'object') return o;
      } catch { /* not JSON */ }
    }
    return null;
  }

  /**
   * Strip residual noise from a Google reply: chat-turn tokens, a wrapping code
   * fence, a "Here is the translation:" preamble, a trailing "(Note: ...)", and
   * matched surrounding quotes the model added around the whole line.
   */
  private cleanGoogleOutput(raw: string): string {
    let s = raw.trim();
    if (!s) return '';

    // 1. Gemma chat-turn / end-of-sequence tokens.
    s = s.replace(/<\/?(?:start_of_turn|end_of_turn)>/gi, '');
    s = s.replace(/<\|?(?:eot_id|im_start|im_end)\|?>/gi, '');
    s = s.replace(/<\/?(?:s|eos|bos)>/gi, '');
    s = s.trim();

    // 2. Unwrap a single fenced code block: ```lang\n...\n```
    const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (fence) s = fence[1].trim();

    // 3. Drop a leading "Here is the translation:" / "Translation:" preamble.
    s = s.replace(
      /^(?:sure[,!.\s]*|certainly[,!.\s]*|of course[,!.\s]*|okay[,!.\s]*|好的[,，!！.。\s]*)?(?:here(?:'s| is| are)[^:：\n]*|the translation[^:：\n]*|translated text|translation|译文|翻译(?:如下|结果|后)?)\s*[:：]\s*/i,
      '',
    );
    s = s.trim();

    // 4. Drop a trailing "(Note: ...)" / "Note: ..." explanation on its own line.
    s = s.replace(/\n+\s*[(（]?\s*(?:note|notes|注|注释|说明|备注)\s*[:：][\s\S]*$/i, '');
    s = s.trim();

    // 5. Remove matched surrounding quotes the model added around the whole line.
    s = this.stripSurroundingQuotes(s);

    return s.trim();
  }

  private stripSurroundingQuotes(s: string): string {
    const pairs: Array<[string, string]> = [
      ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'],
      ['「', '」'], ['『', '』'],
    ];
    let cur = s;
    let changed = true;
    while (changed && cur.length >= 2) {
      changed = false;
      for (const [open, close] of pairs) {
        if (cur.startsWith(open) && cur.endsWith(close) && cur.length > open.length + close.length - 1) {
          const inner = cur.slice(open.length, cur.length - close.length).trim();
          // Skip if the closing mark recurs inside — the quotes are likely meaningful.
          if (inner && !inner.includes(close)) {
            cur = inner;
            changed = true;
            break;
          }
        }
      }
    }
    return cur;
  }

  private httpPost(endpoint: string, headers: Record<string, string>, body: string): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
      const base = this.config.baseUrl.replace(/\/+$/, '');
      const fullUrl = base + endpoint;
      const url = new URL(fullUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve({ status: res.statusCode || 0, data }));
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }
}
