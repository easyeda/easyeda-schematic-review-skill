import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, readJson as rj, escapeXml, ensureDir } from './lib/util.mjs';

function isFiniteBox(b) {
  return b && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) &&
    b.maxX > b.minX && b.maxY > b.minY;
}

function unionBoxes(boxes) {
  const valid = boxes.filter(isFiniteBox);
  if (!valid.length) return null;
  return {
    minX: Math.min(...valid.map(b => b.minX)),
    minY: Math.min(...valid.map(b => b.minY)),
    maxX: Math.max(...valid.map(b => b.maxX)),
    maxY: Math.max(...valid.map(b => b.maxY)),
  };
}

function pageLabel(page) {
  const pageName = page?.pageName || null;
  const schematicName = page?.schematicName || null;
  if (schematicName && pageName) return `${schematicName} / ${pageName}`;
  return pageName || schematicName || null;
}

function choosePage(finding, model) {
  const pages = model.geometry?.pages || {};
  const locPages = finding.location?.pages || [];
  for (const p of locPages) {
    if (pages[p]) return { key: p, page: pages[p] };
    const hit = Object.entries(pages).find(([, page]) => page.pageName === p || page.pageFileKey === p);
    if (hit) return { key: hit[0], page: hit[1] };
  }
  const uids = new Set(finding.location?.uids || []);
  for (const [key, page] of Object.entries(pages)) {
    if ([...uids].some(u => page.components?.[u])) return { key, page };
  }
  if (pages.__current__) return { key: '__current__', page: pages.__current__ };
  const first = Object.entries(pages)[0];
  if (first) return { key: first[0], page: first[1] };
  return { key: null, page: null };
}

function collectUids(finding, page, model) {
  const uids = new Set(finding.location?.uids || []);
  for (const d of finding.location?.designators || []) {
    for (const u of page?.designatorIndex?.[d] || []) uids.add(u);
  }
  const nets = finding.location?.nets || [];
  for (const netName of nets) {
    const net = model.nets.find(n => n.name === netName);
    if (!net) continue;
    if ((net.isPower || net.isGround) && net.pins.length > 12) continue;
    for (const p of net.pins.slice(0, 12)) uids.add(p.uid);
  }
  return [...uids].filter(u => page?.components?.[u]);
}

function collectBoxes(finding, page, model, uids) {
  const boxes = [];
  for (const uid of uids) {
    const b = page.components?.[uid]?.bbox;
    if (isFiniteBox(b)) boxes.push({ ...b, uid });
  }
  if (!boxes.length) {
    for (const e of finding.evidence || []) {
      if (e.kind === 'drc' && e.primitiveId) {
        const b = page.drcPrimitives?.[e.primitiveId]?.bbox;
        if (isFiniteBox(b)) boxes.push({ ...b, drcPrimitiveId: e.primitiveId });
      }
    }
  }
  return boxes;
}

function adjustRegion(finding, page, boxes) {
  let region = unionBoxes(boxes);
  if (!region) return null;
  const pw = Number(page.pageWidth) || 0;
  const ph = Number(page.pageHeight) || 0;
  if (pw > 0 && ph > 0 && (region.maxX - region.minX) * (region.maxY - region.minY) > pw * ph * 0.7) {
    const first = boxes[0];
    if (first) region = { minX: first.minX, minY: first.minY, maxX: first.maxX, maxY: first.maxY };
  }
  const pad = 40;
  return {
    minX: region.minX - pad,
    minY: region.minY - pad,
    maxX: region.maxX + pad,
    maxY: region.maxY + pad,
  };
}

