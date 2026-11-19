import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson, writeJson, sha256, stableHash, sortBySeverity, skillVersion, createLogger,
} from './lib/util.mjs';
import { loadMessages, localizeFinding } from './lib/i18n.mjs';

function refsOf(finding) {
  const uids = new Set();
  const pins = new Set();
  const nets = new Set();
  const designators = new Set();
  for (const e of finding.evidence || []) {
    if (e.uid) uids.add(e.uid);
    if (e.designator) designators.add(e.designator);
    if (e.kind === 'pin' && e.uid && e.pin) pins.add(`${e.uid}:${e.pin}`);
    if (e.kind === 'net' && e.net) nets.add(e.net);
    if (e.kind === 'drc' && e.name) nets.add(e.name);
  }
  return { uids, pins, nets, designators };
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function areDuplicates(a, b) {
  if (a.category !== b.category) return false;
  const ra = refsOf(a), rb = refsOf(b);
  const netOverlap = [...ra.nets].some(n => rb.nets.has(n));
  const pinScore = jaccard(new Set([...ra.uids, ...ra.pins]), new Set([...rb.uids, ...rb.pins]));
  return netOverlap || pinScore >= 0.5;
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

function computeFindingKey(f) {
  const refs = refsOf(f);
  const keys = [...new Set([...refs.uids, ...refs.pins, ...refs.nets, ...refs.designators])].sort();
  if (f.ruleId) return `${f.ruleId}:${stableHash(keys)}`;
  return `${f.packetId || f.source || 'ai'}:${stableHash({ subject: f.subject || f.title, evidence: keys })}`;
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
      const pages = finding.location?.pages || [];
      if (pages.length) return pages.includes(v);
      const comps = model.components.filter(c => refs.uids.has(c.uid));
      return comps.some(c => c.page === v);
    }
    if (k === 'net') return refs.nets.has(v);
    if (k === 'designator') return refs.designators.has(v);
    if (k === 'uid') return refs.uids.has(v);
    if (k === 'category') return finding.category === v;
    return true;
  });
}

function readAiFindings(aiDir, model, lang) {
  const accepted = [];
  const rejected = [];
  if (!aiDir || !fs.existsSync(aiDir)) return { accepted, rejected };
  const files = fs.readdirSync(aiDir).filter(f => /^findings\.ai\..*\.json$/i.test(f));
  for (const file of files) {
    const packetKey = file.replace(/^findings\.ai\./i, '').replace(/\.json$/i, '');
    let data;
    try { data = readJson(path.join(aiDir, file)); } catch (err) {
      rejected.push({ file, reason: `invalid json: ${err.message}` });
      continue;
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
  return { accepted, rejected };
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
  const { accepted: aiFindings, rejected } = readAiFindings(options.aiDir, model, lang);

  const ruleFindings = (lint.findings || []).map(f => ({
    ...f,
    source: 'rule',
    // Materialize for human-readable artifacts; messageKey remains authoritative for i18n.
    ...localizeFinding(f, lang, messages),
  }));
  for (const f of ruleFindings) f.findingKey = f.findingKey || computeFindingKey(f);

  // Enhancements: AI can attach to an existing rule finding instead of duplicating it.
  const final = [...ruleFindings];
  for (const ai of aiFindings) {
    if (ai.enhancesRuleFindingId) {
      const target = final.find(f => f.id === ai.enhancesRuleFindingId || f.findingKey === ai.enhancesRuleFindingId);
      if (target) {
        target.aiEnhancement = {
          observation: ai.observation || ai.title || '',
          impact: ai.impact || '',
          suggestion: ai.suggestion || '',
          confidence: ai.confidence || 'medium',
        };
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
      };
      continue;
    }
    ai.findingKey = computeFindingKey(ai);
    final.push(localizeFinding(ai, lang, messages));
  }

  const scope = options.scope || null;
  const scoped = final.filter(f => scopeMatches(f, scope, model));
  scoped.sort(sortBySeverity);
  const maxFindings = options.maxFindings ?? 30;
  const kept = [];
  let omitted = 0;
  for (const f of scoped) {
    if (kept.length >= maxFindings && !['P0', 'P1'].includes(f.severity)) { omitted++; continue; }
    kept.push(f);
  }
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
