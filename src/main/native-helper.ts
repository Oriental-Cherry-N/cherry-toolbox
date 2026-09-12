import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { NATIVE_HELPER_RELATIVE_PATH, NATIVE_HELPER_SHA256 } from './native-manifest';

// Both values come from this process's compiled module, never from a mutable disk manifest.
const pinnedHelperPath = path.resolve(__dirname, '../../native/bin', NATIVE_HELPER_RELATIVE_PATH)
  .replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
let helperDiagnostic: string | null = null;

export function nativeHelperDiagnostics(): string | null { return helperDiagnostic; }

export async function nativeHelperPath(): Promise<string> {
  let actualHash = 'unreadable';
  try {
    if (NATIVE_HELPER_RELATIVE_PATH !== `helpers/${NATIVE_HELPER_SHA256}/CherryToolbox.Helper.exe` || !/^[a-f0-9]{64}$/u.test(NATIVE_HELPER_SHA256)) {
      throw new Error('Invalid compiled helper manifest.');
    }
    actualHash = createHash('sha256').update(await readFile(pinnedHelperPath)).digest('hex');
    if (actualHash !== NATIVE_HELPER_SHA256) throw new Error('SHA-256 mismatch.');
  } catch (error) {
    helperDiagnostic = [
      'CHERRY_HELPER_INTEGRITY', `Runtime: ${process.execPath}`, `Module: ${__dirname}`,
      `Helper: ${pinnedHelperPath}`, `Expected SHA-256: ${NATIVE_HELPER_SHA256}`,
      `Actual SHA-256: ${actualHash}`, `Cause: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n');
    throw new Error('安全辅助程序缺失或完整性校验失败，操作已停止。请退出后重新启动源码程序，或重新安装完整版本。可展开下方诊断信息。');
  }
  helperDiagnostic = null;
  return pinnedHelperPath;
}

export interface NativeEvent { type: string; [key: string]: unknown }

export async function startNativeHelper(
  mode: 'job' | 'proxy',
  configuration: Record<string, unknown>,
  event: (value: NativeEvent) => void = () => undefined,
): Promise<{ child: ChildProcessWithoutNullStreams; ready: NativeEvent }> {
  const executable = await nativeHelperPath();
  const child = spawn(executable, [mode], { stdio: 'pipe', windowsHide: true });
  child.stdin.on('error', () => { /* Exit and the independent heartbeat provide the failure signal. */ });
  const lines = createInterface({ input: child.stdout });
  let readyReceived = false;
  const ready = new Promise<NativeEvent>((resolve, reject) => {
    const timeout = setTimeout(() => { child.stdin.end(); reject(new Error('The Windows safety helper did not become ready.')); }, 15000);
    const finish = (error?: Error, value?: NativeEvent): void => {
      clearTimeout(timeout); child.off('error', fail); child.off('exit', exited);
      if (error) reject(error); else { readyReceived = true; resolve(value as NativeEvent); }
    };
    const fail = (error: Error): void => finish(error);
    const exited = (): void => finish(new Error('The Windows safety helper exited before it was ready.'));
    child.once('error', fail); child.once('exit', exited);
    lines.on('line', (line) => {
      try {
        if (line.length > 1048576) throw new Error('Oversized helper response.');
        const value: unknown = JSON.parse(line);
        if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') return;
        const message = value as NativeEvent;
        if (message.type === 'helper-ready' && !readyReceived) finish(undefined, message);
        else if (message.type === 'error' && !readyReceived) finish(new Error(String(message.message)));
        event(message);
      } catch (error) { child.stdin.end(); if (!readyReceived) finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
  const heartbeat = setInterval(() => { if (child.stdin.writable) child.stdin.write('{"type":"heartbeat"}\n'); }, 1000);
  heartbeat.unref();
  child.once('exit', () => { clearInterval(heartbeat); lines.close(); });
  child.stdin.write(JSON.stringify(configuration) + '\n');
  try { return { child, ready: await ready }; }
  catch (error) { clearInterval(heartbeat); child.stdin.end(); throw error; }
}

export function stopNativeHelper(child: ChildProcessWithoutNullStreams, timeoutMs = 15000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // Process exit closes the Job and sockets. Callers still verify owned files separately.
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => { clearTimeout(timer); child.off('exit', onExit); error ? reject(error) : resolve(); };
    const onExit = (): void => finish();
    const timer = setTimeout(() => finish(new Error('The helper is still cleaning up. Its recovery handle has been retained.')), timeoutMs);
    child.once('exit', onExit);
    if (child.stdin.writable) child.stdin.end('{"type":"stop"}\n');
  });
}
