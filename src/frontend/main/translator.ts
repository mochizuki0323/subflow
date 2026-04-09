import https from 'https';
import http from 'http';
import { URL } from 'url';
import { DEFAULT_HISTORY_SYSTEM_HINT } from './translator-defaults';

export type ApiFormat = 'openai' | 'anthropic';

export interface TranslatorConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ApiFormat;
  targetLanguage: string;
  enabled: boolean;
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
    model: 'google/gemma-4-31b-it',
    apiFormat: 'openai',
    targetLanguage: 'zh',
    enabled: false,
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

  async translate(text: string): Promise<string> {
    if (!this.config.enabled || !this.config.apiKey || !text.trim()) {
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
      'Authorization': `Bearer ${this.config.apiKey}`,
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
      'x-api-key': this.config.apiKey,
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
