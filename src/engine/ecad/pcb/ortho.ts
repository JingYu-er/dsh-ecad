import { readFileSync } from "node:fs";

import { distanceToPolygon, inside, type ReferencePoint } from "./reference.js";
import { parsePcbScene, type PcbPadView, type PcbTrackView, type PcbViaView } from "./scene.js";

/** 一段斜线：同一网络、同层、同一方向（±45°）的一串线段。 */
export interface DiagonalRun {
  readonly net: string;
  readonly side: string;
  readonly widthMm: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly lengthMm: number;
  readonly segments: number;
}

export interface OrthoCandidate {
  readonly net: string;
  readonly side: string;
  readonly widthMm: number;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly corner: { x: number; y: number };
  readonly diagonalMm: number;
  readonly detourMm: number;
  readonly feasible: boolean;
  readonly blockedBy: string;
}

export interface OrthoReport {
  readonly ok: boolean;
  readonly error: string;
  readonly boardFile: string;
  readonly runs: DiagonalRun[];
  readonly candidates: OrthoCandidate[];
  readonly diagonalMm: number;
  readonly totalMm: number;
  readonly diagonalShare: number;
  readonly replaced: number;
  readonly kept: number;
  readonly applied: number;
  readonly notes: string[];
}

export const EMPTY_ORTHO: OrthoReport = {
  ok: false,
  error: "",
  boardFile: "",
  runs: [],
  candidates: [],
  diagonalMm: 0,
  totalMm: 0,
  diagonalShare: 0,
  replaced: 0,
  kept: 0,
  applied: 0,
  notes: [],
};

const EPS = 0.001;
const SNAP = 0.01;

interface CopperZone {
  readonly layer: string;
  readonly net: string;
  readonly polygon: readonly ReferencePoint[];
}

function key(x: number, y: number): string {
  return x.toFixed(2) + "," + y.toFixed(2);
}

function lengthOf(track: PcbTrackView): number {
  return Math.hypot(track.x2 - track.x1, track.y2 - track.y1);
}

function isDiagonal(track: PcbTrackView): boolean {
  const dx = Math.abs(track.x2 - track.x1);
  const dy = Math.abs(track.y2 - track.y1);
  if (dx < 0.05 && dy < 0.05) return false;
  if (dx < 0.05 || dy < 0.05) return false;
  return Math.abs(dx - dy) <= Math.max(0.05, 0.02 * Math.max(dx, dy));
}

function directionOf(track: PcbTrackView): string {
  return (track.x2 >= track.x1 ? 1 : -1) + ":" + (track.y2 >= track.y1 ? 1 : -1);
}

/**
 * 找「一条独立的斜线」：同一网络同层、同方向、首尾相接的斜线段串起来，
 * 且两端的连接点不超过 2 个（也就是它只是一条通路，不是总线和汇合点）。
 */
