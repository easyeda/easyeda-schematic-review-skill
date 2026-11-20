import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson, writeJson, sortBySeverity, skillVersion, createLogger,
  refsOf, computeFindingKey,
} from './lib/util.mjs';
import { loadMessages, localizeFinding } from './lib/i18n.mjs';

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function areDuplicates(a, b) {
  if (a.category !== b.category) return false;
  const ra = refsOf(a), rb = refsOf(b);
  const shared = (x, y) => [...x].filter(v => y.has(v)).length;
  const sharedNets = shared(ra.nets, rb.nets);
  const sharedUids = shared(ra.uids, rb.uids);
  const sharedPins = shared(ra.pins, rb.pins);
  const sharedDesignators = shared(ra.designators, rb.designators);
  const pinScore = jaccard(new Set([...ra.uids, ...ra.pins]), new Set([...rb.uids, ...rb.pins]));
  // 仅共享一个网络不足以判重：同一电源轨上的不同问题（如 R007 无来源 vs AI 双输出并联）
  // 必须各自保留。要求引脚/器件高度重合，或至少两处共享证据。
  return pinScore >= 0.5 || sharedNets + sharedUids + sharedPins + sharedDesignators >= 2;
}

const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** AI 结论合并进规则条目时，严重度只升不降。 */
function escalateSeverity(target, aiSeverity) {
  if ((SEV_ORDER[aiSeverity] ?? 9) < (SEV_ORDER[target.severity] ?? 9)) target.severity = aiSeverity;
}

function validateEvidence(finding, model) {
  const uidSet = new Set(model.components.map(c => c.uid));
  const netSet = new Set(model.nets.map(n => n.name));
  const errors = [];
  if (!Array.isArray(finding.evidence) || !finding.evidence.length) errors.push('missing evidence');
  for (const e of finding.evidence || []) {
    if (e.kind === 'pin') {
      if (!e.uid || !uidSet.has(e.uid)) errors.push(`unknown uid ${e.uid}`);
      const comp = model.components.find(c => c.uid === e.uid);
      if (comp && e.pin && !comp.pins.some(p => p.number === e.pin)) errors.push(`unknown pin ${e.designator || e.uid}.${e.pin}`);
      if (e.net && e.net !== '' && !netSet.has(e.net)) errors.push(`unknown net ${e.net}`);
    } else if (e.kind === 'net') {
      if (e.net && !netSet.has(e.net)) errors.push(`unknown net ${e.net}`);
    } else if (e.kind === 'component') {
      if (!e.uid || !uidSet.has(e.uid)) errors.push(`unknown uid ${e.uid}`);
    } else if (e.kind === 'drc') {
      const exists = (model.drc || []).some(d => (d.primitives || []).some(p => p.primitiveId === e.primitiveId));
      if (e.primitiveId && !exists) errors.push(`unknown DRC primitive ${e.primitiveId}`);
    }
  }
  return errors;
}

function scopeMatches(finding, scope, model) {
  if (!scope) return true;
  const clauses = String(scope).split(',').map(s => s.trim()).filter(Boolean);
  if (!clauses.length) return true;
  const refs = refsOf(finding);
  return clauses.every(clause => {
    const [k, ...rest] = clause.split(':');
    const v = rest.join(':');
    if (k === 'page') {
      // location.pages / comp.page carry unique "Schematic / Page" labels;
      // still accept a bare page name (page:P1) or an exact pageFileKey,
      // case-insensitively per the scope contract.
      const lv = String(v).toLowerCase();
      const matchPage = (p) => {
        if (!p) return false;
        const lp = String(p).toLowerCase();
        return lp === lv || lp.endsWith(` / ${lv}`);
      };
      const pages = finding.location?.pages || [];
      if (pages.some(matchPage)) return true;
      const comps = model.components.filter(c => refs.uids.has(c.uid));
      return comps.some(c => matchPage(c.page) || (c.pageKey && String(c.pageKey).toLowerCase() === lv));
    }
    if (k === 'net') return refs.nets.has(v);
    if (k === 'designator') return refs.designators.has(v);
    if (k === 'uid') return refs.uids.has(v);
    if (k === 'category') return finding.category === v;
    return true;
  });
}

function attachDerivedPages(finding, model) {
  finding.location = finding.location || { pages: [], designators: [], uids: [], nets: [] };
  if ((finding.location.pages || []).length) return;
  const pageNames = new Set();
  for (const uid of finding.location.uids || []) {
    const comp = model.components.find(c => c.uid === uid);
    if (comp?.page) pageNames.add(comp.page);
  }
  if (!pageNames.size) {
    for (const designator of finding.location.designators || []) {
      for (const comp of model.components) {
        if (comp.designator === designator && comp.page) pageNames.add(comp.page);
      }
    }
  }
  finding.location.pages = [...pageNames];
}

