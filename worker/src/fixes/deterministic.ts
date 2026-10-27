import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { imageSize } from 'image-size';
import sharp from 'sharp';
import * as esbuild from 'esbuild';
import type { Finding } from '../diagnose.js';
import { findingPaths, localFile, publicRoot, readText, relativeTo, rewritePath, walkFiles, writeIfChanged } from './files.js';
import { skipped, type ApplyContext, type ApplyResult, type FixApplier } from './types.js';

async function editHtml(
  ctx: ApplyContext,
  edit: (file: string, html: string) => string | undefined | Promise<string | undefined>,
): Promise<ApplyResult> {
  const root = publicRoot(ctx.dir, ctx.config);
  const files = await walkFiles(root, ['.html', '.htm']);
  const changed: string[] = [];
  for (const file of files) {
    const before = await readText(file);
    if (before === undefined) continue;
    const after = await edit(file, before);
    if (after === undefined) continue;
    if (await writeIfChanged(file, before, after)) changed.push(relativeTo(ctx.dir, file));
  }
  return { applied: changed.length > 0, changedFiles: changed, description: changed.join(', ') };
}

function matchesPath(src: string | undefined, pathnames: string[]): boolean {
  if (!src) return false;
  const normalized = src.split('?')[0]?.split('#')[0] ?? src;
  const bare = normalized.replace(/^\/+/, '');
  return pathnames.some((pathname) => normalized === pathname || bare === pathname.replace(/^\/+/, ''));
}

function isLcpImage(img: { closest: (sel: string) => { length: number }; is: (sel: string) => boolean; attr: (name: string) => string | undefined }): boolean {
  if (img.closest('.hero').length > 0 || img.is('.hero')) return true;
  if ((img.attr('fetchpriority') ?? '').toLowerCase() === 'high') return true;
  return false;
}

export const deferScripts: FixApplier = {
  id: 'defer-scripts',
  kind: 'deterministic',
  async apply(ctx) {
    const result = await editHtml(ctx, (_file, html) => {
      const $ = cheerio.load(html);
      let touched = false;
      $('head script[src]').each((_, element) => {
        const script = $(element);
        const type = (script.attr('type') ?? '').toLowerCase();
        if (type === 'module') return;
        if (script.attr('defer') !== undefined || script.attr('async') !== undefined) return;
        script.attr('defer', '');
        touched = true;
      });
      return touched ? $.html() : undefined;
    });
    if (!result.applied) return skipped('no render-blocking classic scripts in the head');
    return { ...result, description: `Added defer to classic scripts in ${result.changedFiles.join(', ')}` };
  },
};

export const lazyLoadImages: FixApplier = {
  id: 'lazy-load-images',
  kind: 'deterministic',
  async apply(ctx) {
    const pathnames = findingPaths(ctx.finding);
    if (pathnames.length === 0) return skipped('offscreen-images finding has no image URLs');
    const result = await editHtml(ctx, (_file, html) => {
      const $ = cheerio.load(html);
      let touched = false;
      $('img').each((_, element) => {
        const img = $(element);
        if (isLcpImage(img)) return;
        if (!matchesPath(img.attr('src'), pathnames)) return;
        if (img.attr('loading') === 'lazy' && img.attr('decoding') === 'async') return;
        img.attr('loading', 'lazy');
        img.attr('decoding', 'async');
        touched = true;
      });
      return touched ? $.html() : undefined;
    });
    if (!result.applied) return skipped('no matching below-the-fold images');
    return { ...result, description: `Lazy-loaded offscreen images in ${result.changedFiles.join(', ')}` };
  },
};

function lcpImage($: cheerio.CheerioAPI, finding: Finding) {
  for (const item of finding.items) {
    const selector = item.detail?.trim();
    if (!selector || selector.includes(' ') === false && !selector.includes('>') && !selector.includes('.') && !selector.includes('#') && !selector.startsWith('img') && !selector.startsWith('body')) {
      continue;
    }
    try {
      const found = $(selector).filter('img').first();
      if (found.length) return found;
      const nested = $(selector).find('img').first();
      if (nested.length) return nested;
    } catch {
      // The detail text is not always a selector.
    }
  }
  const hero = $('.hero img').first();
  if (hero.length) return hero;
  return $('img').first();
}

export const preloadLcpImage: FixApplier = {
  id: 'preload-lcp-image',
  kind: 'deterministic',
  async apply(ctx) {
    const result = await editHtml(ctx, (_file, html) => {
      const $ = cheerio.load(html);
      const img = lcpImage($, ctx.finding);
      if (!img.length) return undefined;
      const src = img.attr('src');
      if (!src) return undefined;
      let touched = false;
      if (img.attr('loading') === 'lazy') {
        img.removeAttr('loading');
        touched = true;
      }
      if ((img.attr('fetchpriority') ?? '').toLowerCase() !== 'high') {
        img.attr('fetchpriority', 'high');
        touched = true;
      }
      const existing = $(`head link[rel="preload"][as="image"][href="${src}"]`);
      if (existing.length === 0) {
        $('head').prepend(`<link rel="preload" as="image" href="${src}" fetchpriority="high">`);
        touched = true;
      } else if ((existing.attr('fetchpriority') ?? '').toLowerCase() !== 'high') {
        existing.attr('fetchpriority', 'high');
        touched = true;
      }
      return touched ? $.html() : undefined;
    });
    if (!result.applied) return skipped('LCP image is already preloaded');
    return { ...result, description: `Preloaded the LCP image in ${result.changedFiles.join(', ')}` };
  },
};

