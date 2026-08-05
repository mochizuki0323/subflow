import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { extractTarBz2 } from './parakeet-manager';

// Registry for the cache-aware streaming models. Kept separate from the
// Parakeet registry rather than merged into it: these are streaming, take no
// VAD, and are picked by chunk size instead of by language, so putting them in
// the same list would mean a list whose entries answer different questions.

export interface NemotronModelEntry {
  id: string;
  archive: string;
  dir_name: string;
  chunk_ms: number;
  archive_size_bytes: number;
  recommended?: boolean;
  description_en: string;
  description_zh: string;
}

export interface NemotronLanguage {
  code: string;
  name_en: string;
  name_zh: string;
}

interface NemotronRegistry {
  version: number;
  download_base_url: string;
  models: NemotronModelEntry[];
  auto_language: string;
  languages: NemotronLanguage[];
}

let cachedRegistry: NemotronRegistry | null = null;

function loadRegistry(): NemotronRegistry {
  if (cachedRegistry) return cachedRegistry;

  // Same three places the Parakeet registry is looked for: repo layout in dev,
  // dist layout after a build, and resources/shared once packaged.
  const candidates = [
    path.join(__dirname, '../../src/shared/nemotron-models.json'),
    path.join(__dirname, '../shared/nemotron-models.json'),
    path.join(process.resourcesPath ?? '', 'shared', 'nemotron-models.json'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedRegistry = JSON.parse(fs.readFileSync(p, 'utf-8')) as NemotronRegistry;
        return cachedRegistry!;
      }
    } catch { /* try next */ }
  }
  throw new Error('nemotron-models.json not found');
}

export function getNemotronModels(): NemotronModelEntry[] {
  return loadRegistry().models;
}

export function findNemotronModel(modelId: string): NemotronModelEntry | undefined {
  return loadRegistry().models.find(m => m.id === modelId);
}

export function getNemotronLanguages(): NemotronLanguage[] {
  return loadRegistry().languages;
}

/**
 * Map a UI language code onto an entry of the model's prompt dictionary, which
 * only lists region-qualified locales. A bare code resolves to its first
 * regional variant in registry order, so the mapping cannot drift from the
 * registry the way a hand-written table did (it covered ten codes while the
 * picker offered nineteen — the other nine quietly became auto-detect).
 * sherpa >= 1.13.4 aliases unambiguous bare codes itself, but resolving here
 * keeps every send path explicit and independent of that behaviour.
 */
export function toNemotronLanguage(code: string | undefined): string {
  if (!code) return 'auto';
  const c = code.trim();
  if (!c || c === 'auto') return 'auto';
  const languages = loadRegistry().languages;
  if (languages.some(l => l.code === c)) return c;
  const regional = languages.find(l => l.code.startsWith(c + '-'));
  return regional ? regional.code : 'auto';
}

export function getNemotronModelsDir(configDir: string): string {
  const dir = path.join(configDir, 'models');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getNemotronModelDir(configDir: string, model: NemotronModelEntry): string {
  return path.join(getNemotronModelsDir(configDir), model.dir_name);
}

/**
 * The model the backend should load: the configured one if all its files are
 * on disk, otherwise the first fully-downloaded variant. Same rule the
 * settings panel applies to its picker, so what the backend loads and what
 * the UI shows cannot name different models — the old id-only lookup let a
 * stale config spawn a modelless backend while the picker displayed the
 * variant the user had actually downloaded.
 */
export function resolveNemotronModel(
  configDir: string,
  modelId: string | undefined,
): NemotronModelEntry | undefined {
  if (modelId) {
    const chosen = findNemotronModel(modelId);
    if (chosen && isNemotronModelDownloaded(configDir, chosen)) return chosen;
  }
  return loadRegistry().models.find(m => isNemotronModelDownloaded(configDir, m));
}

export function isNemotronModelDownloaded(configDir: string, model: NemotronModelEntry): boolean {
  const dir = getNemotronModelDir(configDir, model);
  // All four files must be present: a half-extracted directory would otherwise
  // read as installed and only fail later, inside the backend.
  return ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
    .every(f => fs.existsSync(path.join(dir, f)));
}

export function getNemotronModelStatus(
  configDir: string,
): Array<NemotronModelEntry & { downloaded: boolean; localDir: string }> {
  return getNemotronModels().map(m => ({
    ...m,
    downloaded: isNemotronModelDownloaded(configDir, m),
    localDir: getNemotronModelDir(configDir, m),
  }));
}

export function deleteNemotronModel(configDir: string, modelId: string): boolean {
  const model = findNemotronModel(modelId);
  if (!model) return false;
  const dir = getNemotronModelDir(configDir, model);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function downloadNemotronModel(
  configDir: string,
  modelId: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reg = loadRegistry();
    const model = reg.models.find(m => m.id === modelId);
    if (!model) return reject(new Error(`Unknown model: ${modelId}`));

    const modelDir = getNemotronModelDir(configDir, model);
    if (isNemotronModelDownloaded(configDir, model)) return resolve(modelDir);

    const modelsDir = getNemotronModelsDir(configDir);
    const tmpPath = path.join(modelsDir, model.archive + '.tmp');

    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      const lib = requestUrl.startsWith('https') ? https : http;
      const req = lib.get(requestUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10) || model.archive_size_bytes;
        let received = 0;
        const file = fs.createWriteStream(tmpPath);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          file.write(chunk);
          // Reserve 90% for the download, the rest for extraction.
          if (total > 0 && onProgress) {
            onProgress(Math.min(90, Math.round((received / total) * 90)));
          }
        });

        res.on('end', () => {
          file.end(async () => {
            try {
              const archivePath = path.join(modelsDir, model.archive);
              fs.renameSync(tmpPath, archivePath);
              onProgress?.(92);
              await extractTarBz2(archivePath, modelsDir);
              onProgress?.(98);
              try { fs.unlinkSync(archivePath); } catch { /* ignore */ }
              onProgress?.(100);
              resolve(modelDir);
            } catch (err) {
              try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
              reject(err);
            }
          });
        });

        res.on('error', (err) => {
          file.destroy();
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          reject(err);
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(err);
      });

      req.setTimeout(600000, () => {
        req.destroy();
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(new Error('Download timeout'));
      });
    };

    doRequest(`${reg.download_base_url}/${model.archive}`, 0);
  });
}