function readAiFindings(aiDir, model, lang) {
  const accepted = [];
  const rejected = [];
  const openQuestions = [];
  if (!aiDir || !fs.existsSync(aiDir)) return { accepted, rejected, openQuestions };
  const files = fs.readdirSync(aiDir).filter(f => /^findings\.ai\..*\.json$/i.test(f));
  for (const file of files) {
    const packetKey = file.replace(/^findings\.ai\./i, '').replace(/\.json$/i, '');
    let data;
    try { data = readJson(path.join(aiDir, file)); } catch (err) {
      rejected.push({ file, reason: `invalid json: ${err.message}` });
      continue;
    }
    if (!Array.isArray(data)) {
      for (const q of data.open_questions || []) openQuestions.push(q);
    }
    const list = Array.isArray(data) ? data : (data.findings || []);
    for (const raw of list) {
      const f = {
        ...raw,
        packetId: raw.packetId || packetKey,
        source: 'ai',
        confidence: raw.confidence || 'medium',
        severity: raw.severity || 'P2',
        category: raw.category || 'other',
        evidence: raw.evidence || [],
        location: raw.location || { pages: [], designators: [], uids: [], nets: [] },
      };
      const errors = validateEvidence(f, model);
      if (errors.length) rejected.push({ file, id: raw.id, reason: errors.join('; ') });
      else accepted.push(f);
    }
  }
  for (const f of accepted) attachDerivedPages(f, model);
  return { accepted, rejected, openQuestions };
}

function coverageFromPackets(outDir, packetsManifest, model) {
  const totalComps = model.components.length || 1;
  const totalNets = model.nets.length || 1;
  if (!packetsManifest) {
    return {
      packetsReviewed: [], packetsSkipped: [], packetsFailed: [],
      componentPercent: 1, netPercent: 1, partial: false, skippedRules: [], suppressedFindings: 0,
    };
  }
  const progressFile = path.join(outDir, 'progress.json');
  const progress = fs.existsSync(progressFile) ? readJson(progressFile, {}) : {};
  const reviewed = [];
  const skipped = [];
  const failed = [];
  const comps = new Set();
  const nets = new Set();
  const packetDir = path.join(outDir, 'packets');
  for (const p of packetsManifest.packets || []) {
    const status = progress[p.fileKey]?.status;
    if (status === 'done') {
      reviewed.push(p.packet_id);
      try {
        const packet = readJson(path.join(packetDir, `${p.fileKey}.json`));
        for (const c of packet.facts?.components || []) comps.add(c.uid);
        for (const n of packet.facts?.nets || []) nets.add(n.name);
      } catch { /* ignore */ }
    } else if (status === 'failed') failed.push(p.packet_id);
    else if (!status) skipped.push(p.packet_id);
  }
  const total = (packetsManifest.packets || []).length;
  const partial = failed.length > 0 || (total > 0 && reviewed.length < total);
  return {
    packetsReviewed: reviewed,
    packetsSkipped: skipped,
    packetsFailed: failed,
    componentPercent: Math.min(1, comps.size / totalComps),
    netPercent: Math.min(1, nets.size / totalNets),
    partial,
    skippedRules: [],
    suppressedFindings: 0,
  };
}

