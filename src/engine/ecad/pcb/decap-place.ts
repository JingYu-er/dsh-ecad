/**
 * 把去耦电容拉到它服务的电源脚旁边。
 *
 * 放置引擎在「还没有板子」的时候只能按元件中心算位置，它知道「C10 服务 U3」，
 * 不知道 U3 的 V3V3 脚在体边第 48 脚的位置。等板子落下来（焊盘坐标就有了），
 * 就能做一次几何修正：以脚为圆心、向外找第一个不撞别的器件的落点。
 *
 * 这里只动电容，不动其它器件：动 IC 会打乱整块板的布局，收益远大于风险。
 */

import {
  decapCaps,
  readBoardParts,
  schematicDecapPins,
  type LayoutPart,
} from "./layout-check.js";
import { planDecaps } from "./decap-plan.js";

export interface DecapMove {
  ref: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  pin: string;
  pinRef: string;
  net: string;
  beforeMm: number;
  afterMm: number;
}

export interface DecapPlaceResult {
  moves: DecapMove[];
  unchanged: number;
  skipped: string[];
  notes: string[];
}

export interface DecapPlaceOptions {
  /** 元件之间的最小间隙（mm），默认 0.5。 */
  gapMm?: number;
  /** 在脚周围搜索的最大半径（mm），默认 4。 */
  searchMm?: number;
  /** 缩短不到这个距离就不动它（mm），默认 0.5。 */
  minGainMm?: number;
  /** 原理图；没有就按「同网最近焊盘」当目标。 */
  schematicFile?: string;
  /** 这批电容在之前几轮已经挪过：不再动它们，避免在两点之间来回摆。 */
  skipRefs?: readonly string[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(part: LayoutPart): Box {
  return { x: part.x, y: part.y, w: Math.max(part.widthMm, 0.5), h: Math.max(part.heightMm, 0.5) };
}

function hits(box: Box, others: readonly Box[], gap: number): boolean {
  for (const other of others) {
    if (
      Math.abs(box.x - other.x) * 2 < box.w + other.w + gap * 2 &&
      Math.abs(box.y - other.y) * 2 < box.h + other.h + gap * 2
    ) {
      return true;
    }
  }
  return false;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function planDecapMoves(
  boardText: string,
  options: DecapPlaceOptions = {},
): DecapPlaceResult {
  const gap = options.gapMm ?? 0.5;
  const search = options.searchMm ?? 4;
  const minGain = options.minGainMm ?? 0.5;
  const parts = readBoardParts(boardText);
  const caps = decapCaps(parts);
  const pins = options.schematicFile !== undefined && options.schematicFile !== ""
    ? schematicDecapPins(options.schematicFile, parts)
    : [];
  if (caps.length === 0) return { moves: [], unchanged: 0, skipped: [], notes: ["板上没有识别到去耦电容"] };
  if (pins.length === 0) {
    return {
      moves: [],
      unchanged: 0,
      skipped: caps.map((cap) => cap.ref),
      notes: ["没有原理图或原理图里没有 power_in 脚：去耦拉近需要知道「哪根是电源输入脚」，本次跳过"],
    };
  }

  const plan = planDecaps(pins, caps);
  const byRef = new Map(parts.map((part) => [part.ref, part]));
  // 被挪动的电容互相之间也要避让：先按「除电容外」建障碍，每定下一颗就把它占的位置加进去。
  const fixed = parts.filter((part) => !caps.some((cap) => cap.ref === part.ref)).map(boxOf);
  const moves: DecapMove[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  for (const pinReport of plan.pins) {
    const pin = pins.find((item) => item.ref === pinReport.ref && item.pin === pinReport.pin);
    const host = byRef.get(pinReport.ref);
    if (pin === undefined || host === undefined) continue;
    for (const pair of pinReport.caps) {
      const cap = byRef.get(pair.cap);
      if (cap === undefined) continue;
      if (options.skipRefs !== undefined && options.skipRefs.includes(cap.ref)) continue;
      // 以「芯片中心 → 电源脚」的方向朝外，电容放在脚的外侧，避免压到芯片本体。
      const dx = pin.x - host.x;
      const dy = pin.y - host.y;
      const length = Math.hypot(dx, dy) || 1;
      const outward = { x: dx / length, y: dy / length };
      const half = Math.max(cap.widthMm, cap.heightMm) / 2 + Math.max(host.widthMm, host.heightMm) * 0;
      const others = [...fixed];
      let best: { x: number; y: number } | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      const base = Math.max(cap.widthMm, cap.heightMm) / 2 + gap + 0.4;
      for (let step = 0; step < 40; step += 1) {
        const angleOffset = (step % 8) * (Math.PI / 4);
        const radius = base + Math.floor(step / 8) * 0.5;
        if (radius > search) break;
        const cos = Math.cos(angleOffset);
        const sin = Math.sin(angleOffset);
        // 先把基向量绕脚旋转 angleOffset，让候选点沿脚周围散开。
        const dir = {
          x: outward.x * cos - outward.y * sin,
          y: outward.x * sin + outward.y * cos,
        };
        const x = pin.x + dir.x * radius;
        const y = pin.y + dir.y * radius;
        const box: Box = { x, y, w: Math.max(cap.widthMm, 0.5), h: Math.max(cap.heightMm, 0.5) };
        if (hits(box, others, gap)) continue;
        const distance = Math.hypot(x - pin.x, y - pin.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
      if (best === null) {
        skipped.push(cap.ref);
        continue;
      }
      const before = Math.hypot(cap.x - pin.x, cap.y - pin.y);
      const after = Math.hypot(best.x - pin.x, best.y - pin.y);
      if (before - after < minGain) {
        unchanged += 1;
        continue;
      }
      fixed.push({ x: best.x, y: best.y, w: Math.max(cap.widthMm, 0.5), h: Math.max(cap.heightMm, 0.5) });
      moves.push({
        ref: cap.ref,
        from: { x: round3(cap.x), y: round3(cap.y) },
        to: { x: round3(best.x), y: round3(best.y) },
        pin: pin.pin,
        pinRef: pin.ref,
        net: pin.net,
        beforeMm: Math.round(before * 100) / 100,
        afterMm: Math.round(after * 100) / 100,
      });
    }
  }

  const notes: string[] = [];
  if (moves.length > 0) {
    const gain = moves.reduce((sum, move) => sum + (move.beforeMm - move.afterMm), 0) / moves.length;
    notes.push("去耦拉近：挪了 " + String(moves.length) + " 颗，平均缩短 " + String(Math.round(gain * 10) / 10) + " mm");
  }
  if (skipped.length > 0) notes.push("脚边没有空位、没挪：" + skipped.join("、"));
  if (unchanged > 0) notes.push("已经够近、没动：" + String(unchanged) + " 颗");
  if (moves.length === 0 && skipped.length === 0 && unchanged === 0) notes.push("去耦电容都在合适位置");
  return { moves, unchanged, skipped, notes };
}
