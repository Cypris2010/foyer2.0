// NDI live input through a separate, self-built ffmpeg (deploy/ffmpeg-ndi/build.sh).
// Upstream ffmpeg has no NDI, so the regular FOYER_FFMPEG never does this.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface NdiSource {
  name: string;
  address: string;
}

function output(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const collect = (chunk: Buffer) => {
      text = (text + chunk.toString()).slice(-64000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
}

/** True when `ffmpeg` exists and was built with the libndi_newtek input device. */
export async function ndiAvailable(ffmpeg: string): Promise<boolean> {
  if (!ffmpeg || (ffmpeg.includes('/') && !existsSync(ffmpeg))) return false;
  try {
    const { text } = await output(ffmpeg, ['-hide_banner', '-devices'], 5000);
    return /\blibndi_newtek\b/.test(text);
  } catch {
    return false;
  }
}

/** Lines of `-find_sources 1`: a tab, the quoted NDI name, a tab, the quoted address. */
export function parseNdiSources(text: string): NdiSource[] {
  const sources: NdiSource[] = [];
  for (const line of text.split('\n')) {
    const match = /^\t'(.+)'\t'(.*)'$/.exec(line.replace(/^\[[^\]]*\]\s?/, '').trimEnd());
    if (match) sources.push({ name: match[1], address: match[2] });
  }
  return sources;
}

/** NDI sources visible from this server (mDNS, plus `extraIps` for other subnets). */
export async function findNdiSources(ffmpeg: string, options: { waitSeconds?: number; extraIps?: string[] } = {}): Promise<NdiSource[]> {
  const wait = options.waitSeconds ?? 3;
  const args = ['-hide_banner', '-f', 'libndi_newtek', '-find_sources', '1', '-wait_sources', String(wait)];
  if (options.extraIps?.length) args.push('-extra_ips', options.extraIps.join(','));
  args.push('-i', 'dummy');
  const { text } = await output(ffmpeg, args, (wait + 10) * 1000);
  return parseNdiSources(text);
}
