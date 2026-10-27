import * as cheerio from 'cheerio';
import { gzipSync } from 'node:zlib';
import { FIX_CATALOG, type FixId } from '../diagnose.js';

export interface RuntimeItem {
  url?: string;
  width?: number;
  height?: number;
}

const TEXT = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/i;

export function isRuntimeFix(fix: string): fix is FixId {
  return Object.prototype.hasOwnProperty.call(FIX_CATALOG, fix) && FIX_CATALOG[fix as FixId].runtimeTestable;
}

function pathOf(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(value, 'https://perfpilot.local').pathname;
  } catch {
    return value.split('?')[0] ?? '';
  }
}

function matches(src: string | undefined, items: RuntimeItem[]): RuntimeItem | undefined {
  const path = pathOf(src);
  if (!path) return undefined;
  return items.find((item) => pathOf(item.url) === path);
}

/** Rewrites one HTML document for a single runtime fix. Byte and header fixes leave the markup alone. */
export function rewriteDocument(html: string, fix: string, items: RuntimeItem[] = []): { html: string; changed: boolean } {
  if (fix === 'compress-text' || fix === 'optimize-images') return { html, changed: false };
  const $ = cheerio.load(html);
  const original = $.html();
  if (fix === 'defer-scripts') {
    $('head script[src]').each((_, element) => {
      const node = $(element);
      const type = (node.attr('type') ?? '').toLowerCase();
      if (node.attr('defer') != null || node.attr('async') != null || type === 'module') return;
      node.attr('defer', '');
    });
  } else if (fix === 'inline-or-async-css') {
    $('link[rel="stylesheet"]').each((_, element) => {
      const node = $(element);
      if (node.attr('media') === 'print' && node.attr('onload')) return;
      node.attr('media', 'print');
      node.attr('onload', "this.media='all'");
    });
  } else if (fix === 'lazy-load-images') {
    $('img').each((_, element) => {
      const node = $(element);
      if (node.attr('fetchpriority') === 'high' || node.closest('.hero').length) return;
      const src = node.attr('src');
      if (items.length && !matches(src, items)) return;
      node.attr('loading', 'lazy');
      node.attr('decoding', 'async');
    });
  } else if (fix === 'image-dimensions') {
    $('img').each((_, element) => {
      const node = $(element);
      const item = matches(node.attr('src'), items);
      if (!item || !item.width || !item.height) return;
      if (!node.attr('width')) node.attr('width', String(item.width));
      if (!node.attr('height')) node.attr('height', String(item.height));
    });
  } else if (fix === 'preload-lcp-image') {
    const image = $('img.hero, .hero img, img').first();
    const href = image.attr('src') || items[0]?.url;
    if (href && $('link[rel="preload"][as="image"]').length === 0) {
      $('head').append(`<link rel="preload" as="image" href="${href}" fetchpriority="high">`);
      image.removeAttr('loading');
      image.attr('fetchpriority', 'high');
    }
  } else if (fix === 'preconnect') {
    const origins = new Set<string>();
    for (const item of items) {
      if (!item.url) continue;
      try {
        origins.add(new URL(item.url).origin);
      } catch {
        /* skip a bad item url */
      }
    }
    for (const origin of origins) {
      if ($(`link[rel="preconnect"][href="${origin}"]`).length) continue;
      $('head').append(`<link rel="preconnect" href="${origin}">`);
    }
  }
  const next = $.html();
  return { html: next, changed: next !== original };
}

export function sameOrigin(target: string, requestPath: string): string | null {
  let base: URL;
  try {
    base = new URL(target);
  } catch {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(requestPath, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  return resolved.toString();
}

export interface TransformInput {
  fix: string;
  contentType: string;
  body: Buffer;
  accept: string;
  transcode?: (body: Buffer) => Promise<Buffer | null>;
}

export interface Transformed {
  body: Buffer;
  contentType: string;
  encoding?: string;
}

/** Applies a response-body fix. Image bytes are transcoded only by the supplied function. */
export async function transformResponse(input: TransformInput): Promise<Transformed> {
  const type = input.contentType.split(';')[0]?.trim() ?? '';
  if (input.fix === 'compress-text' && TEXT.test(type) && input.body.length > 0) {
    return { body: gzipSync(input.body), contentType: input.contentType, encoding: 'gzip' };
  }
  if (input.fix === 'optimize-images' && /^image\/(png|jpeg|jpg)$/i.test(type) && /image\/webp/.test(input.accept) && input.transcode) {
    const next = await input.transcode(input.body);
    if (next && next.length > 0 && next.length < input.body.length) {
      return { body: next, contentType: 'image/webp' };
    }
  }
  return { body: input.body, contentType: input.contentType };
}
