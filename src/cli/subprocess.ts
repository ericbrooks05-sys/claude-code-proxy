import { spawn, type ChildProcess } from 'node:child_process';
import type { CliEvent } from '../protocol/cli-types.js';
import { parseCliStream } from './stream-parser.js';
import { logger } from '../util/logger.js';

export interface SubprocessResult {
  events: AsyncGenerator<CliEvent>;
  kill: () => void;
  process: ChildProcess;
}

// FIFO queue — serialize CLI spawns to prevent OAuth token rotation conflicts
let queueTail: Promise<void> = Promise.resolve();

/**
 * Queued wrapper around spawnCli. Only one claude process runs at a time.
 * Requests queue in FIFO order and wait for the previous to exit.
 */
export async function spawnCliQueued(
  args: string[],
  prompt: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<SubprocessResult> {
  const previousDone = queueTail;
  let releaseSlot!: () => void;
  queueTail = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });

  await previousDone;
  logger.debug('Queue slot acquired, spawning CLI');

  const result = spawnCli(args, prompt, timeoutMs, extraEnv);

  // Release slot when process exits (idempotent)
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      releaseSlot();
    }
  };
  result.process.on('exit', release);
  result.process.on('error', release);
  // Safety net: release after timeout + grace period even if process hangs
  setTimeout(release, timeoutMs + 15000);

  return result;
}

export function spawnCli(args: string[], prompt: string, timeoutMs: number, extraEnv?: Record<string, string>): SubprocessResult {
  const command = args[0];
  const spawnArgs = args.slice(1);

  logger.debug('Spawning CLI', { command, args: spawnArgs });

  const proc = spawn(command, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      TERM: process.env.TERM,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      ...extraEnv,
    },
  });

  // Write prompt via stdin and close
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Capture stderr for logging
  const MAX_STDERR = 4096;
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    if (stderr.length > MAX_STDERR) {
      stderr = stderr.slice(-MAX_STDERR);
    }
    logger.debug('CLI stderr', { text: text.trim() });
  });

  // Setup timeout
  let forceKillId: NodeJS.Timeout | undefined;
  const timeoutId = setTimeout(() => {
    logger.warn('CLI process timed out, killing', { pid: proc.pid, timeoutMs });
    proc.kill('SIGTERM');
    // Force kill after 5 seconds if SIGTERM didn't work
    forceKillId = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }, timeoutMs);

  let killed = false;

  const kill = (): void => {
    if (killed) return;
    killed = true;
    clearTimeout(timeoutId);
    clearTimeout(forceKillId);
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
  };

  // Wrap the event generator to handle cleanup
  async function* eventGenerator(): AsyncGenerator<CliEvent> {
    try {
      if (!proc.stdout) {
        throw new Error('CLI process stdout is null');
      }
      yield* parseCliStream(proc.stdout);
    } finally {
      clearTimeout(timeoutId);
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    }
  }

  // Log process exit
  proc.on('exit', (code, signal) => {
    clearTimeout(timeoutId);
    clearTimeout(forceKillId);
    logger.debug('CLI process exited', { code, signal, pid: proc.pid });
    if (code !== 0 && code !== null && !killed) {
      logger.error('CLI process exited with error', {
        code,
        signal,
        stderr: stderr.slice(-1000),
      });
    }
  });

  proc.on('error', (err) => {
    clearTimeout(timeoutId);
    logger.error('CLI process error', {
      error: err.message,
      code: (err as NodeJS.ErrnoException).code,
    });
  });

  return {
    events: eventGenerator(),
    kill,
    process: proc,
  };
}
