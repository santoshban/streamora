import { spawn } from 'node:child_process';

export interface RunProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** stdout beyond this aborts the process. */
  maxOutputBytes?: number;
  /** Only the tail of stderr is kept. */
  maxStderrBytes?: number;
  cwd?: string;
}

export interface RunProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result?: RunProcessResult,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

/** Spawns a process without a shell and buffers its output with size and time limits. */
export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<RunProcessResult> {
  const { timeoutMs = 10 * 60_000, maxOutputBytes = 64 * 1024 * 1024, maxStderrBytes = 64 * 1024, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let failure: Error | undefined;

    const kill = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => kill(new ProcessError(`${command} timed out after ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => kill(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        kill(new ProcessError(`${command} produced more than ${maxOutputBytes} bytes of output`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxStderrBytes) stderr = stderr.slice(-maxStderrBytes);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      failure ??= err.code === 'ENOENT' ? new ProcessError(`Executable not found: ${command}`) : err;
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr });
    });
  });
}