export const imageDimensions: FixApplier = {
  id: 'image-dimensions',
  kind: 'deterministic',
  async apply(ctx) {
    const result = await editHtml(ctx, asyncFile);
    if (!result.applied) return skipped('every local image already has width and height');
    return { ...result, description: `Set width and height from the image files in ${result.changedFiles.join(', ')}` };

    async function asyncFile(_file: string, html: string): Promise<string | undefined> {
      const $ = cheerio.load(html);
      let touched = false;
      const images = $('img').toArray();
      for (const element of images) {
        const img = $(element);
        if (img.attr('width') && img.attr('height')) continue;
        const src = img.attr('src');
        if (!src || src.includes('://') || src.startsWith('data:')) continue;
        const pathname = src.startsWith('/') ? src : `/${src.replace(/^\.\//, '')}`;
        let file: string;
        try {
          file = localFile(ctx.dir, ctx.config, pathname.split('?')[0] ?? pathname);
        } catch {
          continue;
        }
        try {
          const bytes = await readFile(file);
          const size = imageSize(bytes);
          if (!size.width || !size.height) continue;
          img.attr('width', String(size.width));
          img.attr('height', String(size.height));
          // The height attribute is a presentational hint. An author width without an
          // author height would otherwise stretch the image to the attribute's pixels.
          if (!img.css('height')) img.css('height', 'auto');
          touched = true;
        } catch {
          // Missing or unreadable images are left alone.
        }
      }
      return touched ? $.html() : undefined;
    }
  },
};

async function ensureWebpType(ctx: ApplyContext, changed: string[]): Promise<void> {
  const serverPath = path.join(ctx.dir, ctx.config.serverFile);
  const before = await readText(serverPath);
  if (!before || before.includes("'.webp'") || before.includes('".webp"')) return;
  if (!before.includes("'.png'") && !before.includes('".png"')) return;
  const after = before.includes("'.png': 'image/png',")
    ? before.replace("'.png': 'image/png',", "'.png': 'image/png',\n  '.webp': 'image/webp',")
    : before;
  if (after === before) return;
  if (await writeIfChanged(serverPath, before, after)) changed.push(relativeTo(ctx.dir, serverPath));
}

export const optimizeImages: FixApplier = {
  id: 'optimize-images',
  kind: 'deterministic',
  async apply(ctx) {
    const pathnames = findingPaths(ctx.finding).filter((p) => /\.(png|jpe?g)$/i.test(p));
    if (pathnames.length === 0) return skipped('no local PNG or JPEG images in the finding');
    const converted: Array<{ from: string; to: string }> = [];
    const changed: string[] = [];
    for (const pathname of pathnames) {
      let source: string;
      try {
        source = localFile(ctx.dir, ctx.config, pathname);
      } catch {
        continue;
      }
      const nextPath = pathname.replace(/\.(png|jpe?g)$/i, '.webp');
      const target = source.replace(/\.(png|jpe?g)$/i, '.webp');
      try {
        const data = await sharp(source).rotate().resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
        const previous = await readFile(target).catch(() => undefined);
        if (!previous || !previous.equals(data)) {
          await writeFile(target, data);
          changed.push(relativeTo(ctx.dir, target));
        }
        converted.push({ from: pathname, to: nextPath });
      } catch {
        // Leave images sharp cannot read.
      }
    }
    if (converted.length === 0) return skipped('could not convert any of the finding images');

    const root = publicRoot(ctx.dir, ctx.config);
    const docs = await walkFiles(root, ['.html', '.htm', '.css']);
    for (const file of docs) {
      const before = await readText(file);
      if (before === undefined) continue;
      let after = before;
      for (const item of converted) after = rewritePath(after, item.from, item.to);
      if (await writeIfChanged(file, before, after)) changed.push(relativeTo(ctx.dir, file));
    }
    if (changed.length > 0) await ensureWebpType(ctx, changed);
    if (changed.length === 0) return skipped('images are already WebP');
    return {
      applied: true,
      changedFiles: [...new Set(changed)],
      description: `Converted ${converted.length} image${converted.length === 1 ? '' : 's'} to WebP`,
    };
  },
};

export const minifyAssets: FixApplier = {
  id: 'minify-assets',
  kind: 'deterministic',
  async apply(ctx) {
    const pathnames = findingPaths(ctx.finding).filter((p) => /\.(js|css)$/i.test(p));
    if (pathnames.length === 0) return skipped('no local JavaScript or CSS in the finding');
    const changed: string[] = [];
    for (const pathname of pathnames) {
      let file: string;
      try {
        file = localFile(ctx.dir, ctx.config, pathname);
      } catch {
        continue;
      }
      const before = await readText(file);
      if (before === undefined) continue;
      const loader = pathname.toLowerCase().endsWith('.css') ? 'css' : 'js';
      try {
        const result = await esbuild.transform(before, { loader, minify: true, legalComments: 'none' });
        if (await writeIfChanged(file, before, result.code)) changed.push(relativeTo(ctx.dir, file));
      } catch {
        // Leave a file that does not parse.
      }
    }
    if (changed.length === 0) return skipped('assets are already minified');
    return { applied: true, changedFiles: changed, description: `Minified ${changed.join(', ')}` };
  },
};
