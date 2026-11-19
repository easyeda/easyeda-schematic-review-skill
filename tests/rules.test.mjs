import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildModel } from '../scripts/parse-netlist.mjs';
import { lintModel } from '../scripts/lint.mjs';
import { classifyNet, classifyPinName, classifyComponent, dnpInfo } from '../scripts/lib/classify-components.mjs';
import { mergeFindings } from '../scripts/merge-findings.mjs';
import { readJson, writeJson, ensureDir } from '../scripts/lib/util.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects', 'ne555.enet');

function loadNe555() {
  return JSON.parse(fs.readFileSync(FIX, 'utf8'));
}

function netlist(components) {
  return { version: '2.0.0', components, designRule: { netRule: {} } };
}

function comp(uid, designator, props, pins) {
  return {
    props: { 'Unique ID': uid, Designator: designator, ...props },
    pinInfoMap: Object.fromEntries(pins.map(([number, name, net]) => [number, { number, name, net }])),
  };
}

test('parses the NE555 fixture', () => {
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  assert.equal(model.stats.components, 5);
  assert.equal(model.stats.nets, 6);
  assert.equal(model.components.find(c => c.designator === 'U1').pins.length, 8);
  assert.equal(model.components.find(c => c.designator === 'U1').category, 'ic');
  assert.ok(model.nets.find(n => n.name === 'VCC').isPower);
  assert.ok(model.nets.find(n => n.name === 'GND').isGround);
});

test('classifies power, ground, control, and reference nets', () => {
  assert.equal(classifyNet('3V3_MCU').isPower, true);
  assert.equal(classifyNet('+5V_USB').isPower, true);
  assert.equal(classifyNet('-5V').powerKind, 'negative-rail');
  assert.equal(classifyNet('VCC_SENSE').isPower, false);
  assert.equal(classifyNet('VCC_ENABLE').isPower, false);
  assert.equal(classifyNet('PWR_GOOD').isPower, false);
  assert.equal(classifyNet('VREF').powerKind, 'reference');
  assert.equal(classifyNet('0V').isGround, true);
  assert.equal(classifyNet('$1N13').isPower, false);
  assert.equal(classifyNet('AGND').isGround, true);
});

test('classifies pin names and DNP', () => {
  assert.equal(classifyPinName('VCC').isPower, true);
  assert.equal(classifyPinName('GND').isGround, true);
  assert.equal(classifyPinName('EN').isPower, false);
  const dnp = dnpInfo({ 'Add into BOM': 'no' });
  assert.equal(dnp.dnp, null);
  assert.equal(dnp.dnpCandidate, true);
  const explicit = dnpInfo({ DNP: 'yes' });
  assert.equal(explicit.dnp, true);
  assert.equal(explicit.dnpSource, 'property');
});

test('R029 reports a power/ground conflict on one net', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'VCC', 'PWR'], ['2', 'GND', 'GND']]),
    b: comp('b', 'U2', {}, [['1', 'GND', 'PWR']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R029' && f.params.net === 'PWR'));
});

test('R009 reports a missing I2C pull-up', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'SCL', 'SCL'], ['2', 'SDA', 'SDA']]),
    b: comp('b', 'U2', {}, [['1', 'SCL', 'SCL'], ['2', 'SDA', 'SDA']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.filter(f => f.ruleId === 'R009').length >= 1);
});

