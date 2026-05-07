import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { app } from 'electron';

export interface DenoiseModelEntry {
  id: string;
  filename: string;
  architecture: string;
  sample_rate: number;
  size_bytes: number;
  description_en: string;
  description_zh: string;
}

interface DenoiseModelRegistry {
  version: number;
  download_base_url: string;
  models: DenoiseModelEntry[];
}

let registry: DenoiseModelRegistry | null = null;

function loadRegistry(): DenoiseModelRegistry {
  if (registry) return registry;

  const candidates = [
    path.join(__dirname, '../../src/shared/denoise-models.json'),
    path.join(__dirname, '../shared/denoise-models.json'),
    path.join(process.resourcesPath ?? '', 'shared', 'denoise-models.json'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        registry = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return registry!;
      }
    } catch { /* try next */ }
  }

  registry = { version: 1, download_base_url: '', models: [] };
  return registry;
}

export function getDenoiseModels(): DenoiseModelEntry[] {
  return loadRegistry().models;
}

export function findDenoiseModel(modelId: string): DenoiseModelEntry | undefined {
  return loadRegistry().models.find(m => m.id === modelId);
}

export function getModelsDir(configDir: string): string {
  const dir = path.join(configDir, 'models');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

export function getModelPath(configDir: string, model: DenoiseModelEntry): string {
  return path.join(getModelsDir(configDir), model.filename);
}

export function isModelDownloaded(configDir: string, model: DenoiseModelEntry): boolean {
  const p = getModelPath(configDir, model);
  try {
    const stat = fs.statSync(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export function getModelStatus(configDir: string): Array<DenoiseModelEntry & { downloaded: boolean; localPath: string }> {
  const models = getDenoiseModels();
  return models.map(m => ({
    ...m,
    downloaded: isModelDownloaded(configDir, m),
    localPath: getModelPath(configDir, m),
  }));
}

export function deleteModel(configDir: string, modelId: string): boolean {
  const model = findDenoiseModel(modelId);
  if (!model) return false;
  const p = getModelPath(configDir, model);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function downloadModel(
  configDir: string,
  modelId: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reg = loadRegistry();
    const model = reg.models.find(m => m.id === modelId);
    if (!model) return reject(new Error(`Unknown model: ${modelId}`));

    const localPath = getModelPath(configDir, model);
    if (isModelDownloaded(configDir, model)) return resolve(localPath);

    const url = `${reg.download_base_url}/${model.filename}`;
    const tmpPath = localPath + '.tmp';

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

        const total = parseInt(res.headers['content-length'] || '0', 10) || model.size_bytes;
        let received = 0;
        const file = fs.createWriteStream(tmpPath);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0 && onProgress) {
            onProgress(Math.min(100, Math.round((received / total) * 100)));
          }
        });

        res.on('end', () => {
          file.end(() => {
            try {
              fs.renameSync(tmpPath, localPath);
              resolve(localPath);
            } catch (err) {
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

      req.setTimeout(60000, () => {
        req.destroy();
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(new Error('Download timeout'));
      });
    };

    doRequest(url, 0);
  });
}
