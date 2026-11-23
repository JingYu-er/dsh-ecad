/**
 * 布线工整度体检（S227）。
 *
 * 参考「AI 全流程自动 PCB 设计、验证与制造交付技能」（2026-11-21）§7.0.1 的五条工整度
 * 红线：阶梯碎折、90°/锐角、焊盘斜拉、同网无故多次换层、供电细线。这里做能用几何证明
 * 的四条：拐角角度、连续短段、焊盘出口方向、单网过孔数。
 *
 * 只读，不改板子。阈值有默认值，但都允许调用方覆盖——不同板型的合理值不同，报告里
 * 一律给出「判据 + 实际值」，不把默认值当成行业标准。
 *
 * 误报边界：
 * - 焊盘出口只对长宽比 ≥ 1.3 的焊盘判，圆形或近方形焊盘没有长轴；
 * - 一个焊盘上可能接若干 0.05 mm 残段，方向取最长的那一段；
 * - 圆弧目前按起止点当直线，锐角计数可能包含圆弧的弦，报告 notes 里注明；
 * - GND 与电源网的过孔数放行：回流与散热本来就要求多孔。
 */

import { readPcbScene, type PcbPoint, type PcbScene, type PcbTrackView } from "./scene.js";

export type RoutingSeverity = "error" | "warning" | "info";

export interface RoutingFinding {
  readonly id: string;
  readonly severity: RoutingSeverity;
  readonly message: string;
  readonly fix: string;
  readonly net: string;
  readonly refs: readonly string[];
  readonly at: PcbPoint;
}

export interface RoutingStats {
  readonly tracks: number;
  readonly nets: number;
  readonly rightAngles: number;
  readonly acuteAngles: number;
  readonly stairRuns: number;
  readonly badExits: number;
  readonly heavyViaNets: number;
  /** 同网同层走线在顶点处的拐弯次数（不含共线接续）。 */
  readonly bends: number;
  /** 相邻两个拐点方向相反、中间段又短，构成 S 形折的次数。 */
  readonly doglegs: number;
}

export interface RoutingReport {
  readonly ok: boolean;
  readonly error: string;
  readonly boardFile: string;
  readonly stats: RoutingStats;
  readonly findings: readonly RoutingFinding[];
  readonly notes: readonly string[];
}

export interface RoutingOptions {
  /** 拐角转向落在这个闭区间按直角算（度）。默认 80–100。 */
  readonly rightAngleMin?: number;
  readonly rightAngleMax?: number;
  /** 转向超过这个角度按锐角回头算（度）。默认 100。 */
  readonly acuteAngleMin?: number;
  /** 连续短段的长度上限（mm）与段数门槛。默认 2 / 4。 */
  readonly stairMaxMm?: number;
  readonly stairMinSegments?: number;
  /** 焊盘出口与长轴的夹角落在开区间内视为斜拉（度）。默认 20–70。 */
  readonly padExitMin?: number;
  readonly padExitMax?: number;
  /** 单网过孔数上限（只对非电源信号网）。默认 2。 */
  readonly maxViasPerNet?: number;
  /** 中间段短于这个长度、且两端转向相反的折，算 S 形 dogleg（mm）。默认 2。 */
  readonly doglegMaxMm?: number;
  /** 单网拐弯数超过这个值就点出来。默认 6。 */
  readonly bendsPerNet?: number;
}

const EMPTY_STATS: RoutingStats = {
  tracks: 0,
  nets: 0,
  rightAngles: 0,
  acuteAngles: 0,
  stairRuns: 0,
  badExits: 0,
  heavyViaNets: 0,
  bends: 0,
  doglegs: 0,
};

export const EMPTY_ROUTING: RoutingReport = {
  ok: false,
  error: "",
  boardFile: "",
  stats: EMPTY_STATS,
  findings: [],
  notes: [],
};

/** 电源与回流网：多过孔是设计需要，不按信号网的门槛判。 */
const POWER_NET = /(?:GND|AGND|DGND|PGND|VCC|VDD|VBUS|VIN|VBAT|VSYS|V3V3|3V3|3\.3V|5V|12V|AVDD|DVDD)/iu;

const SNAP = 0.01;

