// Which player bundle the server currently serves: the hash-named script in the
// built index.html. Players compare it with their own and reload after updates.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function playerBuildReader(playerDist: string): () => string | null {
  const file = join(playerDist, 'index.html');
  let cached: { mtime: number; build: string | null } | null = null;
  return () => {
    try {
      // Re-read only when the file changed, e.g. after "npm run build" on a running server.
      const mtime = statSync(file).mtimeMs;
      if (cached?.mtime !== mtime) {
        const match = /\/player\/assets\/([\w.-]+\.js)/.exec(readFileSync(file, 'utf8'));
        cached = { mtime, build: match ? match[1] : null };
      }
      return cached.build;
    } catch {
      return null; // not built (tests, development)
    }
  };
}
