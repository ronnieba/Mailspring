/**
 * Host for the marked mock AI worker. Fixed executable + args; UTF-8 JSON on
 * stdin; never shell. Query and mail bodies are not argv. Kill is local
 * cancellation — it does not complete remote generation.
 */
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import * as path from 'path';
import { AIBoundaryResult, validateProviderPayload, AIValidateContext } from './ai-boundary';

export const MOCK_AI_WORKER_PATH = path.join(__dirname, 'mock-ai-worker.js');

export type MockAiOp =
  | 'ok'
  | 'delay'
  | 'hang'
  | 'invalid-schema'
  | 'unknown-citation'
  | 'not-mock'
  | 'bidi-citation';

export interface MockAiRequest {
  op: MockAiOp;
  generation: number;
  query: string;
  allowedSourceIds: string[];
  delayMs?: number;
  unknownId?: string;
}

export function mockAiSpawnPlan(): { execPath: string; args: string[]; options: SpawnOptions } {
  return {
    execPath: process.execPath,
    args: [MOCK_AI_WORKER_PATH],
    options: {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG || 'C.UTF-8',
        ELECTRON_RUN_AS_NODE: '1',
      },
    },
  };
}

function terminate(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    proc.once('exit', done);
    try {
      proc.kill('SIGTERM');
    } catch {
      done();
      return;
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
      setTimeout(done, 50);
    }, 200);
  });
}

export async function runMockAiSubprocess(
  request: MockAiRequest,
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    currentGeneration: () => number;
  }
): Promise<AIBoundaryResult> {
  const plan = mockAiSpawnPlan();
  const proc = spawn(plan.execPath, plan.args, plan.options);
  if (proc.stdin) {
    proc.stdin.setDefaultEncoding('utf8');
  }
  if (proc.stdout) {
    proc.stdout.setEncoding('utf8');
  }

  const ctxBase = (): AIValidateContext => ({
    allowedSourceIds: new Set(request.allowedSourceIds),
    startedGeneration: request.generation,
    currentGeneration: opts.currentGeneration(),
    aborted: !!opts.signal?.aborted,
  });

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = async (result: AIBoundaryResult) => {
      if (settled) {
        return;
      }
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      await terminate(proc);
      resolve(result);
    };

    const onAbort = () => {
      void finish({
        ok: false,
        origin: 'local',
        reason: 'cancelled',
        message: 'Local cancellation — no remote generation completed',
      });
    };

    const timer = setTimeout(() => {
      void finish({
        ok: false,
        origin: 'local',
        reason: 'timeout',
        message: `Local timeout ${opts.timeoutMs}ms — no remote generation completed`,
      });
    }, opts.timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
    }

    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const nl = stdout.indexOf('\n');
      if (nl < 0) {
        return;
      }
      const line = stdout.slice(0, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        void finish({
          ok: false,
          origin: 'local',
          reason: 'invalid-schema',
          message: 'worker stdout is not JSON',
        });
        return;
      }
      const payload = parsed && typeof parsed === 'object' ? (parsed as any).payload : undefined;
      void finish(validateProviderPayload(payload, ctxBase()));
    });

    proc.on('error', (err) => {
      void finish({
        ok: false,
        origin: 'local',
        reason: 'invalid-schema',
        message: `worker spawn failed: ${err.message}`,
      });
    });

    const body = `${JSON.stringify({ id: 1, ...request })}\n`;
    try {
      proc.stdin?.write(Buffer.from(body, 'utf8'));
      proc.stdin?.end();
    } catch (err: any) {
      void finish({
        ok: false,
        origin: 'local',
        reason: 'invalid-schema',
        message: `stdin write failed: ${err && err.message}`,
      });
    }
  });
}
