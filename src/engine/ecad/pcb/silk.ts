import { readFileSync } from "node:fs";

/** 一段丝印线（板级或封装级），世界坐标。 */
export interface SilkSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly layer: string;
  readonly ref: string;
}

/** 一处丝印文字（位号本身或板级文本），世界坐标。 */
export interface SilkText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly layer: string;
  readonly ref: string;
  readonly centered: boolean;
}

export interface SilkPad {
  readonly ref: string;
  readonly number: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly side: "F" | "B";
}

export interface SilkFinding {
  readonly id: string;
  readonly severity: "warning" | "info";
  readonly message: string;
  readonly fix: string;
  readonly ref: string;
  readonly at: { readonly x: number; readonly y: number };
}

export interface SilkHits {
  readonly segments: number;
  readonly texts: number;
  readonly pads: number;
  readonly overPad: number;
  readonly textOnPad: number;
  readonly centered: number;
}

export interface SilkReport {
  readonly ok: boolean;
  readonly error: string;
  readonly boardFile: string;
  readonly hits: SilkHits;
  readonly findings: SilkFinding[];
  readonly notes: string[];
}

export const EMPTY_SILK: SilkReport = {
  ok: false,
  error: "",
  boardFile: "",
  hits: { segments: 0, texts: 0, pads: 0, overPad: 0, textOnPad: 0, centered: 0 },
  findings: [],
  notes: [],
};

interface Block {
  readonly text: string;
  readonly start: number;
}

function blocks(text: string, tag: string): Block[] {
  const found: Block[] = [];
  const pattern = new RegExp("\\(" + tag + "\\b", "gu");
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
        while (index < text.length && text[index] !== '"') {
          if (text[index] === "\\") index += 1;
          index += 1;
        }
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
    found.push({ text: text.slice(start, closed + 1), start });
    pattern.lastIndex = closed + 1;
    match = pattern.exec(text);
  }
  return found;
}

function numbers(text: string, field: string): number[] {
  const found: number[] = [];
  const pattern = new RegExp("\\(" + field + "\\s+([-\\d.]+)\\s+([-\\d.]+)", "gu");
  let match = pattern.exec(text);
  while (match !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) found.push(x, y);
    match = pattern.exec(text);
  }
  return found;
}

function scalar(text: string, field: string): number {
  const match = new RegExp("\\(" + field + "\\s+([-\\d.]+)", "u").exec(text);
  return match === null ? 0 : Number(match[1]);
}

function quoted(text: string, field: string): string {
  const match = new RegExp("\\(" + field + ' (?:reference|value)?\\s*"?([^"\\s)]*)"?', "u").exec(text);
  if (match !== null) return match[1] ?? "";
  const any = new RegExp("\\(" + field + "\\s+\"([^\"]*)\"", "u").exec(text);
  return any === null ? "" : (any[1] ?? "");
}

function referenceOf(footprint: string): string {
  const property = /\(property "Reference" "([^"]*)"/u.exec(footprint);
  if (property !== null) return property[1] ?? "?";
  const fpText = /\(fp_text reference "([^"]*)"/u.exec(footprint);
  if (fpText !== null) return fpText[1] ?? "?";
  return "?";
}

function rotate(x: number, y: number, degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: x * cos + y * sin, y: -x * sin + y * cos };
}

/** 线段与轴对齐矩形是否相交（Liang–Barsky，贴边算相交）。 */
function crosses(segment: SilkSegment, pad: SilkPad): boolean {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, segment.x1 - pad.x0)) return false;
  if (!clip(dx, pad.x1 - segment.x1)) return false;
  if (!clip(-dy, segment.y1 - pad.y0)) return false;
  if (!clip(dy, pad.y1 - segment.y1)) return false;
  return t1 >= t0;
}

interface Parsed {
  readonly segments: SilkSegment[];
  readonly texts: SilkText[];
  readonly pads: SilkPad[];
}

const SILK_LAYER = /^(?:F|B)\.SilkS$/u;

function sideOf(layer: string): "F" | "B" {
  return layer.startsWith("B.") ? "B" : "F";
}

