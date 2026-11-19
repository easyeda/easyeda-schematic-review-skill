import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, createLogger, levenshtein } from './lib/util.mjs';
import { classifyPinName, classifyNet } from './lib/classify-components.mjs';
import { readBom, compareBom } from './bom-check.mjs';

function mkFinding(ruleId, severity, confidence, category, params, evidence, location = {}, extra = {}) {
  return {
    source: 'rule',
    ruleId,
    messageKey: `${ruleId}.title`,
    params,
    severity,
    confidence,
    category,
    evidence,
    location: {
      pages: location.pages || [],
      designators: [...new Set(location.designators || [])],
      uids: [...new Set(location.uids || [])],
      nets: [...new Set(location.nets || [])],
    },
    heuristic: true,
    ...extra,
  };
}

function pinEvidence(comp, pin) {
  return { kind: 'pin', uid: comp.uid, designator: comp.designator, pin: pin.number, name: pin.name, net: pin.net };
}

function netEvidence(net) {
  return { kind: 'net', net: net.name, pins: (net.pins || []).map(p => `${p.designator}.${p.pin}`) };
}

function isPowerOrGroundPin(pin) {
  return classifyPinName(pin.name, pin.pinType).isPower || classifyPinName(pin.name, pin.pinType).isGround;
}

function componentNets(comp) {
  return [...new Set(comp.pins.map(p => p.net).filter(Boolean))];
}

function findComponentsTouching(model, netName) {
  return model.components.filter(c => c.pins.some(p => p.net === netName));
}

function isPassiveTwoPin(comp) {
  return comp.pins.length === 2 && ['resistor', 'resistor_array', 'capacitor', 'inductor', 'ferrite', 'fuse', 'switch', 'diode', 'led', 'crystal'].includes(comp.category);
}

function isSourceComponent(comp) {
  return ['connector', 'regulator', 'power_source'].includes(comp.category);
}

function hasPinOnNet(comp, netName) {
  return comp.pins.some(p => p.net === netName);
}

function otherPinNet(comp, netName) {
  const pins = comp.pins.filter(p => p.net === netName);
  if (pins.length !== 1) return null;
  const other = comp.pins.find(p => p !== pins[0]);
  return other?.net || null;
}

function isGroundNetName(name) {
  return classifyNet(name).isGround;
}
function isPowerNetName(name) {
  return classifyNet(name).isPower;
}

function findResistorToPower(model, netName) {
  for (const c of model.components) {
    if (!['resistor', 'resistor_array'].includes(c.category)) continue;
    if (!hasPinOnNet(c, netName)) continue;
    const other = otherPinNet(c, netName);
    if (other && isPowerNetName(other)) return { comp: c, otherNet: other };
  }
  return null;
}

function findCapToGround(model, netName) {
  for (const c of model.components) {
    if (c.category !== 'capacitor') continue;
    if (!hasPinOnNet(c, netName)) continue;
    const other = otherPinNet(c, netName);
    if (other && isGroundNetName(other)) return c;
  }
  return null;
}

function findCapToGroundOneHop(model, netName) {
  const direct = findCapToGround(model, netName);
  if (direct) return direct;
  for (const c of model.components) {
    if (!['ferrite', 'resistor', 'inductor'].includes(c.category) || c.pins.length !== 2) continue;
    if (!hasPinOnNet(c, netName)) continue;
    const value = String(c.rawValue ?? c.displayValue ?? '').trim();
    if (c.category === 'resistor' && !/^0(R|Ω|OHM)?$/i.test(value)) continue;
    const other = otherPinNet(c, netName);
    if (!other || isGroundNetName(other)) continue;
    const cap = findCapToGround(model, other);
    if (cap) return cap;
  }
  return null;
}

function findSeriesResistor(model, netName) {
  return model.components.find(c =>
    ['resistor', 'resistor_array'].includes(c.category) &&
    hasPinOnNet(c, netName) && otherPinNet(c, netName),
  ) || null;
}

function findResistorBetween(model, netA, netB) {
  return model.components.find(c => {
    if (!['resistor', 'resistor_array'].includes(c.category) || c.pins.length !== 2) return false;
    const nets = c.pins.map(p => p.net);
    return (nets[0] === netA && nets[1] === netB) || (nets[0] === netB && nets[1] === netA);
  }) || null;
}

function findDiodeAcross(model, netA, netB) {
  return model.components.find(c => {
    if (c.category !== 'diode' || c.pins.length !== 2) return false;
    const nets = c.pins.map(p => p.net);
    return (nets[0] === netA && nets[1] === netB) || (nets[0] === netB && nets[1] === netA);
  }) || null;
}

