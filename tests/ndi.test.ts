import { describe, expect, it } from 'vitest';
import { ndiAvailable, parseNdiSources } from '../apps/server/src/ndi.ts';

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

  it('is unavailable without the NDI ffmpeg', async () => {
    expect(await ndiAvailable('')).toBe(false);
    expect(await ndiAvailable('/does/not/exist/ffmpeg')).toBe(false);
    // The regular ffmpeg has no NDI (removed upstream in 2019).
    expect(await ndiAvailable('ffmpeg')).toBe(false);
  });
});
