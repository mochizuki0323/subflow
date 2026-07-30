import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { ParakeetVadConfig } from './unified-config';
import { DEFAULT_PARAKEET_VAD } from './unified-config';

export class BackendManager extends EventEmitter {
  private process: ChildProcess | null = null;
  /** Bumped on every spawn and every kill, so a late 'exit' can be ignored. */
  private generation = 0;
  private binaryPath: string;
  private port: number;
  private provider: string;
  private apiKey: string;
  private model: string;
  private extraParams: string;
  private language: string;
  private gladiaApiKey: string;
  private gladiaModel: string;
  private gladiaConfig: string;
  private parakeetModelDir: string;
  private parakeetModelType: string;
  private parakeetVadModel: string;
  private parakeetVad: ParakeetVadConfig;
  private remoteParakeetUrl: string;
  private remoteParakeetApiKey: string;
  private remoteParakeetModel: string;
  private denoiseEnabled = false;
  private denoiseModelPath = '';
  private denoiseArch = '';
  private modelsDir = '';
  private shouldRestart = true;
  /** When true, child stderr/exit must not emit `log` (windows may already be destroyed). */
  private shuttingDown = false;

  private resolveCertFile(): string | undefined {
    const existing = process.env.SSL_CERT_FILE;
    if (existing && fs.existsSync(existing)) {
      return existing;
    }

    const candidates: string[] = [];
    candidates.push(path.join(path.dirname(this.binaryPath), 'cacert.pem'));

    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      candidates.push(path.join(resourcesPath, 'bin', 'cacert.pem'));
    }

