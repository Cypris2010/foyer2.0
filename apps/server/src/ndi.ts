// NDI live input through a separate, self-built ffmpeg (deploy/ffmpeg-ndi/build.sh).
// Upstream ffmpeg has no NDI, so the regular FOYER_FFMPEG never does this.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './crypto.ts';

export interface NdiSource {
  name: string;
  address: string;
}

function output(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env && { ...process.env, ...env } });
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

/** ndi-config.v1.json that makes the NDI runtime search these groups instead of only "public". */
export function ndiConfig(groups: string[]) {
  return { ndi: { groups: { recv: groups.join(',') } } };
}

/**
 * Sources announce themselves in NDI groups, and a receiver only finds sources in the
 * groups it searches (default "public"). The ffmpeg patch has no option for this, but
 * the NDI runtime reads ndi-config.v1.json from NDI_CONFIG_DIR. Setting it for this
 * process covers every ffmpeg started from here, including the ingest through MediaMTX.
 */
export function useNdiGroups(dir: string, groups: string[]) {
  if (!groups.length) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ndi-config.v1.json'), JSON.stringify(ndiConfig(groups), null, 2));
  process.env.NDI_CONFIG_DIR = dir;
}

/** Like useNdiGroups for a single ffmpeg (a slide's own groups): returns the NDI_CONFIG_DIR to pass it. */
export function ndiConfigDir(baseDir: string, groups: string[]): string {
  const dir = join(baseDir, `groups-${sha256(groups.join(',')).slice(0, 16)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ndi-config.v1.json'), JSON.stringify(ndiConfig(groups), null, 2));
  return dir;
}

/**
 * NDI sources visible from this server (mDNS, plus `extraIps` for other subnets), in the
 * groups of `configDir` (from ndiConfigDir) or else the process default.
 */
export async function findNdiSources(
  ffmpeg: string,
  options: { waitSeconds?: number; extraIps?: string[]; configDir?: string } = {},
): Promise<NdiSource[]> {
  const wait = options.waitSeconds ?? 3;
  const args = ['-hide_banner', '-f', 'libndi_newtek', '-find_sources', '1', '-wait_sources', String(wait)];
  if (options.extraIps?.length) args.push('-extra_ips', options.extraIps.join(','));
  args.push('-i', 'dummy');
  const { text } = await output(ffmpeg, args, (wait + 10) * 1000, options.configDir ? { NDI_CONFIG_DIR: options.configDir } : undefined);
  return parseNdiSources(text);
}