function snap(value: number): number {
  return Math.round(value / SNAP) * SNAP;
}

function keyOf(point: PcbPoint): string {
  return String(snap(point.x)) + "," + String(snap(point.y));
}

function distance(a: PcbPoint, b: PcbPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleOf(from: PcbPoint, to: PcbPoint): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/** 两个方向之间的夹角，归一到 0–180。 */
function between(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/** 转向角：直走为 0，直角转弯为 90，原路折返为 180。 */
function turnOf(a: number, b: number): number {
  return 180 - between(a, b);
}

function startOf(segment: PcbTrackView): PcbPoint {
  return { x: segment.x1, y: segment.y1 };
}

function endOf(segment: PcbTrackView): PcbPoint {
  return { x: segment.x2, y: segment.y2 };
}

function other(segment: PcbTrackView, point: PcbPoint): PcbPoint {
  return distance(startOf(segment), point) < SNAP ? endOf(segment) : startOf(segment);
}

function lengthOf(segment: PcbTrackView): number {
  return distance(startOf(segment), endOf(segment));
}

function vertexMap(tracks: readonly PcbTrackView[]): Map<string, { point: PcbPoint; segments: number[] }> {
  const map = new Map<string, { point: PcbPoint; segments: number[] }>();
  tracks.forEach((track, index) => {
    for (const point of [startOf(track), endOf(track)]) {
      const key = keyOf(point);
      const slot = map.get(key);
      if (slot === undefined) map.set(key, { point, segments: [index] });
      else if (!slot.segments.includes(index)) slot.segments.push(index);
    }
  });
  return map;
}

/** 点是否落在焊盘（含余量）的矩形里：只认真正接在焊盘上的走线端点。 */
function insidePad(pad: { x: number; y: number; width: number; height: number; rotation: number }, point: PcbPoint, slop: number): boolean {
  const radians = (-pad.rotation * Math.PI) / 180;
  const dx = point.x - pad.x;
  const dy = point.y - pad.y;
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(localX) <= pad.width / 2 + slop && Math.abs(localY) <= pad.height / 2 + slop;
}

interface Numbers {
  rightAngleMin: number;
  rightAngleMax: number;
  acuteAngleMin: number;
  stairMaxMm: number;
  stairMinSegments: number;
  padExitMin: number;
  padExitMax: number;
  maxViasPerNet: number;
  doglegMaxMm: number;
  bendsPerNet: number;
}

function numbersOf(options: RoutingOptions): Numbers {
  return {
    rightAngleMin: options.rightAngleMin ?? 80,
    rightAngleMax: options.rightAngleMax ?? 100,
    acuteAngleMin: options.acuteAngleMin ?? 100,
    stairMaxMm: options.stairMaxMm ?? 2,
    stairMinSegments: options.stairMinSegments ?? 4,
    padExitMin: options.padExitMin ?? 20,
    padExitMax: options.padExitMax ?? 70,
    maxViasPerNet: options.maxViasPerNet ?? 2,
    doglegMaxMm: options.doglegMaxMm ?? 2,
    bendsPerNet: options.bendsPerNet ?? 6,
  };
}

/**
 * 拐弯次数与 S 形折。
 *
 * 「拐弯」按人眼的定义：同网同层的两条线在顶点相接、且方向不共线（>1°）。
 * 「S 形」是相邻两个拐点转向相反、中间那段又短——人会把这种小折拉直，AI 常为了
 * 躲开障碍先拐一下再拐回来。
 */
function checkBends(
  tracks: readonly PcbTrackView[],
  numbers: Numbers,
  findings: RoutingFinding[],
): { bends: number; doglegs: number } {
  const vertices = vertexMap(tracks);
  const turnByVertex = new Map<string, { turn: number; sign: number }>();
  let bends = 0;
  for (const slot of vertices.values()) {
    if (slot.segments.length !== 2) continue;
    const first = tracks[slot.segments[0]!]!;
    const second = tracks[slot.segments[1]!]!;
    if (first.net !== second.net || first.side !== second.side) continue;
    const inA = other(first, slot.point);
    const inB = other(second, slot.point);
    const turn = turnOf(angleOf(slot.point, inA), angleOf(slot.point, inB));
    if (turn <= 1) continue;
    bends += 1;
    const ax = slot.point.x - inA.x;
    const ay = slot.point.y - inA.y;
    const bx = inB.x - slot.point.x;
    const by = inB.y - slot.point.y;
    const cross = ax * by - ay * bx;
    turnByVertex.set(keyOf(slot.point), { turn, sign: cross > 0 ? 1 : cross < 0 ? -1 : 0 });
  }

  // 中间段两端转向相反 + 段短 = S 形折
  let doglegs = 0;
  for (const track of tracks) {
    if (lengthOf(track) >= numbers.doglegMaxMm) continue;
    const start = turnByVertex.get(keyOf(startOf(track)));
    const end = turnByVertex.get(keyOf(endOf(track)));
    if (start === undefined || end === undefined) continue;
    if (start.sign === 0 || end.sign === 0) continue;
    if (start.sign === end.sign) continue;
    if (start.turn < 15 || end.turn < 15) continue;
    doglegs += 1;
  }

  if (numbers.bendsPerNet > 0) {
    const perNet = new Map<string, number>();
    for (const slot of vertices.values()) {
      const seen = turnByVertex.get(keyOf(slot.point));
      if (seen === undefined) continue;
      const first = tracks[slot.segments[0]!]!;
      perNet.set(first.net, (perNet.get(first.net) ?? 0) + 1);
    }
    let shown = 0;
    for (const [net, count] of [...perNet.entries()].sort((a, b) => b[1] - a[1])) {
      if (count < numbers.bendsPerNet || shown >= 5) break;
      shown += 1;
      findings.push({
        id: "routing.many-bends",
        severity: "info",
        message: "网络 " + (net === "" ? "（未命名）" : net) + " 上拐了 " + String(count) + " 次：同一个网络本可以更直",
        fix: "合并同一方向上的小折；如果是为了躲障碍，先看障碍能不能挪。",
        net,
        refs: [],
        at: { x: 0, y: 0 },
      });
    }
  }

  return { bends, doglegs };
}

/**
 * 只看同网同层的两条线在顶点处的情况：走线在焊盘、过孔处天然会折，跨层也不该按拐角判。
 * 每个顶点最多报一次，避免一条线被数成多段。
 */
function checkCorners(
  tracks: readonly PcbTrackView[],
  numbers: Numbers,
  findings: RoutingFinding[],
): { rightAngles: number; acuteAngles: number } {
  let rightAngles = 0;
  let acuteAngles = 0;
  const vertices = vertexMap(tracks);
  for (const slot of vertices.values()) {
    if (slot.segments.length !== 2) continue;
    const first = tracks[slot.segments[0]!]!;
    const second = tracks[slot.segments[1]!]!;
    if (first.net !== second.net || first.side !== second.side) continue;
    const turn = turnOf(angleOf(slot.point, other(first, slot.point)), angleOf(slot.point, other(second, slot.point)));
    if (turn >= numbers.rightAngleMin && turn <= numbers.rightAngleMax) {
      rightAngles += 1;
      findings.push({
        id: "routing.right-angle",
        severity: "warning",
        message:
          "走线在 (" +
          slot.point.x.toFixed(2) +
          ", " +
          slot.point.y.toFixed(2) +
          ") 转了 " +
          turn.toFixed(0) +
          "°：直角转弯",
        fix: "改成一段 45° 折线，或沿焊盘长轴引出后再转。",
        net: first.net,
        refs: [],
        at: slot.point,
      });
      continue;
    }
    if (turn > numbers.acuteAngleMin) {
      acuteAngles += 1;
      findings.push({
        id: "routing.acute-angle",
        severity: "warning",
        message:
          "走线在 (" +
          slot.point.x.toFixed(2) +
          ", " +
          slot.point.y.toFixed(2) +
          ") 转了 " +
          turn.toFixed(0) +
          "°：锐角回头，蚀刻时容易残留",
        fix: "拉开两段的方向，改成 45° 或圆弧过渡。",
        net: first.net,
        refs: [],
        at: slot.point,
      });
    }
  }
  return { rightAngles, acuteAngles };
}

/**
 * 阶梯碎折：连续若干段都短、且每段都在直角附近转向。
 * 沿同网同层的走线链走一遍，命中即记一次 run，不按段重复计数。
 */
function checkStairs(tracks: readonly PcbTrackView[], numbers: Numbers, findings: RoutingFinding[]): number {
  const vertices = vertexMap(tracks);
  const visited = new Set<string>();
  let runs = 0;
  for (const [key, slot] of vertices) {
    if (visited.has(key)) continue;
    if (slot.segments.length < 2) continue;
    for (const index of slot.segments) {
      const head = tracks[index]!;
      if (lengthOf(head) > numbers.stairMaxMm) continue;
      if (POWER_NET.test(head.net)) continue;
      let current = slot.point;
      let currentIndex = index;
      let chain = 0;
      let previousAngle = Number.NaN;
      for (;;) {
        const segment = tracks[currentIndex]!;
        chain += 1;
        visited.add(keyOf(current));
        const next = other(segment, current);
        visited.add(keyOf(next));
        const direction = angleOf(current, next);
        if (Number.isFinite(previousAngle)) {
          const turn = turnOf(previousAngle, direction);
          if (turn < numbers.rightAngleMin || turn > numbers.rightAngleMax) break;
        }
        previousAngle = direction;
        const nextSlot = vertices.get(keyOf(next));
        if (nextSlot === undefined) break;
        const candidates = nextSlot.segments.filter(
          (candidate) =>
            candidate !== currentIndex && tracks[candidate]!.net === segment.net && tracks[candidate]!.side === segment.side,
        );
        if (candidates.length !== 1) break;
        const candidate = tracks[candidates[0]!]!;
        if (lengthOf(candidate) > numbers.stairMaxMm) break;
        current = next;
        currentIndex = candidates[0]!;
      }
      if (chain >= numbers.stairMinSegments) {
        runs += 1;
        findings.push({
          id: "routing.stair-step",
          severity: "warning",
          message:
            "网络 " +
            (head.net === "" ? "(未命名)" : head.net) +
            " 在 (" +
            slot.point.x.toFixed(2) +
            ", " +
            slot.point.y.toFixed(2) +
            ") 附近有 " +
            String(chain) +
            " 段连续短折（每段 < " +
            numbers.stairMaxMm.toFixed(1) +
            " mm）",
          fix: "先定这条线的通道轴线，用一到两段 45° 折过去，不要逐格逼近。",
          net: head.net,
          refs: [],
          at: slot.point,
        });
      }
    }
  }
  return runs;
}

/**
 * 焊盘斜拉：导线从焊盘角落斜向拉出。只对长宽比明显的焊盘判；方向取最长的接触段，
 * 避免被焊盘上的 0.05 mm 残段带偏。
 */
function checkPadExits(
  tracks: readonly PcbTrackView[],
  scene: PcbScene,
  numbers: Numbers,
  findings: RoutingFinding[],
): number {
  let bad = 0;
  const seen = new Set<string>();
  for (const pad of scene.pads) {
    const long = Math.max(pad.width, pad.height);
    const short = Math.min(pad.width, pad.height);
    if (short <= 0 || long / short < 1.3) continue;
    const axis = pad.width >= pad.height ? pad.rotation : pad.rotation + 90;
    const reach = Math.hypot(pad.width, pad.height) / 2 + 0.25;
    let bestLength = 0;
    let bestDirection = Number.NaN;
    for (const track of tracks) {
      if (track.net !== pad.net || track.net === "") continue;
      const head =
        distance(startOf(track), { x: pad.x, y: pad.y }) < reach && insidePad(pad, startOf(track), 0.3)
          ? startOf(track)
          : null;
      const tail =
        distance(endOf(track), { x: pad.x, y: pad.y }) < reach && insidePad(pad, endOf(track), 0.3) ? endOf(track) : null;
      const touch = head ?? tail;
      if (touch === null) continue;
      const length = lengthOf(track);
      if (length < 0.3 || length <= bestLength) continue;
      bestLength = length;
      bestDirection = head === null ? angleOf(touch, startOf(track)) : angleOf(touch, endOf(track));
    }
    if (!Number.isFinite(bestDirection)) continue;
    const raw = between(bestDirection, axis);
    const skew = raw > 90 ? 180 - raw : raw;
    if (skew <= numbers.padExitMin || skew >= numbers.padExitMax) continue;
    const key = pad.ref + "." + pad.number;
    if (seen.has(key)) continue;
    seen.add(key);
    bad += 1;
    findings.push({
      id: "routing.pad-exit",
      severity: "info",
      message:
        pad.ref +
        " 的 " +
        pad.number +
        " 脚（" +
        (pad.net === "" ? "未命名网络" : pad.net) +
        "）导线从焊盘斜向引出，与长轴差 " +
        skew.toFixed(0) +
        "°（该段 " +
        bestLength.toFixed(2) +
        " mm）",
      fix: "先沿焊盘长轴平直引出一小段，再转 45°。",
      net: pad.net,
      refs: [pad.ref],
      at: { x: pad.x, y: pad.y },
    });
  }
  return bad;
}

/** 单网过孔数：普通信号网换层超过上限就点名，电源网放行。 */
function checkVias(scene: PcbScene, numbers: Numbers, findings: RoutingFinding[]): number {
  const counts = new Map<string, number>();
  for (const via of scene.vias) {
    if (via.net === "" || POWER_NET.test(via.net)) continue;
    counts.set(via.net, (counts.get(via.net) ?? 0) + 1);
  }
  let heavy = 0;
  for (const [net, count] of counts) {
    if (count <= numbers.maxViasPerNet) continue;
    heavy += 1;
    const first = scene.vias.find((via) => via.net === net);
    findings.push({
      id: "routing.via-count",
      severity: "info",
      message: "网络 " + net + " 用了 " + String(count) + " 个过孔换层",
      fix: "核每个过孔是否必要；能同层走完的段不必换层。",
      net,
      refs: [],
      at: first === undefined ? { x: 0, y: 0 } : { x: first.x, y: first.y },
    });
  }
  return heavy;
}

export function analyzeRouting(scene: PcbScene, options: RoutingOptions = {}): RoutingReport {
  if (!scene.ok) {
    return {
      ...EMPTY_ROUTING,
      boardFile: scene.file,
      error: scene.error === "" ? "读不到这块板子的几何" : scene.error,
    };
  }
  const numbers = numbersOf(options);
  const findings: RoutingFinding[] = [];
  // 内层走线不进 scene.tracks：工整度只在画得出的铜层上判，报告里说明范围。
  const tracks = scene.tracks;
  const corners = checkCorners(tracks, numbers, findings);
  const stairRuns = checkStairs(tracks, numbers, findings);
  const badExits = checkPadExits(tracks, scene, numbers, findings);
  const heavyViaNets = checkVias(scene, numbers, findings);
  const bent = checkBends(tracks, numbers, findings);

  const nets = new Set<string>();
  for (const track of tracks) if (track.net !== "") nets.add(track.net);
  for (const pad of scene.pads) if (pad.net !== "") nets.add(pad.net);
  for (const via of scene.vias) if (via.net !== "") nets.add(via.net);

  const notes: string[] = [];
  if (scene.innerTracks > 0) {
    notes.push("内层还有 " + String(scene.innerTracks) + " 段走线，本次工整度检查只看了外层。");
  }
  if (scene.arcs > 0) {
    notes.push("有 " + String(scene.arcs) + " 段圆弧按起止点当直线判：锐角计数里可能包含圆弧的弦。");
  }
  if (tracks.length === 0) notes.push("板子上没有走线：没有可检查的布线。");
  if (findings.length === 0 && tracks.length > 0) notes.push("没有发现直角、阶梯碎折、焊盘斜拉或过多换层。");

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    error: "",
    boardFile: scene.file,
    stats: {
      tracks: tracks.length,
      nets: nets.size,
      rightAngles: corners.rightAngles,
      acuteAngles: corners.acuteAngles,
      stairRuns,
      badExits,
      heavyViaNets,
      bends: bent.bends,
      doglegs: bent.doglegs,
    },
    findings,
    notes,
  };
}

export function readRouting(boardFile: string, options: RoutingOptions = {}): RoutingReport {
  return analyzeRouting(readPcbScene(boardFile), options);
}
