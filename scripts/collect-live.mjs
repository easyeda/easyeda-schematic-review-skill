import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, writeJson, writeText, sanitizeFileKey, createLogger,
} from './lib/util.mjs';
import { findBridge, execute, resolveWindow, launchBridge, bridgeUnavailableMessage } from './bridge.mjs';

const COMPONENT_SNAPSHOT = `
async function __bbox(id) {
  try {
    const bb = await eda.sch_Primitive.getPrimitivesBBox([id]);
    if (!bb) return null;
    const { minX, minY, maxX, maxY } = bb;
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    if (maxX - minX <= 0 || maxY - minY <= 0) return null;
    return { minX, minY, maxX, maxY };
  } catch { return null; }
}
async function __pageSvg() {
  try {
    const f = await eda.sch_ManufactureData.getExportDocumentFile('page', 'SVG', undefined, 'Current Schematic Page');
    return f ? await f.text() : null;
  } catch { return null; }
}
async function __components(includeBBox) {
  const comps = await eda.sch_PrimitiveComponent.getAll('part');
  const list = comps.map(c => ({
    uid: (() => { try { return c.getState_UniqueId(); } catch { return undefined; } })(),
    designator: (() => { try { return c.getState_Designator(); } catch { return undefined; } })(),
    primitiveId: (() => { try { return c.getState_PrimitiveId(); } catch { return undefined; } })(),
  }));
  const withBBox = [];
  for (let i = 0; i < list.length; i += 16) {
    const chunk = list.slice(i, i + 16);
    const boxes = await Promise.all(chunk.map(e => (includeBBox && e.primitiveId) ? __bbox(e.primitiveId) : null));
    chunk.forEach((e, k) => withBBox.push({ ...e, bbox: boxes[k] }));
  }
  return withBBox;
}
async function __pins() {
  const comps = await eda.sch_PrimitiveComponent.getAll('part');
  const out = [];
  for (let i = 0; i < comps.length; i += 16) {
    const chunk = comps.slice(i, i + 16);
    const rows = await Promise.all(chunk.map(async c => {
      let pins = [];
      try { pins = (await c.getAllPins()) || []; } catch {}
      return {
        uid: (() => { try { return c.getState_UniqueId(); } catch { return undefined; } })(),
        designator: (() => { try { return c.getState_Designator(); } catch { return undefined; } })(),
        primitiveId: (() => { try { return c.getState_PrimitiveId(); } catch { return undefined; } })(),
        pins: pins.map(p => ({
          number: (() => { try { return p.getState_PinNumber(); } catch { return undefined; } })(),
          name: (() => { try { return p.getState_PinName(); } catch { return undefined; } })(),
          pinType: (() => { try { return p.getState_pinType(); } catch { return undefined; } })(),
          noConnect: (() => { try { return p.getState_NoConnected(); } catch { return undefined; } })(),
        })),
      };
    }));
    out.push(...rows);
  }
  return out;
}
`;

