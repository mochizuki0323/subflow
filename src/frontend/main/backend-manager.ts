import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export class BackendManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private binaryPath: string;
  private port: number;
  private apiKey: string;
  private model: string;
  private extraParams: string;
  private language: string;
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

  constructor(binaryPath: string, port: number, apiKey?: string, model?: string, extraParams?: string, language?: string) {
    super();
    this.binaryPath = binaryPath;
    this.port = port;
    this.apiKey = apiKey || '';
    this.model = model || 'nova-3';
    this.extraParams = extraParams || '';
    this.language = language || 'auto';
  }

  spawn(): void {
    if (this.process) return;

    this.shuttingDown = false;

    const args = ['--port', String(this.port)];
    if (this.apiKey) {
      args.push('--api-key', this.apiKey);
    }
    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.extraParams) {
      args.push('--extra-params', this.extraParams);
    }
    if (this.language && this.language !== 'auto') {
      args.push('--language', this.language);
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

    this.process.on('exit', (code, signal) => {
      const hexCode = code === null ? 'null' : `0x${code.toString(16).toUpperCase()}`;
      let hint = '';
      if (code === 3221225781) {
        hint = ' (STATUS_DLL_NOT_FOUND: backend binary is missing runtime DLL dependency)';
      }
      console.log(`Backend exited: code=${code} (${hexCode}), signal=${signal}${hint}`);
      if (!this.shuttingDown) {
        this.emit('log', `Backend exited: code=${code} (${hexCode}), signal=${signal}${hint}`);
      }
      this.process = null;

      if (this.shouldRestart && code !== 0) {
        console.log('Restarting backend in 2 seconds...');
        setTimeout(() => this.spawn(), 2000);
      }
    });

    this.process.on('error', (err) => {
      console.error(`Backend spawn error: ${err.message}`);
      if (!this.shuttingDown) {
        this.emit('log', `Backend spawn error: ${err.message}`);
      }
      this.process = null;
    });
  }

  restart(apiKey: string, model?: string, extraParams?: string, language?: string): void {
    this.apiKey = apiKey;
    if (model) this.model = model;
    if (extraParams !== undefined) this.extraParams = extraParams;
    if (language) this.language = language;
    this.kill();
    this.shouldRestart = true; // re-enable auto-restart for the new process
    setTimeout(() => this.spawn(), 500);
  }

  kill(): void {
    this.shouldRestart = false;
    this.shuttingDown = true;
    if (this.process) {
      if (process.platform === 'win32') {
        this.process.kill();
      } else {
        this.process.kill('SIGTERM');
      }
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