function pinByName(comp, re) {
  return comp.pins.find(p => re.test(String(p.name || '').trim().toUpperCase())) || null;
}

function countResistorsOn(model, netName) {
  return model.components.filter(c =>
    ['resistor', 'resistor_array'].includes(c.category) && hasPinOnNet(c, netName),
  ).length;
}

function r007PowerSource(model, netName) {
  const visited = new Set([netName]);
  let frontier = [netName];
  for (let depth = 0; depth <= 5 && frontier.length; depth++) {
    const next = [];
    for (const net of frontier) {
      for (const c of findComponentsTouching(model, net)) {
        if (isSourceComponent(c)) return { found: true, via: c.designator, depth };
        if (!isPassiveTwoPin(c)) continue;
        const other = otherPinNet(c, net);
        if (!other || visited.has(other) || other.startsWith('$')) continue;
        if (isGroundNetName(other)) continue;
        visited.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return { found: false };
}

function ruleR014(model) {
  const findings = [];
  const groups = model.differentialPairs;
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const [name, group] of Object.entries(groups)) {
      const nets = Array.isArray(group) ? group : (group?.nets || group?.members || []);
      if (!Array.isArray(nets)) continue;
      const missing = [];
      if (nets.length === 1) missing.push(nets[0]);
      if (nets.length === 0) missing.push(name);
      if (missing.length) {
        findings.push(mkFinding('R014', 'P2', 'high', 'interface', { net: name },
          [{ kind: 'net', net: name, pins: [] }], { nets: [name] }));
      }
    }
  }
  // Name-suffix fallback: FOO_P without FOO_N (or vice versa).
  const names = new Set(model.nets.map(n => n.name));
  for (const n of names) {
    const m = n.match(/^(.*?)([_-])(P|N|DP|DM)$/i);
    if (!m) continue;
    const suffix = m[3].toUpperCase();
    const altSuffix = suffix === 'P' ? 'N' : suffix === 'N' ? 'P' : suffix === 'DP' ? 'DM' : 'DP';
    const base = `${m[1]}${m[2]}`;
    if (!names.has(base + altSuffix) && !names.has(base + altSuffix.toLowerCase())) {
      findings.push(mkFinding('R014', 'P2', 'medium', 'interface', { net: n },
        [{ kind: 'net', net: n, pins: (model.nets.find(x => x.name === n)?.pins || []).map(p => `${p.designator}.${p.pin}`) }],
        { nets: [n] }));
    }
  }
  return findings;
}

export function lintModel(model, options = {}) {
  const log = options.logger || createLogger();
  const mode = options.mode || 'standard';
  const strict = mode === 'strict';
  const bom = options.bom || readBom(options.bomFile);
  const findings = [];
  const openQuestions = [];
  const skippedRules = [];
  const push = (f) => { findings.push(f); };
  const enabled = mode === 'quick'
    ? new Set(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R014', 'R015', 'R016', 'R017', 'R026', 'R029'])
    : mode === 'strict'
      ? new Set(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008', 'R009', 'R010', 'R011',
        'R012', 'R013', 'R014', 'R015', 'R016', 'R017', 'R018', 'R019', 'R020', 'R023', 'R025', 'R026',
        'R027', 'R028', 'R029', 'R030', 'R031', 'R032', 'R033', 'R034', 'R035', 'R036', 'R037', 'R038', 'R039'])
      : new Set(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008', 'R009', 'R010', 'R011',
        'R012', 'R013', 'R014', 'R015', 'R016', 'R017', 'R018', 'R019', 'R020', 'R026', 'R029',
        'R030', 'R031', 'R032', 'R033', 'R034', 'R035', 'R036', 'R037', 'R038', 'R039']);

  // R001 single-pin nets.
  for (const net of model.nets) {
    if (net.pinCount !== 1) continue;
    const p = net.pins[0];
    const comp = model.components.find(c => c.uid === p.uid);
    const prefix = String(comp?.designator || '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';
    if (['testpoint', 'antenna'].includes(comp?.category) || ['TP', 'TEST', 'ANT', 'JMP'].includes(prefix)) continue;
    if (comp?.category === 'connector' && comp.pins.length === 1) continue;
    push(mkFinding('R001', 'P2', 'high', 'connectivity', { net: net.name, designator: p.designator, pin: p.pin },
      [netEvidence(net), comp ? pinEvidence(comp, comp.pins.find(x => x.number === p.pin) || {}) : { kind: 'net', net: net.name }],
      { designators: [p.designator], uids: [p.uid], nets: [net.name] }));
  }

  // R002 floating pins.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (pin.net || pin.noConnect) continue;
      if (/^(NC|DNC|NO_CONNECT|RESERVED)$/i.test(pin.name)) {
        openQuestions.push({
          question: `${comp.designator}.${pin.number} 引脚名为 ${pin.name}，是否为故意不接？`,
          related: [`${comp.designator}.${pin.number}`],
          why: '引脚名暗示 NC，但缺少 noConnect 标记。',
        });
        continue;
      }
      const isControl = /^(EN|ENABLE|RST|RESET|NRST|CLK|CS|INT|BOOT|BOOT0)(\d+)?$/i.test(pin.name || '');
      const severity = isControl ? 'P1' : 'P2';
      const confidence = model.pinsAvailable ? 'high' : 'medium';
      push(mkFinding('R002', severity, confidence, 'connectivity',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid], nets: [] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R003 duplicate designators.
  const byDesignator = new Map();
  for (const c of model.components) {
    if (!c.designator) continue;
    if (!byDesignator.has(c.designator)) byDesignator.set(c.designator, []);
    byDesignator.get(c.designator).push(c);
  }
  for (const [designator, comps] of byDesignator) {
    if (comps.length < 2) continue;
    const groupIds = comps.map(c => c.groupId).filter(Boolean);
    if (comps.every(c => c.groupId) && new Set(groupIds).size === 1) continue;
    const sameDevice = comps.every(c => c.device && c.device === comps[0].device) ||
      comps.every(c => c.manufacturerPart && c.manufacturerPart === comps[0].manufacturerPart);
    let disjoint = false;
    if (sameDevice) {
      const sets = comps.map(c => new Set(c.pins.map(p => p.number).filter(n => !isPowerOrGroundPin(c.pins.find(p => p.number === n) || {}))));
      disjoint = sets.every((s, i) => sets.every((t, j) => i === j || [...s].every(n => !t.has(n))));
    }
    const severity = disjoint ? 'P3' : 'P0';
    push(mkFinding('R003', severity, 'high', 'connectivity',
      { designator, uids: comps.map(c => c.uid).join(', ') },
      comps.map(c => ({ kind: 'component', uid: c.uid, designator: c.designator })),
      { designators: [designator], uids: comps.map(c => c.uid) }));
  }

  // R004 nets with no pins.
  for (const net of model.nets) {
    if (net.pinCount !== 0) continue;
    push(mkFinding('R004', 'P2', 'high', 'connectivity', { net: net.name },
      [netEvidence(net)], { nets: [net.name] }, { _subjects: [`net:${net.name}`] }));
  }

  // R005 DRC dangling nets.
  if (model.drcAvailable || (Array.isArray(model.drc) && model.drc.length)) {
    const seen = new Set();
    for (const item of model.drc) {
      if (item?.rule !== 'SHOWDANDLING') continue;
      for (const prim of item.primitives || []) {
        const netName = prim.name || '';
        const key = `${netName}|${prim.primitiveId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const net = model.nets.find(n => n.name === netName);
        const evidence = [{ kind: 'drc', rule: 'SHOWDANDLING', name: netName, primitiveId: prim.primitiveId || null }];
        if (net) evidence.push(netEvidence(net));
        push(mkFinding('R005', 'P2', 'high', 'connectivity', { net: netName || prim.primitiveId || 'UNKNOWN' },
          evidence, { nets: netName ? [netName] : [] },
          { drcRule: 'SHOWDANDLING', _subjects: netName ? [`net:${netName}`] : [] }));
      }
    }
  } else {
    skippedRules.push({ ruleId: 'R005', reason: 'drc unavailable', uids: [] });
  }

  // R006 power/ground pins floating.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (pin.net) continue;
      const cls = classifyPinName(pin.name, pin.pinType);
      if (!cls.isPower && !cls.isGround) continue;
      const severity = pin.noConnect ? 'P1' : 'P0';
      const confidence = pin.noConnect ? 'medium' : 'high';
      push(mkFinding('R006', severity, confidence, 'power',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R007 power nets without a source.
  for (const net of model.nets) {
    if (!net.isPower || net.powerKind === 'reference' || net.isGround) continue;
    if (net.pinCount < 2) continue;
    if (!r007PowerSource(model, net.name).found) {
      push(mkFinding('R007', 'P2', 'medium', 'power', { net: net.name },
        [netEvidence(net)], { nets: [net.name] }));
    }
  }

  // R008 IC decoupling.
  for (const comp of model.components) {
    if (!['ic', 'regulator'].includes(comp.category)) continue;
    for (const pin of comp.pins) {
      if (!pin.net) continue;
      const cls = classifyPinName(pin.name, pin.pinType);
      if (!cls.isPower || cls.isGround) continue;
      const net = model.nets.find(n => n.name === pin.net);
      if (net?.powerKind === 'reference') continue;
      if (!findCapToGroundOneHop(model, pin.net)) {
        push(mkFinding('R008', 'P2', 'medium', 'power', { designator: comp.designator, net: pin.net },
          [pinEvidence(comp, pin), netEvidence(net || { name: pin.net, pins: [] })],
          { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] }));
      }
    }
  }

  // R009 I2C pull-ups.
  const i2cNets = model.nets.filter(n => /(^|[_-])(SCL|SDA)([_-]|$)/i.test(n.name) || n.name.match(/^(SCL|SDA)\d*$/i));
  for (const net of i2cNets) {
    if (findResistorToPower(model, net.name)) continue;
    const array = model.components.find(c => c.category === 'resistor_array' && hasPinOnNet(c, net.name));
    if (array) {
      if (enabled.has('R009')) openQuestions.push({
        question: `${net.name} 连接到排阻 ${array.designator}，请确认排阻是否已提供上拉。`,
        related: [net.name, array.designator],
        why: '排阻内部拓扑无法从网表确定。',
      });
      continue;
    }
    push(mkFinding('R009', 'P1', 'medium', 'interface', { net: net.name },
      [netEvidence(net)], { nets: [net.name] }));
  }

  // R010 reset pull-up/down.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (!pin.net || !/^(RESET|NRST|RST)(\d+)?$/i.test(pin.name || '')) continue;
      const has = model.components.some(c => {
        if (!['resistor', 'resistor_array'].includes(c.category) || !hasPinOnNet(c, pin.net)) return false;
        const other = otherPinNet(c, pin.net);
        return Boolean(other) && (isPowerNetName(other) || isGroundNetName(other));
      });
      if (!has) {
        push(mkFinding('R010', 'P2', 'medium', 'interface',
          { designator: comp.designator, pin: pin.number },
          [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] }));
      }
    }
  }

  // R011 BOOT floating.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (pin.net || !/^BOOT0?$/i.test(pin.name || '')) continue;
      push(mkFinding('R011', 'P1', 'high', 'interface',
        { designator: comp.designator, pin: pin.number },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R012 crystal load capacitors.
  for (const comp of model.components) {
    if (comp.category !== 'crystal') continue;
    const nets = componentNets(comp);
    const missing = nets.filter(n => !findCapToGround(model, n));
    if (missing.length) {
      push(mkFinding('R012', 'P2', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...missing.map(n => ({ kind: 'net', net: n, pins: [] }))],
        { designators: [comp.designator], uids: [comp.uid], nets: missing }));
    }
  }

  // R013 LED series resistor.
  for (const comp of model.components) {
    if (comp.category !== 'led') continue;
    const nets = componentNets(comp);
    if (!nets.some(n => findSeriesResistor(model, n))) {
      push(mkFinding('R013', 'P1', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...nets.map(n => ({ kind: 'net', net: n, pins: [] }))],
        { designators: [comp.designator], uids: [comp.uid], nets }));
    }
  }

  // R014 differential pairs.
  findings.push(...ruleR014(model));

  // R015 connector power/ground pins floating.
  for (const comp of model.components) {
    if (comp.category !== 'connector') continue;
    for (const pin of comp.pins) {
      if (pin.net) continue;
      const cls = classifyPinName(pin.name, pin.pinType);
      if (!cls.isPower && !cls.isGround) continue;
      push(mkFinding('R015', 'P1', 'high', 'connectivity',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R016 missing/placeholder values.
  for (const comp of model.components) {
    if (!comp.addIntoBom) continue;
    if (['connector', 'testpoint'].includes(comp.category)) continue;
    if (comp.dnp === true) continue;
    if (!comp.valuePlaceholder && !(comp.rawValue == null || String(comp.rawValue).trim() === '')) continue;
    const value = comp.rawValue == null ? '—' : String(comp.rawValue);
    if (comp.dnpCandidate) {
      openQuestions.push({
        question: `${comp.designator} 的 Value 为 ${value || '空'}，且未加入 BOM，是否为 DNP？`,
        related: [comp.designator],
        why: '只有 Add into BOM=false，缺少显式 DNP 属性。',
      });
      continue;
    }
    push(mkFinding('R016', 'P2', 'high', 'component', { designator: comp.designator, value },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator, property: 'Value', value: comp.rawValue }],
      { designators: [comp.designator], uids: [comp.uid] }));
  }

  // R017 missing footprint.
  for (const comp of model.components) {
    if (!comp.convertToPcb || comp.footprint) continue;
    push(mkFinding('R017', 'P1', 'high', 'component', { designator: comp.designator },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
      { designators: [comp.designator], uids: [comp.uid] }));
  }

  // R018 BOM/PCB flag combinations.
  for (const comp of model.components) {
    if (['mechanical', 'testpoint'].includes(comp.category)) continue;
    if (comp.addIntoBom && !comp.convertToPcb) {
      push(mkFinding('R018', 'P3', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
        { designators: [comp.designator], uids: [comp.uid] }));
    } else if (!comp.addIntoBom && comp.convertToPcb) {
      push(mkFinding('R018', 'P3', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
        { designators: [comp.designator], uids: [comp.uid] }));
    }
  }

  // R019 missing supplier part.
  for (const comp of model.components) {
    if (!comp.addIntoBom || comp.supplierPart) continue;
    push(mkFinding('R019', 'P3', 'medium', 'component', { designator: comp.designator },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
      { designators: [comp.designator], uids: [comp.uid] }));
  }

  // R020 similar net names.
  const candidates = model.nets.filter(n => !n.isAuto && !n.isPower && !n.isGround);
  const seenPairs = new Set();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].name, b = candidates[j].name;
      const norm = s => s.toLowerCase().replace(/[_-]/g, '');
      if (a === b) continue;
      const threshold = strict ? 2 : 1;
      if (levenshtein(norm(a), norm(b)) > threshold) continue;
      const key = [a, b].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      push(mkFinding('R020', 'P3', 'low', 'readability', { netA: a, netB: b },
        [{ kind: 'net', net: a, pins: [] }, { kind: 'net', net: b, pins: [] }],
        { nets: [a, b] }));
    }
  }

  // R023 power input protection (strict).
  if (strict) {
    for (const net of model.nets) {
      if (!net.isPower || net.isGround) continue;
      const connectors = findComponentsTouching(model, net.name).filter(c => c.category === 'connector');
      if (!connectors.length) continue;
      const hasProtection = findComponentsTouching(model, net.name).some(c => ['fuse', 'tvs'].includes(c.category));
      if (!hasProtection) {
        push(mkFinding('R023', 'P3', 'low', 'power', { net: net.name }, [netEvidence(net)], { nets: [net.name] }));
      }
    }
  }

  // R025 test point on key rails (strict).
  if (strict) {
    for (const net of model.nets) {
      if (!net.isPower || net.isGround || net.powerKind === 'reference') continue;
      const hasTp = findComponentsTouching(model, net.name).some(c => c.category === 'testpoint' ||
        /^TP|^TEST/i.test(c.designator || ''));
      if (!hasTp) {
        push(mkFinding('R025', 'P3', 'low', 'readability', { net: net.name }, [netEvidence(net)], { nets: [net.name] }));
      }
    }
  }

  // R026 BOM consistency.
  const bomResult = compareBom(model, bom);
  if (!bomResult.available) {
    skippedRules.push({ ruleId: 'R026', reason: `bom ${bomResult.reason || 'unavailable'}`, uids: [] });
  } else {
    for (const issue of bomResult.issues) {
      const severity = issue.kind === 'supplier-mismatch' ? 'P3' : 'P2';
      const designators = issue.designators || [];
      const comps = designators.map(d => model.components.find(c => c.designator === d)).filter(Boolean);
      push(mkFinding('R026', severity, 'high', 'bom', { detail: issue.detail },
        [{ kind: 'bom', designators, detail: issue.detail }, ...comps.map(c => ({ kind: 'component', uid: c.uid, designator: c.designator }))],
        { designators, uids: comps.map(c => c.uid) }));
    }
  }

  // R027 unused op-amp channels (strict).
  if (strict) {
    for (const comp of model.components) {
      if (comp.category !== 'ic') continue;
      const desc = `${comp.description} ${comp.name} ${comp.lcscPartName}`;
      if (!/\bop[- ]?amp\b|运放/i.test(desc)) continue;
      const floating = comp.pins.filter(p => !p.net && /^IN\d*[+-]?$|^IN[+-]\d*$/i.test(p.name || ''));
      if (floating.length) {
        push(mkFinding('R027', 'P3', 'medium', 'component', { designator: comp.designator },
          floating.map(p => pinEvidence(comp, p)), { designators: [comp.designator], uids: [comp.uid] },
          { _subjects: floating.map(p => `pin:${comp.uid}:${p.number}`) }));
      }
    }
  }

  // R028 unused logic gate inputs (strict).
  if (strict) {
    for (const comp of model.components) {
      if (comp.category !== 'ic') continue;
      for (const pin of comp.pins) {
        if (pin.net || !/^(IN|EN|CLK|RST)(\d+)?$/i.test(pin.name || '')) continue;
        push(mkFinding('R028', 'P2', 'medium', 'component',
          { designator: comp.designator, pin: pin.number },
          [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
          { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
      }
    }
  }

  // R030 MOSFET gate pull-down missing.
  for (const comp of model.components) {
    if (comp.category !== 'mosfet') continue;
    const gate = pinByName(comp, /^(G|GATE)\d*$/);
    if (!gate || !gate.net) continue;
    const source = pinByName(comp, /^(S|SOURCE)\d*$/);
    const sourceNet = source?.net || null;
    const refNets = new Set(
      sourceNet
        ? [sourceNet, ...(isGroundNetName(sourceNet)
          ? model.nets.filter(n => n.isGround).map(n => n.name)
          : isPowerNetName(sourceNet) ? model.nets.filter(n => n.isPower).map(n => n.name) : [])]
        : model.nets.filter(n => n.isGround).map(n => n.name),
    );
    const hasPulldown = [...refNets].some(ref => ref && ref !== gate.net && findResistorBetween(model, gate.net, ref));
    if (!hasPulldown) {
      push(mkFinding('R030', 'P2', 'medium', 'component',
        { designator: comp.designator, pin: gate.number },
        [pinEvidence(comp, gate)], { designators: [comp.designator], uids: [comp.uid], nets: [gate.net] },
        { _subjects: [`pin:${comp.uid}:${gate.number}`] }));
    }
  }

  // R031 BJT base resistor missing.
  for (const comp of model.components) {
    if (comp.category !== 'transistor') continue;
    const base = pinByName(comp, /^(B|BASE)\d*$/);
    if (!base || !base.net) continue;
    const hasResistor = model.components.some(c =>
      ['resistor', 'resistor_array'].includes(c.category) && hasPinOnNet(c, base.net) && otherPinNet(c, base.net));
    if (!hasResistor) {
      push(mkFinding('R031', 'P2', 'medium', 'component',
        { designator: comp.designator, pin: base.number },
        [pinEvidence(comp, base)], { designators: [comp.designator], uids: [comp.uid], nets: [base.net] },
        { _subjects: [`pin:${comp.uid}:${base.number}`] }));
    }
  }

  // R032 relay coil flyback diode missing.
  for (const comp of model.components) {
    if (comp.category !== 'relay') continue;
    let coilPins = comp.pins.filter(p => /COIL/i.test(p.name || ''));
    if (!coilPins.length && comp.pins.length === 2) coilPins = comp.pins;
    const coilNets = [...new Set(coilPins.map(p => p.net).filter(Boolean))];
    if (coilNets.length !== 2) continue;
    if (!findDiodeAcross(model, coilNets[0], coilNets[1])) {
      push(mkFinding('R032', 'P1', 'medium', 'component', { designator: comp.designator },
        coilPins.map(p => pinEvidence(comp, p)).concat(coilNets.map(n => ({ kind: 'net', net: n, pins: [] }))),
        { designators: [comp.designator], uids: [comp.uid], nets: coilNets }));
    }
  }

  // R033 regulator feedback divider incomplete.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    const fb = pinByName(comp, /^(FB|VFB|FEEDBACK|ADJ)\d*$/);
    if (!fb || !fb.net) continue;
    const count = countResistorsOn(model, fb.net);
    if (count < 2) {
      push(mkFinding('R033', 'P2', 'medium', 'power',
        { designator: comp.designator, pin: fb.number },
        [pinEvidence(comp, fb)], { designators: [comp.designator], uids: [comp.uid], nets: [fb.net] }));
    }
  }

  // R034 regulator enable pin floating.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    const en = pinByName(comp, /^(EN|ENABLE|SHDN|UVLO)\d*$/);
    if (!en || en.net) continue;
    push(mkFinding('R034', 'P1', 'medium', 'power',
      { designator: comp.designator, pin: en.number },
      [pinEvidence(comp, en)], { designators: [comp.designator], uids: [comp.uid] },
      { _subjects: [`pin:${comp.uid}:${en.number}`] }));
  }

  // R035 two-pin passive has both pins on the same net.
  for (const comp of model.components) {
    if (!['resistor', 'capacitor', 'inductor', 'ferrite', 'diode', 'led', 'crystal', 'fuse', 'tvs'].includes(comp.category)) continue;
    if (comp.pins.length !== 2) continue;
    const [a, b] = comp.pins;
    if (!a.net || a.net !== b.net) continue;
    const value = String(comp.rawValue ?? comp.displayValue ?? '').trim();
    if (/^0(R|Ω|OHM)?$/i.test(value)) continue;
    push(mkFinding('R035', 'P2', 'high', 'connectivity',
      { designator: comp.designator, net: a.net },
      [pinEvidence(comp, a), pinEvidence(comp, b)],
      { designators: [comp.designator], uids: [comp.uid], nets: [a.net] }));
  }

  // R036 regulator output capacitor missing.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    const out = pinByName(comp, /^(OUT|VOUT|VO)\d*$/);
    if (!out || !out.net || isGroundNetName(out.net)) continue;
    if (!findCapToGround(model, out.net)) {
      push(mkFinding('R036', 'P2', 'medium', 'power',
        { designator: comp.designator, pin: out.number, net: out.net },
        [pinEvidence(comp, out)], { designators: [comp.designator], uids: [comp.uid], nets: [out.net] }));
    }
  }

  // R037 LED reverse-biased (anode tied to ground).
  for (const comp of model.components) {
    if (comp.category !== 'led') continue;
    const anode = pinByName(comp, /^A\d*$/);
    const cathode = pinByName(comp, /^K\d*$/);
    if (!anode || !anode.net || !cathode || !cathode.net) continue;
    if (anode.net === cathode.net) continue;
    if (isGroundNetName(anode.net)) {
      push(mkFinding('R037', 'P1', 'high', 'component', { designator: comp.designator },
        [pinEvidence(comp, anode), pinEvidence(comp, cathode)],
        { designators: [comp.designator], uids: [comp.uid], nets: [anode.net, cathode.net] }));
    }
  }

  // R038 polarized capacitor reversed.
  for (const comp of model.components) {
    if (comp.category !== 'capacitor') continue;
    const plus = comp.pins.find(p => /^\+$/.test(String(p.name || '').trim()));
    const minus = comp.pins.find(p => /^-$/.test(String(p.name || '').trim()));
    if (!plus || !minus || !plus.net || !minus.net || plus.net === minus.net) continue;
    if (isGroundNetName(plus.net) || isPowerNetName(minus.net)) {
      push(mkFinding('R038', 'P1', 'high', 'component', { designator: comp.designator },
        [pinEvidence(comp, plus), pinEvidence(comp, minus)],
        { designators: [comp.designator], uids: [comp.uid], nets: [plus.net, minus.net] }));
    }
  }

  // R039 relay flyback diode orientation.
  for (const comp of model.components) {
    if (comp.category !== 'relay') continue;
    let coilPins = comp.pins.filter(p => /COIL/i.test(p.name || ''));
    if (!coilPins.length && comp.pins.length === 2) coilPins = comp.pins;
    const coilNets = [...new Set(coilPins.map(p => p.net).filter(Boolean))];
    if (coilNets.length !== 2) continue;
    const diode = findDiodeAcross(model, coilNets[0], coilNets[1]);
    if (!diode) continue;
    const anode = pinByName(diode, /^A\d*$/);
    const cathode = pinByName(diode, /^K\d*$/);
    if (!anode || !cathode || !anode.net || !cathode.net) continue;
    const powerNet = coilNets.find(n => isPowerNetName(n));
    if (!powerNet) continue;
    if (anode.net === powerNet) {
      push(mkFinding('R039', 'P1', 'high', 'component', { designator: comp.designator },
        [pinEvidence(comp, coilPins[0]), pinEvidence(diode, anode), pinEvidence(diode, cathode)],
        { designators: [comp.designator, diode.designator], uids: [comp.uid, diode.uid], nets: coilNets }));
    }
  }

  // R029 power/ground net conflicts and rail shorts.
  for (const net of model.nets) {
    const pins = [];
    for (const comp of model.components) {
      for (const pin of comp.pins) {
        if (pin.net !== net.name) continue;
        const cls = classifyPinName(pin.name, pin.pinType);
        if (cls.isPower || cls.isGround) pins.push({ comp, pin, cls });
      }
    }
    const hasPower = pins.some(p => p.cls.isPower);
    const hasGround = pins.some(p => p.cls.isGround);
    if (hasPower && hasGround) {
      push(mkFinding('R029', 'P0', 'high', 'power', { net: net.name },
        pins.filter(p => p.cls.isPower || p.cls.isGround).map(p => pinEvidence(p.comp, p.pin)),
        { designators: pins.map(p => p.comp.designator), uids: pins.map(p => p.comp.uid), nets: [net.name] }));
    }
  }
  for (const comp of model.components) {
    if (comp.pins.length !== 2) continue;
    const value = String(comp.rawValue ?? comp.displayValue ?? '').trim();
    const isZero = /^0(R|Ω|OHM)?$/i.test(value) || /jumper|跳线|short/i.test(value);
    if (!isZero) continue;
    const nets = componentNets(comp);
    if (nets.length !== 2) continue;
    if (nets.every(n => isPowerNetName(n)) && nets[0] !== nets[1]) {
      push(mkFinding('R029', 'P0', 'high', 'power', { net: `${nets[0]} / ${nets[1]}` },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator, property: 'Value', value },
          ...nets.map(n => ({ kind: 'net', net: n, pins: [] }))],
        { designators: [comp.designator], uids: [comp.uid], nets }));
    }
  }

  // Suppression: pinned order per PRD.
  const scopedFindings = findings.filter(f => enabled.has(f.ruleId));
  const suppressed = suppressFindings(scopedFindings);
  const deduped = [];
  const seenKeys = new Set();
  for (const f of scopedFindings.filter(x => !x._suppressed)) {
    const key = `${f.ruleId}|${JSON.stringify(f.params || {})}|${JSON.stringify(f.location?.uids || [])}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(f);
  }
  const finalFindings = deduped;

  // Attach page names from model.geometry so the report can show which page a finding is on.
  const compByUid = new Map(model.components.map(c => [c.uid, c]));
  const compsByDesignator = new Map();
  for (const c of model.components) {
    if (!c.designator) continue;
    if (!compsByDesignator.has(c.designator)) compsByDesignator.set(c.designator, []);
    compsByDesignator.get(c.designator).push(c);
  }
  const drcPageByPrimitiveId = new Map();
  for (const page of Object.values(model.geometry?.pages || {})) {
    for (const primitiveId of Object.keys(page.drcPrimitives || {})) {
      if (!drcPageByPrimitiveId.has(primitiveId)) drcPageByPrimitiveId.set(primitiveId, page.pageName || null);
    }
  }
  for (const f of finalFindings) {
    if ((f.location.pages || []).length) continue;
    const pageNames = new Set();
    for (const uid of f.location.uids) {
      const comp = compByUid.get(uid);
      if (comp?.page) pageNames.add(comp.page);
    }
    if (!pageNames.size) {
      for (const designator of f.location.designators) {
        for (const comp of compsByDesignator.get(designator) || []) {
          if (comp.page) pageNames.add(comp.page);
        }
      }
    }
    if (!pageNames.size) {
      for (const e of f.evidence || []) {
        if (e.kind !== 'drc' || !e.primitiveId) continue;
        const pageName = drcPageByPrimitiveId.get(e.primitiveId);
        if (pageName) pageNames.add(pageName);
      }
    }
    f.location.pages = [...pageNames];
  }
  finalFindings.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const d = (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    if (d) return d;
    return a.ruleId.localeCompare(b.ruleId);
  });
  finalFindings.forEach((f, i) => { f.id = `F-${String(i + 1).padStart(3, '0')}`; });

  const result = {
    schemaVersion: '1.0',
    mode,
    findings: finalFindings.map(stripInternal),
    openQuestions: dedupeQuestions(openQuestions).slice(0, 15),
    coverage: {
      skippedRules,
      suppressedFindings: suppressed,
      rulesEvaluated: [...new Set(finalFindings.map(f => f.ruleId))].sort(),
    },
  };
  return result;
}

function suppressFindings(findings) {
  const pinGroup = ['R006', 'R015', 'R011', 'R027', 'R028', 'R034', 'R002'];
  const netGroup = ['R005', 'R004'];
  let count = 0;
  for (const group of [pinGroup, netGroup]) {
    const claimed = new Map();
    const sorted = [...findings].sort((a, b) => group.indexOf(a.ruleId) - group.indexOf(b.ruleId));
    for (const f of sorted) {
      if (!group.includes(f.ruleId)) continue;
      const subjects = f._subjects || [];
      if (subjects.length && subjects.some(s => claimed.has(s))) {
        f._suppressed = true;
        count++;
      } else {
        for (const s of subjects) claimed.set(s, f.ruleId);
      }
    }
  }
  return count;
}

function stripInternal(f) {
  const { _subjects, _suppressed, ...rest } = f;
  return rest;
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return questions.filter(q => {
    const key = q.question;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function lintFile(modelFile, options = {}) {
  const model = readJson(modelFile);
  return lintModel(model, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('用法: node lint.mjs <model.json> [lint.json] [--mode standard|strict] [--bom bom.csv]');
    process.exit(3);
  }
  const modelFile = args[0];
  const out = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const modeIdx = args.indexOf('--mode');
  const bomIdx = args.indexOf('--bom');
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'standard';
  const bomFile = bomIdx >= 0 ? args[bomIdx + 1] : null;
  try {
    const result = lintFile(modelFile, { mode, bomFile });
    if (out) {
      writeJson(out, result);
      console.log(`lint written: ${out} (${result.findings.length} findings, ${result.coverage.suppressedFindings} suppressed)`);
    } else process.stdout.write(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(4);
  }
}
