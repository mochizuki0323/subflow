import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { pipeline } from 'stream/promises';
import unbzip2 from 'unbzip2-stream';
import tar from 'tar-stream';

export interface ParakeetModelEntry {
  id: string;
  archive: string;
  dir_name: string;
  type: string;
  files: Record<string, string>;
  languages: string[];
  archive_size_bytes: number;
  description_en: string;
  description_zh: string;
}

interface VadInfo {
  filename: string;
  size_bytes: number;
}

interface ParakeetModelRegistry {
  version: number;
  download_base_url: string;
  vad: VadInfo;
  models: ParakeetModelEntry[];
}

let registry: ParakeetModelRegistry | null = null;

function loadRegistry(): ParakeetModelRegistry {
  if (registry) return registry;

  const candidates = [
    path.join(__dirname, '../../src/shared/parakeet-models.json'),
    path.join(__dirname, '../shared/parakeet-models.json'),
    path.join(process.resourcesPath ?? '', 'shared', 'parakeet-models.json'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        registry = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return registry!;
      }
    } catch { /* try next */ }
  }

  registry = { version: 1, download_base_url: '', vad: { filename: 'silero_vad.onnx', size_bytes: 0 }, models: [] };
  return registry;
}

export function getParakeetModels(): ParakeetModelEntry[] {
  return loadRegistry().models;
}

export function findParakeetModel(modelId: string): ParakeetModelEntry | undefined {
  return loadRegistry().models.find(m => m.id === modelId);
}

export function getParakeetModelsDir(configDir: string): string {
  const dir = path.join(configDir, 'models', 'parakeet');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

export function getParakeetModelDir(configDir: string, model: ParakeetModelEntry): string {
  return path.join(getParakeetModelsDir(configDir), model.dir_name);
}

export function isParakeetModelDownloaded(configDir: string, model: ParakeetModelEntry): boolean {
  const dir = getParakeetModelDir(configDir, model);
  try {
    const tokensPath = path.join(dir, model.files.tokens || 'tokens.txt');
    return fs.existsSync(tokensPath);
  } catch {
    return false;
  }
}

export function getParakeetModelStatus(configDir: string): Array<ParakeetModelEntry & { downloaded: boolean; localDir: string }> {
  const models = getParakeetModels();
  return models.map(m => ({
    ...m,
    downloaded: isParakeetModelDownloaded(configDir, m),
    localDir: getParakeetModelDir(configDir, m),
  }));
}

export function deleteParakeetModel(configDir: string, modelId: string): boolean {
  const model = findParakeetModel(modelId);
  if (!model) return false;
  const dir = getParakeetModelDir(configDir, model);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function getVadModelPath(configDir: string): string {
  const reg = loadRegistry();
  return path.join(getParakeetModelsDir(configDir), reg.vad.filename);
}

export function isVadModelDownloaded(configDir: string): boolean {
  try {
    const p = getVadModelPath(configDir);
    const stat = fs.statSync(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export function downloadVadModel(
  configDir: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reg = loadRegistry();
    const localPath = getVadModelPath(configDir);
    if (isVadModelDownloaded(configDir)) return resolve(localPath);

    const url = `${reg.download_base_url}/${reg.vad.filename}`;
    const tmpPath = localPath + '.tmp';

    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      const lib = requestUrl.startsWith('https') ? https : http;
      const req = lib.get(requestUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`VAD download failed: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10) || reg.vad.size_bytes;
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
            } catch (err) { reject(err); }
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
        reject(new Error('VAD download timeout'));
      });
    };

    doRequest(url, 0);
  });
}

// Exported for the Nemotron manager: both registries ship the same tar.bz2
// layout from the same release, and this is pure-JS so it stays cross-platform.
export async function extractTarBz2(archivePath: string, destDir: string): Promise<void> {
  const extract = tar.extract();
  const dirs = new Set<string>();

  extract.on('entry', (header, stream, next) => {
    const entryPath = path.join(destDir, header.name);

    if (header.type === 'directory') {
      fs.mkdirSync(entryPath, { recursive: true });
      dirs.add(entryPath);
      stream.resume();
      next();
    } else if (header.type === 'file') {
      const dir = path.dirname(entryPath);
      if (!dirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        dirs.add(dir);
      }
      const ws = fs.createWriteStream(entryPath);
      stream.pipe(ws);
      ws.on('finish', next);
      ws.on('error', next);
    } else {
      stream.resume();
      next();
    }
  });

  await pipeline(
    fs.createReadStream(archivePath),
    unbzip2(),
    extract,
  );
}

export function downloadParakeetModel(
  configDir: string,
  modelId: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reg = loadRegistry();
    const model = reg.models.find(m => m.id === modelId);
    if (!model) return reject(new Error(`Unknown model: ${modelId}`));

    const modelDir = getParakeetModelDir(configDir, model);
    if (isParakeetModelDownloaded(configDir, model)) return resolve(modelDir);

    const url = `${reg.download_base_url}/${model.archive}`;
    const modelsDir = getParakeetModelsDir(configDir);
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
          if (total > 0 && onProgress) {
            // Reserve 90% for download, 10% for extraction
            onProgress(Math.min(90, Math.round((received / total) * 90)));
          }
        });

        res.on('end', () => {
          file.end(async () => {
            try {
              // Rename tmp to final archive path
              const archivePath = path.join(modelsDir, model.archive);
              fs.renameSync(tmpPath, archivePath);

              // Extract
              onProgress?.(92);
              await extractTarBz2(archivePath, modelsDir);
              onProgress?.(98);

              // Remove archive after extraction
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

    doRequest(url, 0);
  });
}