function findRuns(tracks: readonly PcbTrackView[], minRunMm: number): DiagonalRun[] {
  const diagonals = tracks.filter((track) => isDiagonal(track));
  const degree = new Map<string, number>();
  for (const track of tracks) {
    for (const point of [key(track.x1, track.y1), key(track.x2, track.y2)]) {
      const bucket = point + "|" + track.net + "|" + track.side;
      degree.set(bucket, (degree.get(bucket) ?? 0) + 1);
    }
  }

  const used = new Set<PcbTrackView>();
  const runs: DiagonalRun[] = [];
  for (const seed of diagonals) {
    if (used.has(seed)) continue;
    const net = seed.net;
    const side = seed.side;
    const direction = directionOf(seed);
    // 往两端延伸
    const chain: PcbTrackView[] = [seed];
    used.add(seed);
    let head = { x: seed.x1, y: seed.y1 };
    let tail = { x: seed.x2, y: seed.y2 };
    let extended = true;
    while (extended) {
      extended = false;
      for (const other of diagonals) {
        if (used.has(other) || other.net !== net || other.side !== side) continue;
        if (directionOf(other) !== direction) continue;
        if (Math.abs(other.x1 - head.x) < SNAP && Math.abs(other.y1 - head.y) < SNAP) {
          chain.push(other);
          used.add(other);
          head = { x: other.x2, y: other.y2 };
          extended = true;
          break;
        }
        if (Math.abs(other.x2 - head.x) < SNAP && Math.abs(other.y2 - head.y) < SNAP) {
          chain.push(other);
          used.add(other);
          head = { x: other.x1, y: other.y1 };
          extended = true;
          break;
        }
        if (Math.abs(other.x1 - tail.x) < SNAP && Math.abs(other.y1 - tail.y) < SNAP) {
          chain.push(other);
          used.add(other);
          tail = { x: other.x2, y: other.y2 };
          extended = true;
          break;
        }
        if (Math.abs(other.x2 - tail.x) < SNAP && Math.abs(other.y2 - tail.y) < SNAP) {
          chain.push(other);
          used.add(other);
          tail = { x: other.x1, y: other.y1 };
          extended = true;
          break;
        }
      }
    }
    const total = chain.reduce((sum, track) => sum + lengthOf(track), 0);
    if (total < minRunMm - EPS) continue;
    // 两端必须是「断头」或只有一条别的线接着，才允许改成 L 形
    const headFree = (degree.get(key(head.x, head.y) + "|" + net + "|" + side) ?? 0) <= 2;
    const tailFree = (degree.get(key(tail.x, tail.y) + "|" + net + "|" + side) ?? 0) <= 2;
    if (!headFree || !tailFree) continue;
    // 链内每个接点也只能是「两条线接上」，否则改掉这一段会拆掉别的支路。
    const interior = chain
      .map((track) => [key(track.x1, track.y1), key(track.x2, track.y2)] as const)
      .flat()
      .filter((point) => point !== key(head.x, head.y) && point !== key(tail.x, tail.y));
    const branched = interior.some((point) => (degree.get(point + "|" + net + "|" + side) ?? 0) > 2);
    if (branched) continue;
    runs.push({
      net,
      side,
      widthMm: chain[0]?.width ?? 0,
      x1: head.x,
      y1: head.y,
      x2: tail.x,
      y2: tail.y,
      lengthMm: total,
      segments: chain.length,
    });
  }
  return runs;
}

function readZones(text: string): CopperZone[] {
  const zones: CopperZone[] = [];
  const pattern = /\(zone\b/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    let depth = 0;
    let index = start;
    let closed = -1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        while (index < text.length && text[index] !== '"') index += 1;
      } else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closed = index;
          break;
        }
      }
      index += 1;
    }
    if (closed < 0) break;
    const block = text.slice(start, closed + 1);
    const layer = /\(layer\s+"?([^")]+)"?\)/u.exec(block);
    const net = /\(net\s+(?:(\d+)(?:\s+"([^"]*)")?|"([^"]*)")\s*\)/u.exec(block);
    const filled = block.indexOf("(filled_polygon");
    if (layer !== null && filled >= 0) {
      const tail = block.slice(filled);
      const points: ReferencePoint[] = [];
      const xy = /\(xy\s+([-\d.]+)\s+([-\d.]+)\)/gu;
      let point = xy.exec(tail);
      while (point !== null) {
        points.push({ x: Number(point[1]), y: Number(point[2]) });
        point = xy.exec(tail);
      }
      if (points.length >= 3) {
        zones.push({ layer: layer[1] ?? "", net: net === null ? "" : (net[3] ?? net[2] ?? ""), polygon: points });
      }
    }
    pattern.lastIndex = closed + 1;
    match = pattern.exec(text);
  }
  return zones;
}

