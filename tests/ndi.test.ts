import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ndiAvailable, ndiConfigDir, parseNdiSources, useNdiGroups } from '../apps/server/src/ndi.ts';

describe('NDI', () => {
  it('reads the source list of -find_sources', () => {
    const text = [
      '[libndi_newtek @ 0x55d0c0] Found 2 NDI sources:',
      "[libndi_newtek @ 0x55d0c0] \t'AULA-MIXER (Program)'\t'10.48.20.5:5961'",
      "\t'OBS-PC (obs-ndi Program Mix)'\t'10.48.20.9:5962'",
      'dummy: Immediate exit requested',
    ].join('\n');
    expect(parseNdiSources(text)).toEqual([
      { name: 'AULA-MIXER (Program)', address: '10.48.20.5:5961' },
      { name: 'OBS-PC (obs-ndi Program Mix)', address: '10.48.20.9:5962' },
    ]);
  });

  describe('groups', () => {
    const before = process.env.NDI_CONFIG_DIR;
    afterEach(() => {
      if (before === undefined) delete process.env.NDI_CONFIG_DIR;
      else process.env.NDI_CONFIG_DIR = before;
    });

    it('writes the receive groups to ndi-config.v1.json and points NDI_CONFIG_DIR there', () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'foyer-ndi-')), 'ndi');
      useNdiGroups(dir, ['public', 'lgstv']);
      expect(process.env.NDI_CONFIG_DIR).toBe(dir);
      expect(JSON.parse(readFileSync(join(dir, 'ndi-config.v1.json'), 'utf8'))).toEqual({ ndi: { groups: { recv: 'public,lgstv' } } });
    });

    it('gives a slide its own config directory per set of groups, without touching the process', () => {
      delete process.env.NDI_CONFIG_DIR;
      const base = mkdtempSync(join(tmpdir(), 'foyer-ndi-'));
      const dir = ndiConfigDir(base, ['lgstv']);
      expect(ndiConfigDir(base, ['lgstv'])).toBe(dir);
      expect(ndiConfigDir(base, ['public', 'lgstv'])).not.toBe(dir);
      expect(JSON.parse(readFileSync(join(dir, 'ndi-config.v1.json'), 'utf8'))).toEqual({ ndi: { groups: { recv: 'lgstv' } } });
      expect(process.env.NDI_CONFIG_DIR).toBeUndefined();
    });

    it('leaves the NDI default alone without groups', () => {
      delete process.env.NDI_CONFIG_DIR;
      useNdiGroups(join(tmpdir(), 'foyer-ndi-unused'), []);
      expect(process.env.NDI_CONFIG_DIR).toBeUndefined();
    });
  });

  it('is unavailable without the NDI ffmpeg', async () => {
    expect(await ndiAvailable('')).toBe(false);
    expect(await ndiAvailable('/does/not/exist/ffmpeg')).toBe(false);
    // The regular ffmpeg has no NDI (removed upstream in 2019).
    expect(await ndiAvailable('ffmpeg')).toBe(false);
  });
});
