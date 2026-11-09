/** An image file is shown directly: it scales to the display and needs no permission to embed. */
export function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(new URL(url).pathname);
}

/** The same address, so that no cache answers with an older image. */
export function freshUrl(url: string, now: number): string {
  const fresh = new URL(url);
  fresh.searchParams.set('foyer', String(now));
  return fresh.href;
}