test('R016 reports empty Value but skips DNP', () => {
  const model = buildModel(netlist({
    a: comp('a', 'R1', { 'Add into BOM': 'yes', 'Convert to PCB': 'yes' }, [['1', '', 'N1'], ['2', '', 'N2']]),
    b: comp('b', 'R2', { 'Add into BOM': 'yes', 'Convert to PCB': 'yes', DNP: 'yes' }, [['1', '', 'N3'], ['2', '', 'N4']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R016' && f.params.designator === 'R1'));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R016' && f.params.designator === 'R2'));
});

test('R030 reports a MOSFET without gate pull-down', () => {
  const model = buildModel(netlist({
    q: comp('q', 'Q1', { Category: 'mosfet' }, [['1', 'G', 'GATE'], ['2', 'S', 'GND'], ['3', 'D', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R030' && f.params.designator === 'Q1'));
});

test('R031 reports a BJT without base resistor', () => {
  const model = buildModel(netlist({
    q: comp('q', 'Q2', { Category: 'transistor' }, [['1', 'B', 'BASE'], ['2', 'C', 'COL'], ['3', 'E', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R031' && f.params.designator === 'Q2'));
});

test('R032 reports a relay coil without flyback diode', () => {
  const model = buildModel(netlist({
    k: comp('k', 'K1', { Category: 'relay' }, [['1', 'COIL1', 'COIL_A'], ['2', 'COIL2', 'COIL_B']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R032' && f.params.designator === 'K1'));
});

test('R033/R034 report incomplete regulator feedback and floating EN', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U10', { Category: 'regulator' }, [
      ['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'FB', 'FB'], ['4', 'EN', ''],
    ]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R033' && f.params.designator === 'U10'));
  assert.ok(lint.findings.some(f => f.ruleId === 'R034' && f.params.designator === 'U10'));
});

test('R035 reports a two-pin device with both pins on one net', () => {
  const model = buildModel(netlist({
    c: comp('c', 'C9', {}, [['1', '', 'SAME'], ['2', '', 'SAME']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R035' && f.params.designator === 'C9'));
});

test('R036 reports a regulator output without capacitor', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U20', { Category: 'regulator' }, [['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'GND', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R036' && f.params.designator === 'U20'));
});

test('R037 reports an LED with anode tied to ground', () => {
  const model = buildModel(netlist({
    d: comp('d', 'D1', { Category: 'led' }, [['1', 'A', 'GND'], ['2', 'K', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R037' && f.params.designator === 'D1'));
});

test('R038 reports a reversed polarized capacitor', () => {
  const model = buildModel(netlist({
    c: comp('c', 'C10', { Category: 'capacitor' }, [['1', '+', 'GND'], ['2', '-', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R038' && f.params.designator === 'C10'));
});

test('R039 reports a reversed relay flyback diode', () => {
  const model = buildModel(netlist({
    k: comp('k', 'K2', { Category: 'relay' }, [['1', 'COIL1', 'VCC'], ['2', 'COIL2', 'DRV']]),
    d: comp('d', 'D2', { Category: 'diode' }, [['1', 'A', 'VCC'], ['2', 'K', 'DRV']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R039' && f.params.designator === 'K2'));
});

test('merge deduplicates AI findings and computes stable findingKey', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  writeJson(path.join(dir, 'model.json'), model);
  const lint = lintModel(model, { mode: 'standard' });
  writeJson(path.join(dir, 'lint.json'), lint);
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-U1.json'), {
    findings: [{
      id: 'AI-component-U1-001', severity: 'P2', confidence: 'medium', category: 'component',
      title: 'duplicate of R016',
      evidence: [{ kind: 'component', uid: 'gge1', designator: 'U1' }],
      location: { pages: [], designators: ['U1'], uids: ['gge1'], nets: [] },
    }],
    open_questions: [],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', mode: 'standard' });
  assert.equal(result.findings.filter(f => f.ruleId === 'R016' && f.location.uids.includes('gge1')).length, 1);
  const f = result.findings[0];
  assert.match(f.findingKey, /^R/);
  assert.equal(result.openQuestions.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge rejects AI findings with invalid evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), { findings: [], openQuestions: [], coverage: {} });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-X.json'), {
    findings: [{
      id: 'AI-X', severity: 'P1', confidence: 'high', category: 'component', title: 'bad',
      evidence: [{ kind: 'pin', uid: 'nope', designator: 'U9', pin: '1', net: 'VCC' }],
      location: { pages: [], designators: ['U9'], uids: ['nope'], nets: ['VCC'] },
    }],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', mode: 'standard' });
  assert.equal(result.coverage.aiRejected.length, 1);
  assert.equal(result.findings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