function cropSvg(svg, region, boxes) {
  let out = String(svg);
  const width = Math.max(1, region.maxX - region.minX);
  const height = Math.max(1, region.maxY - region.minY);
  const viewBox = `${region.minX} ${-region.maxY} ${width} ${height}`;
  if (/viewBox\s*=\s*["'][^"']*["']/i.test(out)) {
    out = out.replace(/viewBox\s*=\s*["'][^"']*["']/i, `viewBox="${viewBox}"`);
  } else {
    out = out.replace(/<svg\b/i, `<svg viewBox="${viewBox}"`);
  }
  out = out.replace(/\swidth\s*=\s*["'][^"']*["']/i, ` width="${Math.min(2000, Math.round(width * 2))}"`);
  out = out.replace(/\sheight\s*=\s*["'][^"']*["']/i, ` height="${Math.min(2000, Math.round(height * 2))}"`);
  const rects = boxes.map(b => {
    const x = b.minX, y = -b.maxY;
    const w = Math.max(0.5, b.maxX - b.minX), h = Math.max(0.5, b.maxY - b.minY);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(220,38,38,0.12)" stroke="#DC2626" stroke-width="2" vector-effect="non-scaling-stroke" data-uid="${escapeXml(b.uid || '')}"/>`;
  }).join('\n');
  out = out.replace(/<\/svg>\s*$/i, `${rects}\n</svg>`);
  return { svg: out, viewBox };
}

export function captureScreenshots(options = {}) {
  const outDir = options.outDir;
  const finalFile = path.join(outDir, 'findings.final.json');
  const data = readJson(finalFile);
  const model = readJson(path.join(outDir, 'model.json'));
  const dir = ensureDir(path.join(outDir, 'screenshots'));
  const failed = [];
  let generated = 0;
  let nonCriticalGenerated = 0;
  let skipped = 0;
  const max = options.maxScreenshots ?? 30;

  for (const finding of data.findings || []) {
    const isP0P1 = ['P0', 'P1'].includes(finding.severity);
    if (!isP0P1 && nonCriticalGenerated >= max) {
      finding.screenshotPlaceholder = '截图数量已达上限';
      skipped++;
      continue;
    }
    const { key, page } = choosePage(finding, model);
    if (!page) {
      finding.screenshotPlaceholder = '截图不可用（无几何数据）';
      failed.push({ id: finding.id, reason: 'no geometry' });
      continue;
    }
    if (!page.svgPath || !fs.existsSync(path.join(outDir, page.svgPath))) {
      finding.screenshotPlaceholder = '截图不可用（页面 SVG 缺失）';
      failed.push({ id: finding.id, reason: 'no page svg' });
      continue;
    }
    const uids = collectUids(finding, page, model);
    const boxes = collectBoxes(finding, page, model, uids);
    if (!boxes.length) {
      finding.screenshotPlaceholder = '截图不可用（器件不在当前页）';
      failed.push({ id: finding.id, reason: 'no bbox' });
      continue;
    }
    const region = adjustRegion(finding, page, boxes);
    if (!region) {
      finding.screenshotPlaceholder = '截图不可用（BBox 非法）';
      failed.push({ id: finding.id, reason: 'invalid bbox' });
      continue;
    }
    const svgText = fs.readFileSync(path.join(outDir, page.svgPath), 'utf8');
    const cropped = cropSvg(svgText, region, boxes);
    const fileName = `screenshots/${finding.id}.svg`;
    fs.writeFileSync(path.join(outDir, fileName), cropped.svg, 'utf8');
    const labels = uids.map(u => page.components[u]?.designator).filter(Boolean);
    const captionLabel = labels.length ? labels.join('、') : ((finding.location?.nets || [])[0] || '—');
    const label = pageLabel(page);
    finding.screenshots = [{
      id: `${finding.id}-shot-1`,
      file: fileName,
      png: null,
      svg: fileName,
      page: label || page.pageName || key,
      caption: `${label ? `${label} · ` : ''}红框为相关器件：${captionLabel}`,
      highlights: labels,
      viewBox: cropped.viewBox,
    }];
    finding.screenshotPlaceholder = null;
    generated++;
    if (!isP0P1) nonCriticalGenerated++;
  }

  data.screenshots = {
    generated,
    failed: failed.length,
    skipped,
    items: failed,
  };
  writeJson(finalFile, data);
  writeJson(path.join(outDir, 'screenshots', 'index.json'), {
    generated, failed, skipped, items: failed,
  });
  return data.screenshots;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法: node capture-screenshots.mjs <runDir> [--max-screenshots 30]');
    process.exit(3);
  }
  const args = process.argv.slice(3);
  const idx = args.indexOf('--max-screenshots');
  try {
    const result = captureScreenshots({ outDir, maxScreenshots: idx >= 0 ? Number(args[idx + 1]) : 30 });
    console.log(`screenshots: ${result.generated} generated, ${result.failed} failed, ${result.skipped} skipped`);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(4);
  }
}
