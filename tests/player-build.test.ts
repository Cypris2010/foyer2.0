import { describe, expect, it } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playerBuildReader } from '../apps/server/src/player-build.ts';
import { setup } from './helpers.ts';

const page = (script: string) => `<!doctype html><script type="module" crossorigin src="/player/assets/${script}"></script>`;

describe('Player-Version', () => {
  it('liest das Bundle aus der gebauten index.html und merkt einen Neubau', () => {
    const dist = mkdtempSync(join(tmpdir(), 'foyer-player-'));
    const read = playerBuildReader(dist);
    expect(read()).toBeNull();
    writeFileSync(join(dist, 'index.html'), page('index-AAAA1111.js'));
    expect(read()).toBe('index-AAAA1111.js');
    writeFileSync(join(dist, 'index.html'), page('index-BBBB2222.js'));
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dist, 'index.html'), later, later);
    expect(read()).toBe('index-BBBB2222.js');
  });

  it('steht im Manifest, ohne die Inhaltsversion zu ändern', async () => {
    const { app, ctx, token } = await setup();
    const before = await (await app.request(`/api/player/${token}/manifest`)).json();
    ctx.playerBuild = () => 'index-NEU.js';
    const after = await (await app.request(`/api/player/${token}/manifest`)).json();
    expect(before.playerBuild).toBeNull();
    expect(after.playerBuild).toBe('index-NEU.js');
    expect(after.version).toBe(before.version);
  });
});
