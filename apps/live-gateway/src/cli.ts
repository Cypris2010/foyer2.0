// Live gateway CLI:
//   ndi:sources [ip,…] [--groups g,…]   NDI sources this gateway sees (needs the NDI ffmpeg)
import { join } from 'node:path';
import { config } from './config.ts';
import { findNdiSources, ndiAvailable, useNdiGroups } from './ndi.ts';

const [command, ...args] = process.argv.slice(2);

async function listNdi() {
  if (!(await ndiAvailable(config.ffmpegNdi))) {
    throw new Error('Kein ffmpeg mit NDI gefunden. Bauen mit deploy/ffmpeg-ndi/build.sh, Pfad über FOYER_FFMPEG_NDI.');
  }
  const split = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);
  const groupsAt = args.indexOf('--groups');
  const groups = groupsAt >= 0 ? split(args[groupsAt + 1] ?? '') : config.ndiGroups;
  const ips = args.find((arg, i) => !arg.startsWith('--') && i !== groupsAt + 1);
  const extraIps = ips ? split(ips) : config.ndiExtraIps;
  useNdiGroups(join(config.dir, 'ndi'), groups);
  const sources = await findNdiSources(config.ffmpegNdi, { extraIps });
  if (groups.length) console.log(`Gruppen: ${groups.join(', ')}`);
  if (!sources.length) console.log('Keine NDI-Quellen gefunden (gleiches Netz? Quellen in anderen Subnetzen als IP angeben, andere Gruppen mit --groups).');
  for (const source of sources) console.log(`  ${source.name}  (${source.address})`);
}

try {
  if (command === 'ndi:sources') await listNdi();
  else console.log('Befehle: ndi:sources [ip,…] [--groups g,…]');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