export function mergeFindings(options = {}) {
  const outDir = options.outDir;
  const lang = options.lang || 'zh';
  const messages = loadMessages(lang);
  const log = options.logger || createLogger();
  const model = readJson(path.join(outDir, 'model.json'));
  const lint = readJson(path.join(outDir, 'lint.json'), { findings: [], openQuestions: [], coverage: {} });
  const packetsManifest = fs.existsSync(path.join(outDir, 'packets', 'manifest.json'))
    ? readJson(path.join(outDir, 'packets', 'manifest.json')) : null;
  const { accepted: aiFindings, rejected, openQuestions: aiOpenQuestions } = readAiFindings(options.aiDir, model, lang);

  const ruleFindings = (lint.findings || []).map(f => ({
    ...f,
    source: 'rule',
    // Materialize for human-readable artifacts; messageKey remains authoritative for i18n.
    ...localizeFinding(f, lang, messages),
  }));
  for (const f of ruleFindings) f.findingKey = f.findingKey || computeFindingKey(f);

  // Enhancements: AI can attach to an existing rule finding instead of duplicating it.
  // findingKey 优先于显示 id：显示 id 在 lint/merge 阶段会重新编号，findingKey 稳定。
  const final = [...ruleFindings];
  for (const ai of aiFindings) {
    if (ai.enhancesRuleFindingId) {
      const target = final.find(f => f.findingKey && f.findingKey === ai.enhancesRuleFindingId) ||
        final.find(f => f.id === ai.enhancesRuleFindingId);
      if (target) {
        target.aiEnhancement = {
          observation: ai.observation || ai.title || '',
          impact: ai.impact || '',
          suggestion: ai.suggestion || '',
          confidence: ai.confidence || 'medium',
          severity: ai.severity,
        };
        escalateSeverity(target, ai.severity);
        continue;
      }
    }
    const dup = final.find(f => areDuplicates(f, ai));
    if (dup) {
      dup.aiEnhancement = dup.aiEnhancement || {
        observation: ai.observation || ai.title || '',
        impact: ai.impact || '',
        suggestion: ai.suggestion || '',
        confidence: ai.confidence || 'medium',
        severity: ai.severity,
      };
      escalateSeverity(dup, ai.severity);
      continue;
    }
    ai.findingKey = computeFindingKey(ai);
    final.push(localizeFinding(ai, lang, messages));
  }

  const scope = options.scope || null;
  const scoped = final.filter(f => scopeMatches(f, scope, model));
  scoped.sort(sortBySeverity);
  const maxFindings = options.maxFindings ?? 30;
  // P0/P1、AI 独立结论、带 AI 增强的条目永不截断；截断优先砍 R020/R026 类噪声，再 P3 后 P2。
  const isProtected = f => ['P0', 'P1'].includes(f.severity) || f.aiEnhancement || f.source === 'ai';
  const kept = scoped.filter(isProtected);
  const droppable = scoped.filter(f => !isProtected(f));
  const noiseRank = f => (['R020', 'R026'].includes(f.ruleId) ? 0 : f.severity === 'P3' ? 1 : 2);
  const dropOrder = [...droppable].sort((a, b) => noiseRank(a) - noiseRank(b) || sortBySeverity(b, a));
  const budget = Math.max(0, maxFindings - kept.length);
  const toDrop = new Set(dropOrder.slice(0, Math.max(0, droppable.length - budget)));
  let omitted = 0;
  const omittedByRule = {};
  for (const f of droppable) {
    if (toDrop.has(f)) {
      omitted++;
      const k = f.ruleId || f.source || 'ai';
      omittedByRule[k] = (omittedByRule[k] || 0) + 1;
      continue;
    }
    kept.push(f);
  }
  kept.sort(sortBySeverity);
  kept.forEach((f, i) => { f.id = `F-${String(i + 1).padStart(3, '0')}`; f.findingKey = f.findingKey || computeFindingKey(f); });

  const questions = [];
  const seenQ = new Set();
  const addQ = (q) => {
    const text = typeof q === 'string' ? q : q.question;
    if (!text || seenQ.has(text)) return;
    seenQ.add(text);
    questions.push(typeof q === 'string' ? { question: q, related: [], why: '' } : q);
  };
  for (const q of lint.openQuestions || []) addQ(q);
  for (const q of aiOpenQuestions) addQ(q);
  for (const f of aiFindings) for (const q of f.open_questions || f.questions || []) addQ(q);
  const openQuestions = questions.slice(0, 15);
  const omittedQuestions = Math.max(0, questions.length - openQuestions.length);

  const packetsCoverage = coverageFromPackets(outDir, packetsManifest, model);
  const coverage = {
    ...packetsCoverage,
    componentPercent: Math.round(packetsCoverage.componentPercent * 1000) / 1000,
    netPercent: Math.round(packetsCoverage.netPercent * 1000) / 1000,
    scope: scope || null,
    scopeComponentPercent: scope ? Math.min(1, new Set(scoped.flatMap(f => f.location?.uids || [])).size / (model.components.length || 1)) : packetsCoverage.componentPercent,
    scopeNetPercent: scope ? Math.min(1, new Set(scoped.flatMap(f => f.location?.nets || [])).size / (model.nets.length || 1)) : packetsCoverage.netPercent,
    skippedRules: lint.coverage?.skippedRules || [],
    suppressedFindings: lint.coverage?.suppressedFindings || 0,
    partial: packetsCoverage.partial || rejected.length > 0,
    partialReason: rejected.length > 0
      ? `AI 结果有 ${rejected.length} 条证据无效`
      : packetsCoverage.partial ? '部分 AI 包未完成' : null,
    omittedFindings: omitted,
    omittedByRule,
    omittedQuestions,
    aiRejected: rejected,
  };
  coverage.scopeComponentPercent = Math.round(coverage.scopeComponentPercent * 1000) / 1000;
  coverage.scopeNetPercent = Math.round(coverage.scopeNetPercent * 1000) / 1000;

  const result = {
    schemaVersion: '1.0',
    skillVersion: skillVersion(),
    runId: options.runId || path.basename(outDir),
    generatedAt: new Date().toISOString(),
    lang,
    mode: options.mode || 'standard',
    source: model.source,
    stats: model.stats,
    findings: kept,
    openQuestions,
    coverage,
    warnings: model.warnings || [],
  };
  writeJson(path.join(outDir, 'findings.final.json'), result);
  log.info('merge done', { findings: kept.length, rejected: rejected.length, omitted });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法: node merge-findings.mjs <runDir> [--ai-dir dir] [--lang zh|en]');
    process.exit(3);
  }
  const args = process.argv.slice(3);
  const aiIdx = args.indexOf('--ai-dir');
  const langIdx = args.indexOf('--lang');
  try {
    const result = mergeFindings({
      outDir,
      aiDir: aiIdx >= 0 ? args[aiIdx + 1] : path.join(outDir, 'ai'),
      lang: langIdx >= 0 ? args[langIdx + 1] : 'zh',
    });
    console.log(`merged: ${result.findings.length} findings, ${result.openQuestions.length} open questions`);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(5);
  }
}
