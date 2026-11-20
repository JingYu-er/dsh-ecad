/**
 * 合并共线走线段（S201）。
 *
 * 网格布线器会把一条直线拆成很多 0.05 mm 的小段（焊盘出口、45° 平滑的产物）。
 * 几何上等价，但读起来「线很碎」，也让人以为走了很多弯。这里只做一件事：
 * 把首尾相接、同网同层同宽、且方向共线的段并成一段。不动端点、不动宽度、
 * 不碰过孔，所以 DRC 结果不会变。
 */
import { parenBlocks } from "./emc.js";

export interface TrackMergeResult {
  readonly text: string;
  readonly before: number;
  readonly after: number;
  readonly merged: number;
}

interface Segment {
  readonly block: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: string;
  readonly layer: string;
  readonly net: string;
}

const START = /\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u;
const END = /\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u;
const WIDTH = /\(width\s+([\d.]+)\)/u;
const LAYER = /\(layer\s+"([^"]+)"\)/u;
const NET = /\(net\s+"([^"]+)"\)/u;

function number(text: string | undefined): number {
  return text === undefined ? 0 : Number(text);
}

function parseSegment(block: string): Segment | null {
  const start = START.exec(block);
  const end = END.exec(block);
  const width = WIDTH.exec(block);
  const layer = LAYER.exec(block);
  const net = NET.exec(block);
  if (start === null || end === null || width === null || layer === null) return null;
  return {
    block,
    x1: number(start[1]),
    y1: number(start[2]),
    x2: number(end[1]),
    y2: number(end[2]),
    width: width[1] ?? "",
    layer: layer[1] ?? "",
    net: net === null ? "" : net[1] ?? "",
  };
}

const key = (x: number, y: number): string => x.toFixed(4) + "," + y.toFixed(4);

/** 两段是否在同一直线上继续（从共享点各往一侧延伸）：叉积≈0 且点积<0。 */
function straightThrough(far: { x: number; y: number }, shared: { x: number; y: number }, other: { x: number; y: number }): boolean {
  const ax = far.x - shared.x;
  const ay = far.y - shared.y;
  const bx = other.x - shared.x;
  const by = other.y - shared.y;
  const lengthA = Math.hypot(ax, ay);
  const lengthB = Math.hypot(bx, by);
  if (lengthA === 0 || lengthB === 0) return false;
  const cross = Math.abs((ax / lengthA) * (by / lengthB) - (ay / lengthA) * (bx / lengthB));
  if (cross > 1e-6) return false;
  return (ax / lengthA) * (bx / lengthB) + (ay / lengthA) * (by / lengthB) < 0;
}

function renderSegment(segment: Segment, x1: number, y1: number, x2: number, y2: number): string {
  return (
    "(segment\n\t\t(start " + String(x1) + " " + String(y1) + ")\n" +
    "\t\t(end " + String(x2) + " " + String(y2) + ")\n" +
    "\t\t(width " + segment.width + ")\n" +
    "\t\t(layer \"" + segment.layer + "\")\n" +
    "\t\t(net " + (segment.net === "" ? "\"\"" : '"' + segment.net + '"') + ")\n" +
    "\t\t(uuid \"" + randomUuid() + "\")\n" +
    "\t)"
  );
}

let counter = 0;
function randomUuid(): string {
  // 不引入依赖：时间 + 计数 + 随机，够 pcbnew 认唯一即可。
  counter += 1;
  const rnd = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const stamp = Date.now().toString(16).padStart(12, "0");
  return stamp.slice(0, 8) + "-" + stamp.slice(8, 12) + "-4" + rnd.slice(0, 3) + "-a" + rnd.slice(3, 6) + "-" + rnd + counter.toString(16).padStart(4, "0");
}

export function mergeCollinearTracks(pcbText: string): TrackMergeResult {
  const blocks = parenBlocks(pcbText, "segment");
  const segments: Segment[] = [];
  for (const block of blocks) {
    const parsed = parseSegment(block);
    if (parsed !== null) segments.push(parsed);
  }
  const before = segments.length;
  if (before === 0) return { text: pcbText, before: 0, after: 0, merged: 0 };

  // 端点 → 段索引。合并时按组处理，避免把不同网络的段拉到一起。
  const alive = segments.map(() => true);
  let mergedCount = 0;
  const ends = (segment: Segment): Array<{ x: number; y: number }> => [{ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }];
  const at = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const point of ends(segment)) {
      const name = key(point.x, point.y) + "|" + segment.layer + "|" + segment.net + "|" + segment.width;
      const list = at.get(name) ?? [];
      list.push(index);
      at.set(name, list);
    }
  });

  /** 找共享点，并给出两段各自的远端。 */
  function farEnds(a: Segment, b: Segment): { shared: { x: number; y: number }; farA: { x: number; y: number }; farB: { x: number; y: number } } | null {
    const combos: Array<[number, number, number, number]> = [
      [a.x2, a.y2, b.x1, b.y1],
      [a.x2, a.y2, b.x2, b.y2],
      [a.x1, a.y1, b.x1, b.y1],
      [a.x1, a.y1, b.x2, b.y2],
    ];
    for (const [ax, ay, bx, by] of combos) {
      if (Math.abs(ax - bx) > 1e-9 || Math.abs(ay - by) > 1e-9) continue;
      const shared = { x: ax, y: ay };
      const farA = Math.abs(a.x1 - ax) < 1e-9 && Math.abs(a.y1 - ay) < 1e-9 ? { x: a.x2, y: a.y2 } : { x: a.x1, y: a.y1 };
      const farB = Math.abs(b.x1 - bx) < 1e-9 && Math.abs(b.y1 - by) < 1e-9 ? { x: b.x2, y: b.y2 } : { x: b.x1, y: b.y1 };
      return { shared, farA, farB };
    }
    return null;
  }

  for (let index = 0; index < segments.length; index += 1) {
    if (!alive[index]) continue;
    let current = segments[index]!;
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of [[current.x1, current.y1], [current.x2, current.y2]]) {
        const bucket = at.get(key(candidate[0]!, candidate[1]!) + "|" + current.layer + "|" + current.net + "|" + current.width) ?? [];
        for (const otherIndex of bucket) {
          if (otherIndex === index || !alive[otherIndex]) continue;
          const other = segments[otherIndex]!;
          const ends = farEnds(current, other);
          if (ends === null || !straightThrough(ends.farA, ends.shared, ends.farB)) continue;
          current = {
            block: current.block,
            x1: ends.farA.x,
            y1: ends.farA.y,
            x2: ends.farB.x,
            y2: ends.farB.y,
            width: current.width,
            layer: current.layer,
            net: current.net,
          };
          alive[otherIndex] = false;
          mergedCount += 1;
          changed = true;
          break;
        }
        if (changed) break;
      }
    }
    segments[index] = current;
  }

  // 删除原段块，把合并后的段插在最后一个 ")" 之前
  let stripped = pcbText;
  for (const block of blocks) {
    const index = stripped.indexOf(block);
    if (index >= 0) stripped = stripped.slice(0, index) + stripped.slice(index + block.length);
  }
  const kept = segments.filter((_, index) => alive[index] && !(segments[index]!.x1 === segments[index]!.x2 && segments[index]!.y1 === segments[index]!.y2));
  const rendered = kept.map((segment) => "\t" + renderSegment(segment, segment.x1, segment.y1, segment.x2, segment.y2) + "\n").join("");
  const close = stripped.lastIndexOf(")");
  const text = stripped.slice(0, close) + rendered + stripped.slice(close);
  return { text, before, after: kept.length, merged: mergedCount };
}
