import { app, utilityProcess } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import http from 'http';
import os from 'os';

function resolvePort(): number {
  const configPath =
    process.env.PAPERCLIP_CONFIG ||
    join(os.homedir(), '.paperclip', 'instances', 'default', 'config.json');
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (cfg?.server?.port) return Number(cfg.server.port);
  } catch (_) {}
  return parseInt(process.env.PAPERCLIP_LISTEN_PORT ?? '3100', 10);
}

function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const PORT = resolvePort();

let serverProcess: ChildProcess | ReturnType<typeof utilityProcess.fork> | null = null;
let serverIsUtilityProcess = false;
let userInitiatedStop = false;

export function spawnServer(): boolean {
  userInitiatedStop = false;

  if (app.isPackaged) {
    const serverEntry = join(process.resourcesPath, 'server', 'dist', 'index.js');
    const serverCwd = join(process.resourcesPath, 'server');
    serverIsUtilityProcess = true;

    const logDir = app.getPath('logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'server.log');
    const logStream = createWriteStream(logPath, { flags: 'a' });
    const logLine = (tag: string, data: Buffer | string) => {
      const line = `[${new Date().toISOString()}] ${tag} ${data.toString().trimEnd()}\n`;
      logStream.write(line);
      process.stdout.write(line);
    };
    logLine('INFO', `Starting embedded server: ${serverEntry}`);

    const proc = utilityProcess.fork(serverEntry, [], {
      env: {
        ...process.env,
        PAPERCLIP_LISTEN_PORT: String(PORT),
        NODE_ENV: 'production',
        PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
        PAPERCLIP_MIGRATION_PROMPT: 'never',
      },
      stdio: 'pipe',
      serviceName: 'paperclip-server',
      cwd: serverCwd,
    });

    proc.on('spawn', () => logLine('INFO', `Server spawned pid=${proc.pid}`));
    if (proc.stdout) proc.stdout.on('data', (d: Buffer) => logLine('OUT', d));
    if (proc.stderr) proc.stderr.on('data', (d: Buffer) => logLine('ERR', d));

    serverProcess = proc as unknown as ChildProcess;
    return true;
  } else {
    const repoRoot = findRepoRoot(dirname(app.getPath('exe')));
    if (!repoRoot) {
      console.error('[server] Cannot find repo root — server will not start in dev mode.');
      return false;
    }

    serverIsUtilityProcess = false;
    const proc = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERCLIP_LISTEN_PORT: String(PORT),
        PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
        PAPERCLIP_MIGRATION_PROMPT: 'never',
      },
      shell: true,
    });

    proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`));
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
    proc.on('error', (err) => console.error('[server] spawn error:', err));

    serverProcess = proc;
    return true;
  }
}

export function stopServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!serverProcess) { resolve(); return; }
    userInitiatedStop = true;
    const proc = serverProcess;
    serverProcess = null;
    proc.on('exit', () => resolve());
    if (serverIsUtilityProcess) {
      try { (proc as any).kill(); } catch (_) {}
    } else {
      const cp = proc as ChildProcess;
      const forceKill = setTimeout(() => cp.kill('SIGKILL'), 5000);
      cp.on('exit', () => clearTimeout(forceKill));
      cp.kill('SIGTERM');
    }
  });
}

export function pollReady(onReady: () => void, onTimeout: () => void): void {
  const MAX_WAIT_MS = 60_000;
  const INTERVAL_MS = 2_000;
  const startedAt = Date.now();

  const check = () => {
    if (!serverProcess) return;
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      onTimeout();
      return;
    }
    const req = http.get(
      { hostname: 'localhost', port: PORT, path: '/api/health', timeout: 1500 },
      (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) {
          onReady();
        } else {
          setTimeout(check, INTERVAL_MS);
        }
        res.resume();
      }
    );
    req.on('error', () => setTimeout(check, INTERVAL_MS));
    req.on('timeout', () => { req.destroy(); setTimeout(check, INTERVAL_MS); });
  };
  setTimeout(check, INTERVAL_MS);
}