    for (const certFile of candidates) {
      if (fs.existsSync(certFile)) {
        return certFile;
      }
    }
    return undefined;
  }

  constructor(binaryPath: string, port: number, options?: {
    provider?: string; apiKey?: string; model?: string; extraParams?: string;
    language?: string; gladiaApiKey?: string; gladiaModel?: string; gladiaConfig?: string;
    parakeetModelDir?: string; parakeetModelType?: string; parakeetVadModel?: string;
    parakeetVad?: ParakeetVadConfig;
    remoteParakeetUrl?: string; remoteParakeetApiKey?: string; remoteParakeetModel?: string;
  }) {
    super();
    this.binaryPath = binaryPath;
    this.port = port;
    this.provider = options?.provider || 'deepgram';
    this.apiKey = options?.apiKey || '';
    this.model = options?.model || 'nova-3';
    this.extraParams = options?.extraParams || '';
    this.language = options?.language || 'auto';
    this.gladiaApiKey = options?.gladiaApiKey || '';
    this.gladiaModel = options?.gladiaModel || 'solaria-1';
    this.gladiaConfig = options?.gladiaConfig || '';
    this.parakeetModelDir = options?.parakeetModelDir || '';
    this.parakeetModelType = options?.parakeetModelType || '';
    this.parakeetVadModel = options?.parakeetVadModel || '';
    this.parakeetVad = options?.parakeetVad || { ...DEFAULT_PARAKEET_VAD };
    this.remoteParakeetUrl = options?.remoteParakeetUrl || '';
    this.remoteParakeetApiKey = options?.remoteParakeetApiKey || '';
    this.remoteParakeetModel = options?.remoteParakeetModel || '';
  }

  spawn(): void {
    if (this.process) return;

    this.shuttingDown = false;
    this.generation++;

    const args = ['--port', String(this.port), '--provider', this.provider];
    if (this.provider === 'parakeet') {
      if (this.parakeetModelDir) args.push('--parakeet-model-dir', this.parakeetModelDir);
      if (this.parakeetModelType) args.push('--parakeet-model-type', this.parakeetModelType);
      if (this.parakeetVadModel) args.push('--parakeet-vad-model', this.parakeetVadModel);
      args.push('--parakeet-vad-threshold', String(this.parakeetVad.threshold));
      args.push('--parakeet-vad-min-silence', String(this.parakeetVad.minSilence));
      args.push('--parakeet-vad-min-speech', String(this.parakeetVad.minSpeech));
      args.push('--parakeet-vad-max-speech', String(this.parakeetVad.maxSpeech));
      args.push('--parakeet-partial-interval', String(this.parakeetVad.partialInterval));
    } else if (this.provider === 'gladia') {
      if (this.gladiaApiKey) args.push('--gladia-api-key', this.gladiaApiKey);
      if (this.gladiaModel) args.push('--gladia-model', this.gladiaModel);
      if (this.gladiaConfig) args.push('--gladia-config', this.gladiaConfig);
    } else if (this.provider === 'remote_parakeet') {
      if (this.remoteParakeetUrl) args.push('--remote-parakeet-url', this.remoteParakeetUrl);
      if (this.remoteParakeetApiKey) args.push('--remote-parakeet-api-key', this.remoteParakeetApiKey);
      if (this.remoteParakeetModel) args.push('--remote-parakeet-model', this.remoteParakeetModel);
      // Server-side VAD is tuned per client; ship the initial values (reuses the
      // same --parakeet-vad-* flags the local provider uses).
      args.push('--parakeet-vad-threshold', String(this.parakeetVad.threshold));
      args.push('--parakeet-vad-min-silence', String(this.parakeetVad.minSilence));
      args.push('--parakeet-vad-min-speech', String(this.parakeetVad.minSpeech));
      args.push('--parakeet-vad-max-speech', String(this.parakeetVad.maxSpeech));
      args.push('--parakeet-partial-interval', String(this.parakeetVad.partialInterval));
    } else {
      if (this.apiKey) args.push('--api-key', this.apiKey);
      if (this.model) args.push('--model', this.model);
      if (this.extraParams) args.push('--extra-params', this.extraParams);
    }
    if (this.language && this.language !== 'auto') {
      args.push('--language', this.language);
    }
    if (this.denoiseEnabled && this.denoiseModelPath) {
      args.push('--denoise', '--denoise-model', this.denoiseModelPath, '--denoise-arch', this.denoiseArch);
    }
    if (this.modelsDir) {
      args.push('--models-dir', this.modelsDir);
    }

    console.log(`Spawning backend: ${this.binaryPath} ${args.join(' ')}`);

    const certFile = this.resolveCertFile();
    const env = {
      ...process.env,
      ...(certFile ? { SSL_CERT_FILE: certFile } : {}),
    };
    if (certFile) {
      console.log(`Using SSL_CERT_FILE: ${certFile}`);
    }

    this.process = spawn(this.binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[backend] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      console.error(`[backend] ${line}`);
      if (!this.shuttingDown) {
        this.emit('log', line);
      }
    });

    // A child killed by restart() can take longer to exit than the 500 ms respawn
    // delay. Without this tag its late 'exit' would null out the reference to the
    // process that already replaced it and schedule yet another spawn, leaving an
    // orphan holding the port and the audio device.
    const generation = this.generation;

    this.process.on('exit', (code, signal) => {
      const hexCode = code === null ? 'null' : `0x${code.toString(16).toUpperCase()}`;
      let hint = '';
      if (code === 3221225781) {
        hint = ' (STATUS_DLL_NOT_FOUND: backend binary is missing runtime DLL dependency)';
      }
      console.log(`Backend exited: code=${code} (${hexCode}), signal=${signal}${hint}`);
      if (generation !== this.generation) {
        console.log('  (stale generation — a newer backend has already taken over)');
        return;
      }
      if (!this.shuttingDown) {
        this.emit('log', `Backend exited: code=${code} (${hexCode}), signal=${signal}${hint}`);
      }
      this.process = null;
      this.emit('exited', code);

      if (this.shouldRestart && code !== 0) {
        console.log('Restarting backend in 2 seconds...');
        setTimeout(() => this.spawn(), 2000);
      }
    });

    this.process.on('error', (err) => {
      console.error(`Backend spawn error: ${err.message}`);
      if (generation !== this.generation) return;
      if (!this.shuttingDown) {
        this.emit('log', `Backend spawn error: ${err.message}`);
      }
      this.process = null;
      this.emit('exited', null);
    });
  }

  setDenoiseParams(enabled: boolean, modelPath: string, arch: string, modelsDir: string): void {
    this.denoiseEnabled = enabled;
    this.denoiseModelPath = modelPath;
    this.denoiseArch = arch;
    this.modelsDir = modelsDir;
  }

  /** Update stored VAD params so a later restart re-applies them via CLI args. */
  setParakeetVadParams(vad: ParakeetVadConfig): void {
    this.parakeetVad = { ...vad };
  }

  restart(opts: {
    provider?: string; apiKey?: string; model?: string; extraParams?: string;
    language?: string; gladiaApiKey?: string; gladiaModel?: string; gladiaConfig?: string;
    parakeetModelDir?: string; parakeetModelType?: string; parakeetVadModel?: string;
    parakeetVad?: ParakeetVadConfig;
    remoteParakeetUrl?: string; remoteParakeetApiKey?: string; remoteParakeetModel?: string;
  }): void {
    if (opts.provider) this.provider = opts.provider;
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
    if (opts.model) this.model = opts.model;
    if (opts.extraParams !== undefined) this.extraParams = opts.extraParams;
    if (opts.language) this.language = opts.language;
    if (opts.gladiaApiKey !== undefined) this.gladiaApiKey = opts.gladiaApiKey;
    if (opts.gladiaModel) this.gladiaModel = opts.gladiaModel;
    if (opts.gladiaConfig !== undefined) this.gladiaConfig = opts.gladiaConfig;
    if (opts.parakeetModelDir !== undefined) this.parakeetModelDir = opts.parakeetModelDir;
    if (opts.parakeetModelType !== undefined) this.parakeetModelType = opts.parakeetModelType;
    if (opts.parakeetVadModel !== undefined) this.parakeetVadModel = opts.parakeetVadModel;
    if (opts.parakeetVad !== undefined) this.parakeetVad = opts.parakeetVad;
    if (opts.remoteParakeetUrl !== undefined) this.remoteParakeetUrl = opts.remoteParakeetUrl;
    if (opts.remoteParakeetApiKey !== undefined) this.remoteParakeetApiKey = opts.remoteParakeetApiKey;
    if (opts.remoteParakeetModel !== undefined) this.remoteParakeetModel = opts.remoteParakeetModel;
    this.kill();
    this.shouldRestart = true;
    setTimeout(() => this.spawn(), 500);
  }

  kill(): void {
    this.shouldRestart = false;
    this.shuttingDown = true;
    // Retire this generation before dropping the reference, so the child's own exit
    // handler can tell it is no longer the current backend.
    this.generation++;
    const child = this.process;
    this.process = null;
    if (child) {
      if (process.platform === 'win32') {
        child.kill();
      } else {
        child.kill('SIGTERM');
      }
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
