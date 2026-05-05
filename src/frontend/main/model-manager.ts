import fs from 'fs';
import path from 'path';
import https from 'https';

export interface DeepgramFeatures {
  smart_format: boolean;
  punctuate: boolean;
  interim_results: boolean;
  endpointing: number | false; // ms or false to disable
  utterance_end_ms: number | false;
  diarize: boolean;
  vad_events: boolean;
  numerals: boolean;
}

export interface DeepgramConfig {
  apiKey: string;
  model: string;
  features: DeepgramFeatures;
}

// Default features matching the official Deepgram streaming example.
export const DEFAULT_FEATURES: DeepgramFeatures = {
  smart_format: true,
  punctuate: true,
  interim_results: true,
  endpointing: 10,           // 10ms — same as official example
  utterance_end_ms: 1000,   // trigger result after 1000ms silence (official example)
  diarize: false,
  vad_events: true,
  numerals: false,
};

const DEFAULT_CONFIG: DeepgramConfig = {
  apiKey: '',
  model: 'nova-3',
  features: { ...DEFAULT_FEATURES },
};

/** Build the &key=value query string from features (appended to the WS URL). */
export function buildExtraParams(features: DeepgramFeatures): string {
  const parts: string[] = [];

  if (features.smart_format) parts.push('smart_format=true');
  if (features.punctuate) parts.push('punctuate=true');
  if (features.interim_results) parts.push('interim_results=true');
  // endpointing=false is invalid; omitting the param = Deepgram uses its default.
  // Only add when it's a numeric value.
  if (typeof features.endpointing === 'number') {
    parts.push(`endpointing=${features.endpointing}`);
  }
  if (typeof features.utterance_end_ms === 'number') {
    parts.push(`utterance_end_ms=${features.utterance_end_ms}`);
  }
  if (features.diarize) parts.push('diarize=true');
  if (features.vad_events) parts.push('vad_events=true');
  if (features.numerals) parts.push('numerals=true');

  return parts.join('&');
}

export interface GladiaFeatures {
  code_switching: boolean;
  speech_threshold: number;
  audio_enhancer: boolean;
  endpointing: number;
  max_duration_without_endpointing: number;
  partial_transcripts: boolean;
  sentiment_analysis: boolean;
  named_entity_recognition: boolean;
  words_accurate_timestamps: boolean;
  custom_vocabulary: boolean;
  custom_spelling: boolean;
  translation: boolean;
  translation_target_languages: string[];
}

export interface GladiaConfig {
  apiKey: string;
  model: string;
  features: GladiaFeatures;
}

export const DEFAULT_GLADIA_FEATURES: GladiaFeatures = {
  code_switching: false,
  speech_threshold: 0.8,
  audio_enhancer: false,
  endpointing: 0.01,
  max_duration_without_endpointing: 5,
  partial_transcripts: true,
  sentiment_analysis: false,
  named_entity_recognition: false,
  words_accurate_timestamps: false,
  custom_vocabulary: false,
  custom_spelling: false,
  translation: false,
  translation_target_languages: [],
};

export const DEFAULT_GLADIA: GladiaConfig = {
  apiKey: '',
  model: 'solaria-1',
  features: { ...DEFAULT_GLADIA_FEATURES },
};

export function buildGladiaConfig(features: GladiaFeatures): string {
  return JSON.stringify(features);
}

export class DeepgramConfigManager {
  private configPath: string;
  private config: DeepgramConfig;

  constructor(configDir: string) {
    this.configPath = path.join(configDir, 'deepgram-config.json');
    this.config = this.load();
  }

  private load(): DeepgramConfig {
    try {
      const data = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(data);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        features: { ...DEFAULT_FEATURES, ...(parsed.features || {}) },
      };
    } catch {
      return { ...DEFAULT_CONFIG, features: { ...DEFAULT_FEATURES } };
    }
  }

  save(partial: Partial<DeepgramConfig>): void {
    this.config = {
      ...this.config,
      ...partial,
      features: { ...this.config.features, ...(partial.features || {}) },
    };
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (err) {
      console.error('Failed to save Deepgram config:', err);
    }
  }

  get(): DeepgramConfig {
    return this.config;
  }

  /** Fetch available models from Deepgram API. */
  fetchModels(): Promise<Array<{ name: string; canonical_name: string; version: string; languages: string[] }>> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.deepgram.com',
        path: '/v1/models',
        method: 'GET',
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            // Deepgram returns { stt: [...], tts: [...] }
            const sttModels = (data.stt || []).map((m: any) => ({
              name: m.name || '',
              canonical_name: m.canonical_name || m.name || '',
              version: m.version || '',
              languages: m.languages || [],
            }));
            resolve(sttModels);
          } catch {
            reject(new Error(`Failed to parse models response: ${body.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(new Error('Timeout')); });
      req.end();
    });
  }
}
