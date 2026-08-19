import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import { log } from '../lib/logger';
import { sha256, urlToFilename, websiteCacheDir } from './knowledge-manifest';

export interface CrawlOptions {
  maxPages: number;
  /** Pausa entre peticiones, para no golpear el sitio del cliente. */
  delayMs: number;
  timeoutMs: number;
  userAgent: string;
  respectRobots: boolean;
}

export const DEFAULT_CRAWL: CrawlOptions = {
  maxPages: 40,
  delayMs: 600,
  timeoutMs: 20_000,
  userAgent: 'AtrioKnowledgeBot/0.1 (+onboarding de asistente autorizado por el propietario del sitio)',
  respectRobots: true,
};

export interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
  hash: string;
  bytes: number;
  filename: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  visited: number;
  skipped: Array<{ url: string; reason: string }>;
}

const SKIP_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|zip|rar|mp4|webm|mp3|wav|avi|mov)(\?|$)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── robots.txt ───────────────────────────────────────────────────────────────

interface Robots {
  disallow: string[];
  crawlDelayMs: number | null;
}

async function fetchRobots(origin: string, opts: CrawlOptions): Promise<Robots> {
  const empty: Robots = { disallow: [], crawlDelayMs: null };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': opts.userAgent },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return empty;
    const text = await res.text();

    // Aplicamos los grupos que nos aplican: nuestro agente y el comodín.
    const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
    let applies = false;
    const out: Robots = { disallow: [], crawlDelayMs: null };
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(':');
      if (!rawKey || rest.length === 0) continue;
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') {
        applies = value === '*' || opts.userAgent.toLowerCase().includes(value.toLowerCase());
      } else if (applies && key === 'disallow' && value) {
        out.disallow.push(value);
      } else if (applies && key === 'crawl-delay') {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n)) out.crawlDelayMs = Math.round(n * 1000);
      }
    }
    return out;
  } catch {
    return empty;
  }
}

function robotsAllows(robots: Robots, url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  return !robots.disallow.some((rule) => rule !== '' && target.startsWith(rule));
}

// ── extracción ───────────────────────────────────────────────────────────────

/**
 * Convierte HTML a texto útil. Se descarta chrome de navegación y se conserva
 * jerarquía mínima (encabezados, listas, tablas), porque el vector store indexa
 * mejor con algo de estructura que con un muro de texto.
 */
export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const $ = cheerio.load(html);

  $('script, style, noscript, iframe, svg, form, template').remove();
  $('nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]').remove();
  $('[class*=cookie], [id*=cookie], [class*=breadcrumb], [class*=menu], [class*=navbar]').remove();

  const title = ($('title').first().text() || $('h1').first().text() || url).trim();
  const description = $('meta[name="description"]').attr('content')?.trim() ?? '';

  const root = $('main').first().length ? $('main').first() : $('body');

  const out: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  };

  root.find('h1, h2, h3, h4, p, li, td, th, dt, dd, figcaption').each((_, el) => {
    const node = $(el);
    const text = node.text();
    if (!text.trim()) return;
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
    if (tag.startsWith('h')) {
      const level = Number.parseInt(tag.slice(1), 10) || 2;
      push(`\n${'#'.repeat(Math.min(6, level + 1))} ${text}`);
    } else if (tag === 'li' || tag === 'dt' || tag === 'dd') {
      push(`- ${text}`);
    } else if (tag === 'td' || tag === 'th') {
      push(`| ${text}`);
    } else {
      push(text);
    }
  });

  // Deduplicación de líneas repetidas (menús residuales, pies de página).
  const seen = new Set<string>();
  const body = out
    .filter((line) => {
      const key = line.toLowerCase();
      if (line.length < 3) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n');

  const markdown = [
    `# ${title}`,
    '',
    `<!-- fuente: ${url} -->`,
    description ? `\n${description}\n` : '',
    body,
  ].join('\n');

  return { title, markdown };
}

function extractLinks(html: string, base: URL): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    try {
      const u = new URL(href, base);
      u.hash = '';
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      urls.push(u.toString());
    } catch {
      /* href inválido */
    }
  });
  return urls;
}

// ── crawl ────────────────────────────────────────────────────────────────────

/**
 * BFS acotado al mismo host. Escribe una copia local en `.cache/` para depurar
 * exactamente qué se indexó.
 */
export async function crawlWebsite(
  tenantId: string,
  startUrl: string,
  options: Partial<CrawlOptions> = {},
): Promise<CrawlResult> {
  const opts = { ...DEFAULT_CRAWL, ...options };
  const start = new URL(startUrl);
  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    throw new Error(`URL no soportada: ${startUrl}`);
  }

  const robots = opts.respectRobots ? await fetchRobots(start.origin, opts) : { disallow: [], crawlDelayMs: null };
  const delay = Math.max(opts.delayMs, robots.crawlDelayMs ?? 0);

  const outDir = websiteCacheDir(tenantId);
  fs.mkdirSync(outDir, { recursive: true });

  const queue: string[] = [start.toString()];
  const seen = new Set<string>([start.toString()]);
  const pages: CrawledPage[] = [];
  const skipped: CrawlResult['skipped'] = [];
  let visited = 0;

  while (queue.length > 0 && pages.length < opts.maxPages) {
    const current = queue.shift() as string;
    const url = new URL(current);

    if (url.host !== start.host) {
      skipped.push({ url: current, reason: 'otro dominio' });
      continue;
    }
    if (SKIP_EXT.test(url.pathname)) {
      skipped.push({ url: current, reason: 'recurso no textual' });
      continue;
    }
    if (opts.respectRobots && !robotsAllows(robots, url)) {
      skipped.push({ url: current, reason: 'robots.txt' });
      continue;
    }

    visited += 1;
    try {
      const res = await fetch(current, {
        headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: 'follow',
      });

      if (!res.ok) {
        skipped.push({ url: current, reason: `HTTP ${res.status}` });
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('html')) {
        skipped.push({ url: current, reason: `content-type ${contentType || 'desconocido'}` });
        continue;
      }

      const html = await res.text();
      const { title, markdown } = htmlToMarkdown(html, current);

      if (markdown.replace(/\s+/g, '').length < 200) {
        skipped.push({ url: current, reason: 'contenido insuficiente' });
      } else {
        const filename = urlToFilename(current);
        fs.writeFileSync(path.join(outDir, filename), markdown, 'utf8');
        pages.push({
          url: current,
          title,
          markdown,
          hash: sha256(markdown),
          bytes: Buffer.byteLength(markdown, 'utf8'),
          filename,
        });
      }

      for (const link of extractLinks(html, url)) {
        const lu = new URL(link);
        if (lu.host !== start.host) continue;
        const norm = lu.toString();
        if (seen.has(norm)) continue;
        seen.add(norm);
        queue.push(norm);
      }
    } catch (e) {
      skipped.push({ url: current, reason: (e as Error).message });
    }

    if (queue.length > 0 && pages.length < opts.maxPages) await sleep(delay);
  }

  log.info('Crawl terminado', {
    tenant: tenantId,
    visited,
    indexed: pages.length,
    skipped: skipped.length,
  });

  return { pages, visited, skipped };
}
