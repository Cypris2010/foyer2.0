// Key for encrypting display tokens. Lives outside the database so a copy of
// foyer.sqlite alone does not reveal player URLs (KONZEPT 3.3).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function loadTokenKey(dataDir: string): Buffer {
  const fromEnv = process.env.FOYER_TOKEN_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length !== 32) throw new Error('FOYER_TOKEN_KEY muss 32 Bytes (base64) lang sein');
    return key;
  }
  const file = join(dataDir, 'token.key');
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} ist beschädigt (erwartet 32 Bytes base64)`);
  return key;
}