function parseBoard(text: string): Parsed {
  const segments: SilkSegment[] = [];
  const texts: SilkText[] = [];
  const pads: SilkPad[] = [];

  for (const footprint of blocks(text, "footprint")) {
    const body = footprint.text;
    const ref = referenceOf(body);
    const at = numbers(body.slice(0, Math.min(body.length, 400)), "at");
    const fx = at[0] ?? 0;
    const fy = at[1] ?? 0;
    const frot = at[2] ?? 0;
    const reference = ref === "" ? "?" : ref;

    for (const padBlock of blocks(body, "pad")) {
      const pad = padBlock.text;
      const number = /\(pad\s+"?([^"\s]+)"?/u.exec(pad)?.[1] ?? "";
      const padAt = numbers(pad, "at");
      const size = /\(size\s+([-\d.]+)\s+([-\d.]+)\)/u.exec(pad);
      if (size === null) continue;
      const width = Number(size[1]);
      const height = Number(size[2]);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
      const local = rotate(padAt[0] ?? 0, padAt[1] ?? 0, frot);
      const cx = fx + local.x;
      const cy = fy + local.y;
      // 焊盘自身也可旋转：用旋转后的外接半轴，避免把窄焊盘算成一个正方形。
      const padRotation = (padAt[2] ?? 0) + frot;
      const rad = (padRotation * Math.PI) / 180;
      const halfX = Math.abs((width / 2) * Math.cos(rad)) + Math.abs((height / 2) * Math.sin(rad));
      const halfY = Math.abs((width / 2) * Math.sin(rad)) + Math.abs((height / 2) * Math.cos(rad));
      const layerMatch = /\(layers\s+"?(F|B)\.Cu"?/u.exec(pad);
      pads.push({
        ref: reference,
        number,
        x0: cx - halfX,
        y0: cy - halfY,
        x1: cx + halfX,
        y1: cy + halfY,
        side: layerMatch?.[1] === "B" ? "B" : "F",
      });
    }

    const centerLocal = numbers(body, "at");
    const center = rotate(0, 0, frot);
    const bodyCenter = { x: fx + center.x, y: fy + center.y };
    void centerLocal;

    for (const block of blocks(body, "fp_line")) {
      const layer = /\(layer\s+"([^"]+)"\)/u.exec(block.text)?.[1] ?? "";
      if (!SILK_LAYER.test(layer)) continue;
      const start = numbers(block.text, "start");
      const end = numbers(block.text, "end");
      if (start.length < 2 || end.length < 2) continue;
      const p1 = rotate(start[0] ?? 0, start[1] ?? 0, frot);
      const p2 = rotate(end[0] ?? 0, end[1] ?? 0, frot);
      segments.push({ x1: fx + p1.x, y1: fy + p1.y, x2: fx + p2.x, y2: fy + p2.y, layer, ref: reference });
    }

    for (const block of blocks(body, "fp_text")) {
      const layer = /\(layer\s+"([^"]+)"\)/u.exec(block.text)?.[1] ?? "";
      if (!SILK_LAYER.test(layer)) continue;
      const local = numbers(block.text, "at");
      const p = rotate(local[0] ?? 0, local[1] ?? 0, frot);
      const x = fx + p.x;
      const y = fy + p.y;
      const dx = x - bodyCenter.x;
      const dy = y - bodyCenter.y;
      texts.push({
        text: /\(fp_text (?:reference|value|user) "([^"]*)"/u.exec(block.text)?.[1] ?? "",
        x,
        y,
        layer,
        ref: reference,
        centered: Math.hypot(dx, dy) < 1,
      });
    }

    // 封装内的丝印矩形（fp_rect）只取四边
    for (const block of blocks(body, "fp_rect")) {
      const layer = /\(layer\s+"([^"]+)"\)/u.exec(block.text)?.[1] ?? "";
      if (!SILK_LAYER.test(layer)) continue;
      const start = numbers(block.text, "start");
      const end = numbers(block.text, "end");
      if (start.length < 2 || end.length < 2) continue;
      const corners = [
        { x: start[0] ?? 0, y: start[1] ?? 0 },
        { x: end[0] ?? 0, y: start[1] ?? 0 },
        { x: end[0] ?? 0, y: end[1] ?? 0 },
        { x: start[0] ?? 0, y: end[1] ?? 0 },
      ];
      for (let index = 0; index < 4; index += 1) {
        const a = rotate(corners[index]?.x ?? 0, corners[index]?.y ?? 0, frot);
        const b = rotate(corners[(index + 1) % 4]?.x ?? 0, corners[(index + 1) % 4]?.y ?? 0, frot);
        segments.push({ x1: fx + a.x, y1: fy + a.y, x2: fx + b.x, y2: fy + b.y, layer, ref: reference });
      }
    }
  }

  for (const block of blocks(text, "gr_line")) {
    const layer = /\(layer\s+"([^"]+)"\)/u.exec(block.text)?.[1] ?? "";
    if (!SILK_LAYER.test(layer)) continue;
    const start = numbers(block.text, "start");
    const end = numbers(block.text, "end");
    if (start.length < 2 || end.length < 2) continue;
    segments.push({ x1: start[0] ?? 0, y1: start[1] ?? 0, x2: end[0] ?? 0, y2: end[1] ?? 0, layer, ref: "板" });
  }

  for (const block of blocks(text, "gr_text")) {
    const layer = /\(layer\s+"([^"]+)"\)/u.exec(block.text)?.[1] ?? "";
    if (!SILK_LAYER.test(layer)) continue;
    const at = numbers(block.text, "at");
    if (at.length < 2) continue;
    texts.push({
      text: /\(gr_text\s+"([^"]*)"/u.exec(block.text)?.[1] ?? "",
      x: at[0] ?? 0,
      y: at[1] ?? 0,
      layer,
      ref: "板",
      centered: false,
    });
  }

  return { segments, texts, pads };
}