function viewBoxOf(svg) {
  const m = String(svg || '').match(/viewBox\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function pageNameOf(doc) {
  return doc?.name || doc?.title || doc?.pageName || doc?.documentName || 'Page';
}

async function collectCurrentPage(bridgeUrl, windowId, includeGeometry) {
  const code = `${COMPONENT_SNAPSHOT}
(async () => {
  const result = { ok: true };
  result.doc = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(e => ({ error: String(e) }));
  result.project = await eda.dmt_Project.getCurrentProjectInfo().catch(e => ({ error: String(e) }));
  result.version = await eda.sys_Environment.getEditorCurrentVersion().catch(() => null);
  try {
    const f = await eda.sch_ManufactureData.getNetlistFile('design', 'JLCEDA');
    result.netlist = f ? await f.text() : null;
  } catch (e) { result.netlistError = String(e); }
  try {
    const f = await eda.sch_ManufactureData.getBomFile('bom', 'csv');
    result.bom = f ? await f.text() : null;
  } catch (e) { result.bomError = String(e); }
  try {
    result.drc = await eda.sch_Drc.check(false, false, true);
  } catch (e) { result.drcError = String(e); }
  try { result.pins = await __pins(); } catch (e) { result.pinsError = String(e); }
  result.components = await __components(${includeGeometry ? 'true' : 'false'}).catch(e => { result.componentsError = String(e); return []; });
  result.svg = await __pageSvg();
  return result;
})()`;
  return execute(bridgeUrl, code, { windowId, timeoutMs: 180000 });
}

async function collectPage(bridgeUrl, windowId, page, includeGeometry) {
  const uuid = page.uuid || page.pageUuid || page.id;
  const code = `${COMPONENT_SNAPSHOT}
(async () => {
  const result = { ok: true };
  if (${JSON.stringify(String(uuid))}) {
    try { await eda.dmt_EditorControl.openDocument(${JSON.stringify(String(uuid))}); } catch (e) { result.openError = String(e); }
  }
  result.components = await __components(${includeGeometry ? 'true' : 'false'}).catch(e => []);
  result.svg = await __pageSvg();
  return result;
})()`;
  return execute(bridgeUrl, code, { windowId, timeoutMs: 180000 });
}

export async function collectLive(options = {}) {
  const log = options.logger || createLogger();
  const outDir = ensureDir(options.outDir || path.join(process.cwd(), 'tmp', 'schematic-review', 'live'));
  let bridge = null;
  if (options.bridgeUrl) {
    bridge = { url: options.bridgeUrl.replace(/\/$/, ''), port: Number(new URL(options.bridgeUrl).port || 49620) };
    try { await execute(bridge.url, 'return {ok:true}', { timeoutMs: 5000 }); } catch { /* health checked below */ }
  } else {
    bridge = await findBridge(options.bridgePort);
  }
  if (!bridge) {
    if (options.startBridge) bridge = await launchBridge(options.skillDir || path.resolve(process.cwd()));
    else throw new Error(bridgeUnavailableMessage());
  }
  const windowId = await resolveWindow(bridge.url, options.windowId);
  log.info('collect-live start', { port: bridge.port, windowId });

  const base = await collectCurrentPage(bridge.url, windowId, options.geometry !== false);
  if (base.netlistError && !base.netlist) throw new Error(`网表导出失败: ${base.netlistError}`);
  if (!base.netlist) throw new Error('网表为空');
  writeText(path.join(outDir, 'design.enet'), base.netlist);
  if (base.bom) writeText(path.join(outDir, 'bom.csv'), base.bom);
  if (base.pins?.length) writeJson(path.join(outDir, 'pins.json'), base.pins);
  if (base.drc) writeJson(path.join(outDir, 'drc.json'), base.drc);

  const doc = base.doc || {};
  const pageName = pageNameOf(doc);
  const pageFileKey = sanitizeFileKey(pageName);
  const pages = {};
  const current = {
    pageUuid: doc.uuid || doc.pageUuid || doc.id || null,
    pageName,
    pageFileKey,
    pageWidth: null,
    pageHeight: null,
    svgViewBox: viewBoxOf(base.svg),
    svgPath: base.svg ? `page-${pageFileKey}.svg` : null,
    pngPath: null,
    components: {},
    designatorIndex: {},
    drcPrimitives: {},
  };
  if (base.svg) writeText(path.join(outDir, `page-${pageFileKey}.svg`), base.svg);
  for (const c of base.components || []) {
    if (!c.uid) continue;
    current.components[c.uid] = {
      designator: c.designator || '',
      primitiveId: c.primitiveId || null,
      bbox: c.bbox || null,
    };
    if (c.designator) {
      if (!current.designatorIndex[c.designator]) current.designatorIndex[c.designator] = [];
      current.designatorIndex[c.designator].push(c.uid);
    }
  }
  pages.__current__ = current;

  if (options.mapPages) {
    try {
      const pageList = await execute(bridge.url, `
        (async () => {
          const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
          const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
          return { pages: pages || [], current: cur };
        })()`, { windowId, timeoutMs: 30000 });
      const originalUuid = current.pageUuid;
      for (const p of pageList.pages || []) {
        const pName = pageNameOf(p);
        const pKey = sanitizeFileKey(pName);
        const snap = await collectPage(bridge.url, windowId, p, options.geometry !== false);
        const pg = {
          pageUuid: p.uuid || p.pageUuid || p.id || null,
          pageName: pName,
          pageFileKey: pKey,
          pageWidth: null,
          pageHeight: null,
          svgViewBox: viewBoxOf(snap.svg),
          svgPath: snap.svg ? `page-${pKey}.svg` : null,
          pngPath: null,
          components: {},
          designatorIndex: {},
          drcPrimitives: {},
        };
        if (snap.svg) writeText(path.join(outDir, `page-${pKey}.svg`), snap.svg);
        for (const c of snap.components || []) {
          if (!c.uid) continue;
          pg.components[c.uid] = { designator: c.designator || '', primitiveId: c.primitiveId || null, bbox: c.bbox || null };
          if (c.designator) {
            if (!pg.designatorIndex[c.designator]) pg.designatorIndex[c.designator] = [];
            pg.designatorIndex[c.designator].push(c.uid);
          }
        }
        pages[pKey] = pg;
      }
      if (originalUuid) {
        await execute(bridge.url, `
          (async () => { await eda.dmt_EditorControl.openDocument(${JSON.stringify(String(originalUuid))}); return { ok: true }; })()`,
          { windowId, timeoutMs: 30000 }).catch(() => null);
      }
    } catch (err) {
      log.warn('map-pages failed', { error: String(err) });
    }
  }

  // DRC primitive bboxes (optional, best effort).
  if (Array.isArray(base.drc) && base.drc.length) {
    const ids = [...new Set(base.drc.flatMap(d => (d.primitives || []).map(p => p.primitiveId)).filter(Boolean))].slice(0, 200);
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const results = await Promise.all(chunk.map(id => execute(bridge.url, `
          (async () => { try { return await eda.sch_Primitive.getPrimitivesBBox([${JSON.stringify(id)}]); } catch { return null; } })()`,
        { windowId, timeoutMs: 15000 }).catch(() => null)));
      chunk.forEach((id, k) => {
        const bb = results[k];
        if (bb && Number.isFinite(bb.minX) && bb.maxX > bb.minX && bb.maxY > bb.minY) {
          current.drcPrimitives[id] = { bbox: { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY } };
        }
      });
    }
  }

  const geometry = {
    currentPage: pageName,
    pages,
  };
  writeJson(path.join(outDir, 'geometry.json'), geometry);

  const project = base.project || {};
  const summary = {
    doc,
    project,
    version: base.version || null,
    netlistFile: 'design.enet',
    bomAvailable: Boolean(base.bom),
    drcAvailable: Array.isArray(base.drc),
    pinsAvailable: Array.isArray(base.pins) && base.pins.length > 0,
    geometryAvailable: true,
    mapPages: Boolean(options.mapPages),
    pageName,
    pageFileKey,
    windowId,
    bridgePort: bridge.port,
  };
  writeJson(path.join(outDir, 'collect.json'), summary);
  log.info('collect-live done', summary);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(process.cwd(), 'tmp', 'schematic-review', 'live');
  collectLive({
    outDir,
    mapPages: args.includes('--map-pages'),
    startBridge: args.includes('--start-bridge'),
    bridgeUrl: args.includes('--bridge-url') ? args[args.indexOf('--bridge-url') + 1] : undefined,
    windowId: args.includes('--window-id') ? args[args.indexOf('--window-id') + 1] : undefined,
    skillDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  }).then(() => console.log(`collect written: ${outDir}`)).catch(err => {
    console.error(err.message);
    process.exit(2);
  });
}
