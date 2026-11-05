// Started by MediaMTX for one live path (live.ts): runs ffmpeg with the arguments
// from the source file, without a shell, so source addresses and NDI names reach
// ffmpeg exactly as entered. MediaMTX stops the whole process group when no
// display watches any more.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Aufruf: live-ingest.ts <quelldatei.json>');
  process.exit(2);
}
const { ffmpeg, args, env } = JSON.parse(readFileSync(file, 'utf8')) as { ffmpeg: string; args: string[]; env?: Record<string, string> };
const child = spawn(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error', (err) => {
  console.error(`Live-Quelle: ${ffmpeg} startet nicht: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
