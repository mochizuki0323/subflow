import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { ParakeetVadConfig } from './unified-config';
import { DEFAULT_PARAKEET_VAD } from './unified-config';

/** How long a backend gets to honour SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 3000;

export class BackendManager extends EventEmitter {
  private process: ChildProcess | null = null;
  /** Bumped on every spawn and every kill, so a late 'exit' can be ignored. */
  private generation = 0;
  private binaryPath: string;
  private port: number;
  private provider: string;
  private nemotronModelDir = '';
  private nemotronThreads = 2;
  private nemotronMinSilence = 1.2;
  private nemotronMaxUtterance = 15;
  private language: string;
  private parakeetModelDir: string;
  private parakeetModelType: string;
  private parakeetVadModel: string;
  private parakeetThreads = 4;
  private parakeetVad: ParakeetVadConfig;
  private remoteParakeetUrl: string;
  private remoteParakeetApiKey: string;
  private remoteParakeetModel: string;
  private denoiseEnabled = false;
  private denoiseModelPath = '';
  private denoiseArch = '';
  private modelsDir = '';
  private shouldRestart = true;
  /** Children sent a kill signal that have not reported 'exit' yet. */
  private dying = new Set<ChildProcess>();
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
    provider?: string; language?: string;
    parakeetModelDir?: string; parakeetModelType?: string; parakeetVadModel?: string; parakeetThreads?: number;
    parakeetVad?: ParakeetVadConfig;
    nemotronModelDir?: string; nemotronThreads?: number;
    nemotronMinSilence?: number; nemotronMaxUtterance?: number;
    remoteParakeetUrl?: string; remoteParakeetApiKey?: string; remoteParakeetModel?: string;
  }) {
    super();
    this.binaryPath = binaryPath;
    this.port = port;
    this.provider = options?.provider || 'parakeet';
    this.language = options?.language || 'auto';
    this.parakeetModelDir = options?.parakeetModelDir || '';
    this.parakeetModelType = options?.parakeetModelType || '';
    this.parakeetVadModel = options?.parakeetVadModel || '';
    this.parakeetThreads = options?.parakeetThreads ?? 4;
    this.parakeetVad = options?.parakeetVad || { ...DEFAULT_PARAKEET_VAD };
    this.nemotronModelDir = options?.nemotronModelDir || '';
    this.nemotronThreads = options?.nemotronThreads ?? 2;
    this.nemotronMinSilence = options?.nemotronMinSilence ?? 1.2;
    this.nemotronMaxUtterance = options?.nemotronMaxUtterance ?? 15;
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
      args.push('--parakeet-threads', String(this.parakeetThreads));
      args.push('--parakeet-vad-threshold', String(this.parakeetVad.threshold));
      args.push('--parakeet-vad-min-silence', String(this.parakeetVad.minSilence));
      args.push('--parakeet-vad-min-speech', String(this.parakeetVad.minSpeech));
      args.push('--parakeet-vad-max-speech', String(this.parakeetVad.maxSpeech));
      args.push('--parakeet-partial-interval', String(this.parakeetVad.partialInterval));
    } else if (this.provider === 'nemotron') {
      if (this.nemotronModelDir) args.push('--nemotron-model-dir', this.nemotronModelDir);
      args.push('--nemotron-threads', String(this.nemotronThreads));
      // Endpoint rules, not VAD: the streaming model endpoints itself, these
      // just set how much trailing silence closes a caption.
      args.push('--nemotron-min-silence', String(this.nemotronMinSilence));
      args.push('--nemotron-max-utterance', String(this.nemotronMaxUtterance));
    } else {
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
        // Same generation discipline as a deliberate restart. Without it this
        // timer could fire after a kill() meant to stop for good, or spawn
        // ahead of a newer restart and leave that one's guarded callback stale.
        const gen = this.generation;
        setTimeout(() => {
          if (gen === this.generation && this.shouldRestart) this.spawn();
        }, 2000);
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
    provider?: string; language?: string;
    parakeetModelDir?: string; parakeetModelType?: string; parakeetVadModel?: string; parakeetThreads?: number;
    parakeetVad?: ParakeetVadConfig;
    nemotronModelDir?: string; nemotronThreads?: number;
    nemotronMinSilence?: number; nemotronMaxUtterance?: number;
    remoteParakeetUrl?: string; remoteParakeetApiKey?: string; remoteParakeetModel?: string;
  }): void {
    if (opts.provider) this.provider = opts.provider;
    if (opts.language) this.language = opts.language;
    if (opts.parakeetModelDir !== undefined) this.parakeetModelDir = opts.parakeetModelDir;
    if (opts.parakeetModelType !== undefined) this.parakeetModelType = opts.parakeetModelType;
    if (opts.parakeetVadModel !== undefined) this.parakeetVadModel = opts.parakeetVadModel;
    if (opts.parakeetThreads !== undefined) this.parakeetThreads = opts.parakeetThreads;
    if (opts.parakeetVad !== undefined) this.parakeetVad = opts.parakeetVad;
    if (opts.nemotronModelDir !== undefined) this.nemotronModelDir = opts.nemotronModelDir;
    if (opts.nemotronThreads !== undefined) this.nemotronThreads = opts.nemotronThreads;
    if (opts.nemotronMinSilence !== undefined) this.nemotronMinSilence = opts.nemotronMinSilence;
    if (opts.nemotronMaxUtterance !== undefined) this.nemotronMaxUtterance = opts.nemotronMaxUtterance;
    if (opts.remoteParakeetUrl !== undefined) this.remoteParakeetUrl = opts.remoteParakeetUrl;
    if (opts.remoteParakeetApiKey !== undefined) this.remoteParakeetApiKey = opts.remoteParakeetApiKey;
    if (opts.remoteParakeetModel !== undefined) this.remoteParakeetModel = opts.remoteParakeetModel;
    this.kill();
    this.shouldRestart = true;
    this.spawnWhenPortIsFree();
  }

  /**
   * Spawn once every child we have asked to die actually has. They hold the
   * WebSocket port until then, and a replacement that cannot bind is worse than
   * a slower restart: rapid provider switching used to leave one process owning
   * the port while the app talked to it and waited forever for a status frame.
   *
   * Waits on the whole `dying` set rather than on the child this restart
   * happened to see, because kill() clears `process` — a second restart arriving
   * while the first child is still shutting down would otherwise find nothing to
   * wait for and spawn straight over it.
   */
  private spawnWhenPortIsFree(): void {
    const generation = this.generation;
    const go = () => {
      // A newer restart has already scheduled its own spawn; two would race.
      if (generation === this.generation) this.spawn();
    };
    const pending = [...this.dying];
    if (pending.length === 0) {
      setTimeout(go, 500);
      return;
    }
    let started = false;
    const once = () => {
      if (started) return;
      started = true;
      setTimeout(go, 100);
    };
    let remaining = pending.length;
    for (const child of pending) {
      child.once('exit', () => { if (--remaining === 0) once(); });
    }
    // Backstop: kill() escalates to SIGKILL, so outliving this means the process
    // is stuck in the kernel. Spawning into an occupied port is bad; never
    // spawning again is worse.
    setTimeout(once, KILL_GRACE_MS + 1000);
  }

  kill(): void {
    this.shouldRestart = false;
    this.shuttingDown = true;
    // Retire this generation before dropping the reference, so the child's own exit
    // handler can tell it is no longer the current backend.
    this.generation++;
    const child = this.process;
    this.process = null;
    if (!child) return;
    this.dying.add(child);
    child.once('exit', () => this.dying.delete(child));
    if (process.platform === 'win32') {
      child.kill();
    } else {
      child.kill('SIGTERM');
    }
    // A backend that ignores SIGTERM keeps the port and becomes permanent: the
    // handle is dropped above, so nothing would ever ask it again. Escalate
    // instead of leaking it.
    const hard = setTimeout(() => {
      console.warn('Backend ignored SIGTERM; sending SIGKILL');
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, KILL_GRACE_MS);
    child.once('exit', () => clearTimeout(hard));
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
