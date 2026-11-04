// Discovers slide types: every folder in slide-types/ with an index.ts.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { SlideServer, SlideTypeDefinition } from '@foyer/slide-sdk';

export interface RegisteredSlideType {
  definition: SlideTypeDefinition;
  server: SlideServer<any, any>;
  jsonSchema: unknown;
}

export type Registry = Map<string, RegisteredSlideType>;

export async function loadRegistry(slideTypesDir: string): Promise<Registry> {
  const registry: Registry = new Map();
  const folders = readdirSync(slideTypesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const folder of folders) {
    const base = join(slideTypesDir, folder.name);
    const indexFile = join(base, 'index.ts');
    if (!existsSync(indexFile)) continue;
    const definition: SlideTypeDefinition = (await import(pathToFileURL(indexFile).href)).default;
    if (!definition?.id) throw new Error(`slide-types/${folder.name}/index.ts exportiert keine Definition`);
    if (definition.id !== folder.name) {
      throw new Error(`Folientyp-ID "${definition.id}" muss dem Ordnernamen "${folder.name}" entsprechen`);
    }
    const serverFile = join(base, 'server.ts');
    const server: SlideServer = existsSync(serverFile) ? (await import(pathToFileURL(serverFile).href)).default : {};
    registry.set(definition.id, {
      definition,
      server,
      jsonSchema: z.toJSONSchema(definition.config, { io: 'input' }),
    });
  }
  return registry;
}

/** Validates and fills defaults; throws a ZodError on invalid config. */
export function parseConfig(registry: Registry, type: string, config: unknown): unknown {
  const entry = registry.get(type);
  if (!entry) throw new Error(`Unbekannter Folientyp: ${type}`);
  return entry.definition.config.parse(config ?? {});
}
