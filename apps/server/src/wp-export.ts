// Reads the slides of a wp-foyer installation from a WordPress export file (WXR), made
// under Werkzeuge → Daten exportieren → Alle Inhalte.
import { SaxesParser } from 'saxes';
import type { WpData, WpSlide } from './wp-import.ts';

interface Item {
  fields: Record<string, string>;
  meta: Record<string, string>;
}

function readItems(xml: string): { items: Item[]; channel: Record<string, string> } {
  const items: Item[] = [];
  const channel: Record<string, string> = {};
  const parser = new SaxesParser();
  const path: string[] = [];
  let item: Item | null = null;
  let metaKey = '';
  let metaValue = '';
  let text = '';

  parser.on('opentag', (tag) => {
    path.push(tag.name);
    text = '';
    if (tag.name === 'item') item = { fields: {}, meta: {} };
  });
  parser.on('text', (chunk) => {
    text += chunk;
  });
  parser.on('cdata', (chunk) => {
    text += chunk;
  });
  parser.on('closetag', (tag) => {
    path.pop();
    const parent = path.at(-1);
    if (parent === 'channel' && tag.name !== 'item') channel[tag.name] = text;
    if (parent === 'item' && item) item.fields[tag.name] = text;
    if (parent === 'wp:postmeta' && tag.name === 'wp:meta_key') metaKey = text;
    if (parent === 'wp:postmeta' && tag.name === 'wp:meta_value') metaValue = text;
    if (parent === 'item' && tag.name === 'wp:postmeta' && item) item.meta[metaKey] = metaValue;
    if (tag.name === 'item' && item) {
      items.push(item);
      item = null;
    }
    text = '';
  });
  parser.write(xml).close();
  return { items, channel };
}

export function readWordPressExport(xml: string): WpData {
  const { items, channel } = readItems(xml);
  if (!channel['wp:wxr_version']) throw new Error('Das ist keine WordPress-Exportdatei.');

  const slides: WpSlide[] = [];
  const attachments = new Map<number, string>();
  let uploadsUrl = '';
  for (const { fields, meta } of items) {
    const id = Number(fields['wp:post_id']);
    const type = fields['wp:post_type'];
    if (type === 'foyer_slide' && !['trash', 'auto-draft'].includes(fields['wp:status'])) {
      const slideMeta = Object.fromEntries(Object.entries(meta).filter(([key]) => key.startsWith('slide_')));
      slides.push({ id, title: fields.title ?? '', status: fields['wp:status'], meta: slideMeta });
    }
    if (type === 'attachment' && meta._wp_attached_file) {
      const file = meta._wp_attached_file;
      attachments.set(id, file);
      // The real address also holds where a site has moved its uploads to.
      const url = fields['wp:attachment_url'] ?? '';
      if (!uploadsUrl && url.endsWith(`/${file}`)) uploadsUrl = url.slice(0, -file.length - 1);
    }
  }
  return {
    slides: slides.sort((a, b) => a.id - b.id),
    attachments,
    // A site-wide option, which the export does not contain. Slides choose zoom themselves.
    zoomByDefault: false,
    uploadsUrl: uploadsUrl || `${(channel['wp:base_site_url'] ?? '').replace(/\/+$/, '')}/wp-content/uploads`,
  };
}