export function analyzeSilk(text: string): SilkReport {
  if (text.trim() === "") return { ...EMPTY_SILK, error: "板子文件是空的" };
  if (!text.includes("(kicad_pcb")) return { ...EMPTY_SILK, error: "没有找到完整的 (kicad_pcb 块，文件可能被截断" };
  const parsed = parseBoard(text);
  const findings: SilkFinding[] = [];
  const notes: string[] = [];

  let overPad = 0;
  for (const segment of parsed.segments) {
    const side = sideOf(segment.layer);
    for (const pad of parsed.pads) {
      if (pad.side !== side) continue;
      if (!crosses(segment, pad)) continue;
      overPad += 1;
      if (findings.filter((finding) => finding.id === "silk.over-pad").length < 12) {
        findings.push({
          id: "silk.over-pad",
          severity: "warning",
          message: segment.ref + " 的丝印压到了 " + (pad.ref === segment.ref ? "本器件" : pad.ref) + " 的焊盘 " + pad.number,
          fix: "把这段丝印挪到焊盘外侧，或在焊盘上开一个丝印缺口；板上印在焊盘上的丝印会被板厂裁掉，装配时还容易和引脚混淆。",
          ref: segment.ref,
          at: { x: segment.x1, y: segment.y1 },
        });
      }
      break;
    }
  }

  let textOnPad = 0;
  for (const textItem of parsed.texts) {
    const side = sideOf(textItem.layer);
    for (const pad of parsed.pads) {
      if (pad.side !== side) continue;
      if (textItem.x < pad.x0 || textItem.x > pad.x1 || textItem.y < pad.y0 || textItem.y > pad.y1) continue;
      textOnPad += 1;
      findings.push({
        id: "silk.text-on-pad",
        severity: "warning",
        message: "丝印文字「" + textItem.text + "」（" + textItem.ref + "）压在焊盘 " + pad.number + " 上",
        fix: "把文字移出焊盘；被焊盘开窗裁掉一半的位号，装配时没人能确认是哪个器件。",
        ref: textItem.ref,
        at: { x: textItem.x, y: textItem.y },
      });
      break;
    }
  }

  const centered = parsed.texts.filter((textItem) => textItem.centered).length;
  if (centered > 0) {
    findings.push({
      id: "silk.centered-ref",
      severity: "info",
      message: "有 " + String(centered) + " 个位号丝印放在器件本体正中",
      fix: "位号挪到本体一角或外侧：居中跨座时印在器件下面，装配和返修都读不到。",
      ref: "",
      at: { x: 0, y: 0 },
    });
  }

  if (parsed.segments.length === 0) notes.push("板子上没有丝印线：这轮只核对了文字与焊盘的关系。");
  notes.push("丝印与焊盘按外接矩形判交（旋转器件用最大边近似），贴边算相交。");

  return {
    ok: overPad === 0 && textOnPad === 0,
    error: "",
    boardFile: "",
    hits: {
      segments: parsed.segments.length,
      texts: parsed.texts.length,
      pads: parsed.pads.length,
      overPad,
      textOnPad,
      centered,
    },
    findings,
    notes,
  };
}

export function readSilk(boardFile: string): SilkReport {
  let text = "";
  try {
    text = readFileSync(boardFile, "utf8");
  } catch (error) {
    return { ...EMPTY_SILK, boardFile, error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)) };
  }
  const report = analyzeSilk(text);
  return { ...report, boardFile };
}

export { scalar };