function segmentDistance(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): number {
  const pointToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length2 = dx * dx + dy * dy;
    if (length2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / length2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => {
    const value = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
    if (Math.abs(value) < 1e-9) return 0;
    return value > 0 ? 1 : 2;
  };
  const crosses =
    cross(ax1, ay1, ax2, ay2, bx1, by1) !== cross(ax1, ay1, ax2, ay2, bx2, by2) &&
    cross(bx1, by1, bx2, by2, ax1, ay1) !== cross(bx1, by1, bx2, by2, ax2, ay2);
  if (crosses) return 0;
  return Math.min(
    pointToSegment(ax1, ay1, bx1, by1, bx2, by2),
    pointToSegment(ax2, ay2, bx1, by1, bx2, by2),
    pointToSegment(bx1, by1, ax1, ay1, ax2, ay2),
    pointToSegment(bx2, by2, ax1, ay1, ax2, ay2),
  );
}

function padRect(pad: PcbPadView): { x0: number; y0: number; x1: number; y1: number } {
  const halfWidth = pad.width / 2;
  const halfHeight = pad.height / 2;
  const angle = ((pad.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const spanX = halfWidth * cos + halfHeight * sin;
  const spanY = halfWidth * sin + halfHeight * cos;
  return { x0: pad.x - spanX, y0: pad.y - spanY, x1: pad.x + spanX, y1: pad.y + spanY };
}

function legBlocked(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  side: string,
  net: string,
  half: number,
  tracks: readonly PcbTrackView[],
  pads: readonly PcbPadView[],
  vias: readonly PcbViaView[],
  zones: readonly CopperZone[],
  clearanceMm: number,
): string {
  for (const other of tracks) {
    if (other.side !== side) continue;
    if (other.net === net) continue;
    if (segmentDistance(ax, ay, bx, by, other.x1, other.y1, other.x2, other.y2) - half - other.width / 2 < clearanceMm) {
      return "走线 " + (other.net === "" ? "（未命名）" : other.net);
    }
  }
  for (const pad of pads) {
    if (pad.side !== side) continue;
    if (pad.net === net) continue;
    const rect = padRect(pad);
    // 线段到矩形：端点与四角互算
    const distance = Math.min(
      segmentDistance(ax, ay, bx, by, rect.x0, rect.y0, rect.x1, rect.y0),
      segmentDistance(ax, ay, bx, by, rect.x1, rect.y0, rect.x1, rect.y1),
      segmentDistance(ax, ay, bx, by, rect.x1, rect.y1, rect.x0, rect.y1),
      segmentDistance(ax, ay, bx, by, rect.x0, rect.y1, rect.x0, rect.y0),
    );
    if (distance - half < clearanceMm) return "焊盘 " + pad.ref + "." + pad.number;
  }
  for (const via of vias) {
    if (via.net === net) continue;
    if (segmentDistance(ax, ay, bx, by, via.x, via.y, via.x, via.y) - half - (via.size ?? 0.6) / 2 < clearanceMm) {
      return "过孔 " + via.net;
    }
  }
  const layer = side === "bottom" ? "B.Cu" : "F.Cu";
  for (const zone of zones) {
    if (zone.layer !== layer) continue;
    if (zone.net !== "" && zone.net === net) continue;
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const px = ax + (bx - ax) * ratio;
      const py = ay + (by - ay) * ratio;
      const point = { x: px, y: py };
      if (inside(zone.polygon, point) || distanceToPolygon(zone.polygon, point) - half < clearanceMm) {
        return "铺铜 " + (zone.net === "" ? "（未命名）" : zone.net);
      }
    }
  }
  return "";
}

/**
 * 斜线改直角计划：把长斜线换成「横一段 + 竖一段」的 L 形，两条腿都要过间距检查。
 *
 * 目标是让走线更像人画的：横平竖直为主，45° 只用于拐角。
 * 不改拓扑（端点不变），只改中间路径；两条 L 都不通就保留原样并写明被谁挡住。
 */
export function planOrthogonalize(
  text: string,
  options: { minRunMm?: number; clearanceMm?: number } = {},
): OrthoReport {
  const minRunMm = options.minRunMm ?? 2;
  const clearanceMm = options.clearanceMm ?? 0.2;
  if (text.trim() === "") return { ...EMPTY_ORTHO, error: "板子文件是空的" };
  const scene = parsePcbScene(text, "ortho");
  const tracks = scene.tracks;
  const zones = readZones(text);
  const totalMm = tracks.reduce((sum, track) => sum + lengthOf(track), 0);
  const diagonalTracks = tracks.filter((track) => isDiagonal(track));
  const diagonalMm = diagonalTracks.reduce((sum, track) => sum + lengthOf(track), 0);
  const runs = findRuns(tracks, minRunMm);
  const candidates: OrthoCandidate[] = [];
  const accepted: PcbTrackView[] = [];
  for (const run of runs) {
    const width = run.widthMm;
    const half = width / 2;
    const corners = [
      { x: run.x2, y: run.y1 },
      { x: run.x1, y: run.y2 },
    ];
    let chosen: OrthoCandidate | null = null;
    for (const corner of corners) {
      const obstacles = accepted.length === 0 ? tracks : tracks.concat(accepted);
      const first = legBlocked(run.x1, run.y1, corner.x, corner.y, run.side, run.net, half, obstacles, scene.pads, scene.vias, zones, clearanceMm);
      const second = first === "" ? legBlocked(corner.x, corner.y, run.x2, run.y2, run.side, run.net, half, obstacles, scene.pads, scene.vias, zones, clearanceMm) : first;
      const blockedBy = first !== "" ? first : second;
      const detour = Math.hypot(corner.x - run.x1, corner.y - run.y1) + Math.hypot(run.x2 - corner.x, run.y2 - corner.y) - run.lengthMm;
      const candidate: OrthoCandidate = {
        net: run.net,
        side: run.side,
        widthMm: width,
        from: { x: run.x1, y: run.y1 },
        to: { x: run.x2, y: run.y2 },
        corner,
        diagonalMm: run.lengthMm,
        detourMm: detour,
        feasible: blockedBy === "",
        blockedBy,
      };
      if (chosen === null || (candidate.feasible && !chosen.feasible)) chosen = candidate;
      if (chosen.feasible) break;
    }
    if (chosen !== null) {
      candidates.push(chosen);
      if (chosen.feasible) {
        const side = chosen.side === "bottom" ? "bottom" : "top";
        accepted.push(
          { x1: chosen.from.x, y1: chosen.from.y, x2: chosen.corner.x, y2: chosen.corner.y, width: chosen.widthMm, side, net: chosen.net },
          { x1: chosen.corner.x, y1: chosen.corner.y, x2: chosen.to.x, y2: chosen.to.y, width: chosen.widthMm, side, net: chosen.net },
        );
      }
    }
  }
  const feasible = candidates.filter((item) => item.feasible);
  const notes: string[] = [];
  if (tracks.length === 0) notes.push("板子上没有走线：没有可改的。");
  else {
    notes.push(
      "斜线占比 " + (diagonalShare(diagonalMm, totalMm) * 100).toFixed(1) + "%（" + String(diagonalMm.toFixed(1)) + " / " + String(totalMm.toFixed(1)) + " mm）。",
    );
    notes.push("长斜线 " + String(runs.length) + " 条，其中 " + String(feasible.length) + " 条能改成 L 形；其余被挡住，如实保留。");
    if (feasible.length > 0) {
      notes.push("改成 L 形会变长 " + String(feasible.reduce((sum, item) => sum + Math.max(0, item.detourMm), 0).toFixed(1)) + " mm（拐角必然多走路），换来横平竖直。");
    }
  }
  return {
    ok: true,
    error: "",
    boardFile: "",
    runs,
    candidates,
    diagonalMm,
    totalMm,
    diagonalShare: diagonalShare(diagonalMm, totalMm),
    replaced: feasible.length,
    kept: runs.length - feasible.length,
    applied: 0,
    notes,
  };
}

function diagonalShare(diagonalMm: number, totalMm: number): number {
  return totalMm <= 0 ? 0 : diagonalMm / totalMm;
}

/** 把可行的候选写回板子：删掉整段斜线，按 L 形插两段。 */
export function applyOrthogonalize(text: string, report: OrthoReport): { text: string; applied: number; removed: number } {
  const targets = report.candidates.filter((item) => item.feasible);
  if (targets.length === 0) return { text, applied: 0, removed: 0 };
  const netIds = new Map<string, string>();
  const idPattern = /\(net\s+(\d+)\s+"([^"]*)"\)/gu;
  let idMatch = idPattern.exec(text);
  while (idMatch !== null) {
    netIds.set(idMatch[2] ?? "", idMatch[1] ?? "");
    idMatch = idPattern.exec(text);
  }
  // 没有声明表、只有内联名字（tscircuit / 部分 KiCad 导出就是这样）时，按名字写。
  const nameForm = netIds.size === 0;

  const blocks: Array<{ start: number; end: number; net: string; side: string; widthMm: number; x1: number; y1: number; x2: number; y2: number }> = [];
  const pattern = /\(segment\b/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    let depth = 0;
    let index = start;
    let closed = -1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        while (index < text.length && text[index] !== '"') index += 1;
      } else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closed = index;
          break;
        }
      }
      index += 1;
    }
    if (closed < 0) break;
    const block = text.slice(start, closed + 1);
    const startPoint = /\(start\s+([-\d.]+)\s+([-\d.]+)\)/u.exec(block);
    const endPoint = /\(end\s+([-\d.]+)\s+([-\d.]+)\)/u.exec(block);
    const width = /\(width\s+([-\d.]+)\)/u.exec(block);
    const layer = /\(layer\s+"?([^")]+)"?\)/u.exec(block);
    const net = /\(net\s+(?:(\d+)(?:\s+"([^"]*)")?|"([^"]*)")\s*\)/u.exec(block);
    if (startPoint !== null && endPoint !== null && width !== null) {
      blocks.push({
        start,
        end: closed + 1,
        net: net === null ? "" : (net[3] ?? net[2] ?? ""),
        side: (layer?.[1] ?? "F.Cu").startsWith("B") ? "bottom" : "top",
        widthMm: Number(width[1]),
        x1: Number(startPoint[1]),
        y1: Number(startPoint[2]),
        x2: Number(endPoint[1]),
        y2: Number(endPoint[2]),
      });
    }
    pattern.lastIndex = closed + 1;
    match = pattern.exec(text);
  }

  let result = text;
  let removed = 0;
  const additions: string[] = [];
  for (const target of targets) {
    // 删掉落在这一段直线上、同网同层、宽度一致的斜线段
    const inside = blocks.filter((block) => {
      if (block.net !== target.net || block.side !== target.side) return false;
      if (Math.abs(block.widthMm - target.widthMm) > EPS) return false;
      const mid = { x: (block.x1 + block.x2) / 2, y: (block.y1 + block.y2) / 2 };
      const onLine = Math.abs((target.to.x - target.from.x) * (mid.y - target.from.y) - (target.to.y - target.from.y) * (mid.x - target.from.x))
        / Math.max(EPS, Math.hypot(target.to.x - target.from.x, target.to.y - target.from.y));
      return onLine < 0.05;
    });
    if (inside.length === 0) continue;
    for (const block of inside) {
      result = result.slice(0, block.start) + " ".repeat(block.end - block.start) + result.slice(block.end);
      removed += 1;
    }
    const netId = netIds.get(target.net);
    if (!nameForm && netId === undefined) continue;
    const netRef = nameForm ? target.net : (netId ?? "");
    additions.push(
      segmentText(target.from.x, target.from.y, target.corner.x, target.corner.y, target.widthMm, target.side, netRef, nameForm),
      segmentText(target.corner.x, target.corner.y, target.to.x, target.to.y, target.widthMm, target.side, netRef, nameForm),
    );
  }
  if (additions.length === 0) return { text, applied: 0, removed };
  const close = result.lastIndexOf(")");
  result = result.slice(0, close) + additions.join("\n") + "\n" + result.slice(close);
  return { text: result.replace(/[ \t]+(?=\n)/gu, ""), applied: additions.length / 2, removed };
}

function segmentText(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  side: string,
  netRef: string,
  nameForm: boolean,
): string {
  const layer = side === "bottom" ? "B.Cu" : "F.Cu";
  // 两种板子两种写法：有网络声明表的写编号（只写编号才合法），名字式的写名字。
  const netPart = nameForm ? '(net "' + netRef + '")' : "(net " + netRef + ")";
  return "\t(segment (start " + x1.toFixed(4) + " " + y1.toFixed(4) + ") (end " + x2.toFixed(4) + " " + y2.toFixed(4) +
    ") (width " + width.toFixed(3) + ') (layer "' + layer + '") ' + netPart + ")";
}

export function readOrthogonalize(
  boardFile: string,
  options: { minRunMm?: number; clearanceMm?: number } = {},
): OrthoReport {
  let text = "";
  try {
    text = readFileSync(boardFile, "utf8");
  } catch (error) {
    return {
      ...EMPTY_ORTHO,
      boardFile,
      error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)),
    };
  }
  return { ...planOrthogonalize(text, options), boardFile };
}
