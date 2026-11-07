import { KpaxPage } from '../types/kpax.types';

/**
 * Walks KPAX's Laravel-style pagination (meta.current_page / meta.last_page).
 * Stops on the last page, an empty page, missing meta, or maxPages.
 */
export async function* kpaxPaginate<T>(
  fetchPage: (page: number) => Promise<KpaxPage<T>>,
  opts: { startPage?: number; maxPages?: number } = {},
): AsyncGenerator<T, void, undefined> {
  let page = opts.startPage ?? 1;
  let fetched = 0;
  for (;;) {
    const res = await fetchPage(page);
    const items = Array.isArray(res?.data) ? res.data : [];
    for (const item of items) yield item;
    fetched++;

    const meta = res?.meta;
    if (!items.length || !meta) return;
    const current = meta.current_page ?? page;
    const last = meta.last_page ?? current;
    if (current >= last) return;
    if (opts.maxPages !== undefined && fetched >= opts.maxPages) return;
    page = current + 1;
  }
}

export async function kpaxCollect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
