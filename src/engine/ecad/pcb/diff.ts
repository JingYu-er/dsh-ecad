import { readFileSync, writeFileSync } from "node:fs";

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

export interface SegmentView {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly layer: string;
  readonly net: string;
}

export interface ViaView {
  readonly x: number;
  readonly y: number;
  readonly drill: number;
  readonly net: string;
}

export interface LayerDiff {
  readonly layer: string;
  readonly before: number;
  readonly after: number;
  readonly added: number;
  readonly removed: number;
  readonly addedMm: number;
  readonly removedMm: number;
}

export interface DiffStats {
  readonly beforeSegments: number;
  readonly afterSegments: number;
  readonly added: number;
  readonly removed: number;
  readonly addedMm: number;
  readonly removedMm: number;
  readonly addedVias: number;
  readonly removedVias: number;
}

export interface DiffFinding {
  readonly id: string;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly fix: string;
}

export interface BoardDiff {
  readonly ok: boolean;
  readonly error: string;
  readonly beforeFile: string;
  readonly afterFile: string;
  readonly layers: readonly LayerDiff[];
  readonly stats: DiffStats;
  readonly findings: readonly DiffFinding[];
  readonly notes: readonly string[];
}

export interface DiffSvg {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
  readonly layers: readonly string[];
  readonly widthMm: number;
  readonly heightMm: number;
  readonly notes: readonly string[];
}

export const EMPTY_DIFF: BoardDiff = {
  ok: false,
  error: "",
  beforeFile: "",
  afterFile: "",
  layers: [],
  stats: { beforeSegments: 0, afterSegments: 0, added: 0, removed: 0, addedMm: 0, removedMm: 0, addedVias: 0, removedVias: 0 },
  findings: [],
  notes: [],
};

export const EMPTY_DIFF_SVG: DiffSvg = { ok: false, error: "", file: "", layers: [], widthMm: 0, heightMm: 0, notes: [] };

const SNAP = 0.01;
const KEY = 2;

function snap(value: number): number {
  return Math.round(value / SNAP) * SNAP;
}

function key(x: number, y: number): string {
  return snap(x).toFixed(KEY) + "," + snap(y).toFixed(KEY);
}

/** 走线按「两端点排序 + 层 + 宽度」认身份：同一条线方向写反也算同一条。 */
function segmentKey(segment: SegmentView): string {
  const a = key(segment.x1, segment.y1);
  const b = key(segment.x2, segment.y2);
  return (a < b ? a + "|" + b : b + "|" + a) + "@" + segment.layer + "#" + segment.width.toFixed(3);
}

interface Block {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function blocks(text: string, tag: string): Block[] {
  const out: Block[] = [];
  const pattern = new RegExp("\\(" + tag + "\\b", "gu");
  let hit = pattern.exec(text);
  while (hit !== null) {
    let depth = 0;
    let quoted = false;
    let end = -1;
    for (let i = hit.index; i < text.length; i += 1) {
      const char = text[i];
      if (char === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    out.push({ start: hit.index, end, text: text.slice(hit.index, end + 1) });
    pattern.lastIndex = end + 1;
    hit = pattern.exec(text);
  }
  return out;
}

function numbers(text: string, field: string): number[] {
  const hit = new RegExp("\\(" + field + "\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)(?:\\s+-?\\d+(?:\\.\\d+)?)?", "u").exec(text);
  if (hit === null) return [];
  return [Number(hit[1]), Number(hit[2])];
}

function quoted(text: string, field: string): string {
  const hit = new RegExp("\\(" + field + "\\s+\"([^\"]*)\"", "u").exec(text);
  return hit === null || hit[1] === undefined ? "" : hit[1];
}

function scalar(text: string, field: string): number {
  const hit = new RegExp("\\(" + field + "\\s+(-?\\d+(?:\\.\\d+)?)", "u").exec(text);
  return hit === null ? 0 : Number(hit[1]);
}

function numberNet(text: string): number {
  const hit = /\(net\s+(\d+)/u.exec(text);
  return hit === null ? -1 : Number(hit[1]);
}

function parseBoard(text: string): { segments: SegmentView[]; vias: ViaView[]; netNames: Map<string, string> } {
  const netNames = new Map<string, string>();
  for (const block of blocks(text, "net")) {
    const id = numberNet(block.text);
    const name = quoted(block.text, "net");
    if (name === "") {
      const nameHit = /\(net\s+\d+\s+"([^"]*)"/u.exec(block.text);
      const resolved = nameHit === null ? undefined : nameHit[1];
      if (resolved !== undefined) netNames.set(String(id), resolved);
    } else netNames.set(String(id), name);
  }
  const segments: SegmentView[] = [];
  for (const block of blocks(text, "segment")) {
    const layer = quoted(block.text, "layer");
    if (!layer.endsWith(".Cu")) continue;
    const start = numbers(block.text, "start");
    const end = numbers(block.text, "end");
    const sx = start[0];
    const sy = start[1];
    const ex = end[0];
    const ey = end[1];
    if (sx === undefined || sy === undefined || ex === undefined || ey === undefined) continue;
    const id = numberNet(block.text);
    segments.push({
      x1: sx, y1: sy, x2: ex, y2: ey,
      width: scalar(block.text, "width"),
      layer,
      net: netNames.get(String(id)) ?? "",
    });
  }
  const vias: ViaView[] = [];
  for (const block of blocks(text, "via")) {
    const at = numbers(block.text, "at");
    const vx = at[0];
    const vy = at[1];
    if (vx === undefined || vy === undefined) continue;
    const id = numberNet(block.text);
    vias.push({ x: vx, y: vy, drill: scalar(block.text, "drill"), net: netNames.get(String(id)) ?? "" });
  }
  return { segments, vias, netNames };
}

function lengthOf(segment: SegmentView): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

function keyOfVia(via: ViaView): string {
  return key(via.x, via.y) + "D" + via.drill.toFixed(2);
}

/** 逐层对比两块板的铜：新增/删除的段数与长度、新增/删除的过孔。 */
export function analyzeDiff(beforeText: string, afterText: string): BoardDiff {
  const before = parseBoard(beforeText);
  const after = parseBoard(afterText);
  const beforeKeys = new Map(before.segments.map((segment) => [segmentKey(segment), segment]));
  const afterKeys = new Map(after.segments.map((segment) => [segmentKey(segment), segment]));
  const layers = new Set<string>();
  for (const segment of before.segments) layers.add(segment.layer);
  for (const segment of after.segments) layers.add(segment.layer);

  const layerDiffs: LayerDiff[] = [];
  const findings: DiffFinding[] = [];
  let added = 0;
  let removed = 0;
  let addedMm = 0;
  let removedMm = 0;
  for (const layer of [...layers].sort()) {
    let addCount = 0;
    let removeCount = 0;
    let addMm = 0;
    let removeMm = 0;
    for (const [k, segment] of afterKeys) {
      if (segment.layer !== layer) continue;
      if (!beforeKeys.has(k)) {
        addCount += 1;
        addMm += lengthOf(segment);
      }
    }
    for (const [k, segment] of beforeKeys) {
      if (segment.layer !== layer) continue;
      if (!afterKeys.has(k)) {
        removeCount += 1;
        removeMm += lengthOf(segment);
      }
    }
    layerDiffs.push({
      layer,
      before: [...beforeKeys.values()].filter((segment) => segment.layer === layer).length,
      after: [...afterKeys.values()].filter((segment) => segment.layer === layer).length,
      added: addCount,
      removed: removeCount,
      addedMm: addMm,
      removedMm: removeMm,
    });
    added += addCount;
    removed += removeCount;
    addedMm += addMm;
    removedMm += removeMm;
    if (layer !== "F.Cu" && layer !== "B.Cu" && addCount + removeCount > 0) {
      findings.push({
        id: "diff.inner-layer-change",
        severity: "info",
        message: "内层 " + layer + " 有改动：新增 " + String(addCount) + " 段、删除 " + String(removeCount) + " 段",
        fix: "内层改动最容易漏看：用 stm32_pcb_layers 对照同一层的图确认，别只看外层。",
      });
    }
  }

  const beforeVias = new Set(before.vias.map(keyOfVia));
  const afterVias = new Set(after.vias.map(keyOfVia));
  let addedVias = 0;
  let removedVias = 0;
  for (const k of afterVias) if (!beforeVias.has(k)) addedVias += 1;
  for (const k of beforeVias) if (!afterVias.has(k)) removedVias += 1;

  const notes: string[] = [];
  if (added === 0 && removed === 0 && addedVias === 0 && removedVias === 0) {
    notes.push("两块板的铜完全一致：没有新增或删除的走线与过孔。");
  }
  notes.push("对比口径：走线按「两端点 + 层 + 宽度」认身份，方向写反不算改；两端各吸附 0.01 mm。");
  notes.push("这条只比几何，不比网络：同一位置换了网络名也看不出来，需要 stm32_netgate 兜。");
  if (added + removed > 0) {
    findings.unshift({
      id: "diff.summary",
      severity: "warning",
      message: "铜有改动：新增 " + String(added) + " 段（" + addedMm.toFixed(1) + " mm）、删除 "
        + String(removed) + " 段（" + removedMm.toFixed(1) + " mm）、过孔 +" + String(addedVias) + "/-" + String(removedVias),
      fix: "逐层看图确认改动是否符合预期；只靠 DRC 通过不能说明改对了地方。",
    });
  }

  return {
    ok: true,
    error: "",
    beforeFile: "",
    afterFile: "",
    layers: layerDiffs,
    stats: {
      beforeSegments: before.segments.length,
      afterSegments: after.segments.length,
      added, removed, addedMm, removedMm, addedVias, removedVias,
    },
    findings,
    notes,
  };
}

export function readDiff(beforeFile: string, afterFile: string): BoardDiff {
  try {
    const report = analyzeDiff(readText(beforeFile), readText(afterFile));
    return { ...report, beforeFile, afterFile };
  } catch (error) {
    return { ...EMPTY_DIFF, error: "读板子失败：" + (error instanceof Error ? error.message : String(error)), beforeFile, afterFile };
  }
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(segments: readonly SegmentView[]): Box {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    x0 = Math.min(x0, segment.x1, segment.x2);
    y0 = Math.min(y0, segment.y1, segment.y2);
    x1 = Math.max(x1, segment.x1, segment.x2);
    y1 = Math.max(y1, segment.y1, segment.y2);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0, y0, x1, y1 };
}

/** 把「删除的线」与「新增的线」画在同一张图上：同原点、同比例，红灰=旧、绿=新。 */
export function renderDiffSvg(beforeText: string, afterText: string, options: { layers?: readonly string[]; onlyChanges?: boolean } = {}): { svg: string; layers: string[]; box: Box } {
  const before = parseBoard(beforeText);
  const after = parseBoard(afterText);
  const onlyChanges = options.onlyChanges !== false;
  const beforeKeys = new Set(before.segments.map(segmentKey));
  const afterKeys = new Set(after.segments.map(segmentKey));
  const layers = options.layers === undefined || options.layers.length === 0
    ? [...new Set([...before.segments, ...after.segments].map((segment) => segment.layer))].sort()
    : [...options.layers];
  const layerSet = new Set(layers);
  const removed = before.segments.filter((segment) => layerSet.has(segment.layer) && !afterKeys.has(segmentKey(segment)));
  const added = after.segments.filter((segment) => layerSet.has(segment.layer) && !beforeKeys.has(segmentKey(segment)));
  const unchangedBefore = before.segments.filter((segment) => layerSet.has(segment.layer) && afterKeys.has(segmentKey(segment)));
  const drawable = onlyChanges ? [...removed, ...added] : [...unchangedBefore, ...removed, ...added];
  const box = boxOf(drawable.length > 0 ? drawable : before.segments);
  const pad = 2;
  const widthMm = Math.max(1, box.x1 - box.x0 + pad * 2);
  const heightMm = Math.max(1, box.y1 - box.y0 + pad * 2);
  const scale = 8;
  const px = (value: number): number => Math.round((value - box.x0 + pad) * scale * 100) / 100;
  const py = (value: number): number => Math.round((value - box.y0 + pad) * scale * 100) / 100;

  const strokes: string[] = [];
  if (!onlyChanges) {
    for (const segment of unchangedBefore) {
      strokes.push('<line x1="' + px(segment.x1) + '" y1="' + py(segment.y1) + '" x2="' + px(segment.x2) + '" y2="' + py(segment.y2)
        + '" stroke="#b9bec6" stroke-width="' + Math.max(0.6, segment.width * scale).toFixed(2) + '" stroke-linecap="round" />');
    }
  }
  for (const segment of removed) {
    strokes.push('<line x1="' + px(segment.x1) + '" y1="' + py(segment.y1) + '" x2="' + px(segment.x2) + '" y2="' + py(segment.y2)
      + '" stroke="#c03a2b" stroke-width="' + Math.max(0.8, segment.width * scale).toFixed(2) + '" stroke-linecap="round" />');
  }
  for (const segment of added) {
    strokes.push('<line x1="' + px(segment.x1) + '" y1="' + py(segment.y1) + '" x2="' + px(segment.x2) + '" y2="' + py(segment.y2)
      + '" stroke="#1f7a3f" stroke-width="' + Math.max(0.8, segment.width * scale).toFixed(2) + '" stroke-linecap="round" />');
  }
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(widthMm * scale) + '" height="' + Math.round(heightMm * scale)
      + '" viewBox="0 0 ' + Math.round(widthMm * scale) + ' ' + Math.round(heightMm * scale) + '">',
    '<rect x="0" y="0" width="100%" height="100%" fill="#ffffff" />',
    '<g fill="none">',
    ...strokes,
    "</g>",
    "</svg>",
  ].join("\n");
  return { svg, layers, box };
}

/** 把逐层差异图写到 <outDir>/<层名点换下划线>.svg。 */
/**
 * 逐层并排的 HTML 报告（S237）：每层一列，红=删除、绿=新增，配一张统计表。
 * 图直接内联，报告可以单独发给别人看，不依赖 out/diff 目录还在。
 */
export function renderDiffHtml(
  report: BoardDiff,
  options: { svgs?: ReadonlyMap<string, string>; title?: string } = {},
): string {
  const rows = report.layers
    .map((layer) => {
      const svg = options.svgs?.get(layer.layer) ?? "";
      return (
        "<figure><figcaption>" + escapeHtml(layer.layer) + "<span>+" + String(layer.added) + " / −" + String(layer.removed) +
        " · +" + layer.addedMm.toFixed(1) + " / −" + layer.removedMm.toFixed(1) + " mm</span></figcaption>" +
        '<div class="board">' + svg + "</div></figure>"
      );
    })
    .join("");
  const table = report.layers
    .map(
      (layer) =>
        "<tr><td>" + escapeHtml(layer.layer) + "</td><td>" + String(layer.before) + "</td><td>" + String(layer.after) +
        "</td><td>+" + String(layer.added) + "</td><td>−" + String(layer.removed) + "</td><td>+" + layer.addedMm.toFixed(1) +
        "</td><td>−" + layer.removedMm.toFixed(1) + "</td></tr>",
    )
    .join("");
  const findings = report.findings
    .map((finding) => "<li>" + escapeHtml(finding.message) + (finding.fix === "" ? "" : " → " + escapeHtml(finding.fix)) + "</li>")
    .join("");
  return (
    "<!doctype html><html lang=zh><meta charset=utf-8><title>" + escapeHtml(options.title ?? "改前改后对比") + "</title>" +
    "<style>" +
    "body{margin:0;padding:24px 28px 48px;background:#f7f6f3;color:#16181c;font:13px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif}" +
    "h1{margin:0 0 4px;font-size:28px;font-weight:300;letter-spacing:-.02em}" +
    ".lead{margin:0 0 18px;color:#5c6169;max-width:70ch}" +
    ".legend{display:flex;gap:16px;margin:0 0 20px;font:11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#5c6169}" +
    ".legend i{display:inline-block;width:18px;height:3px;margin-right:6px;vertical-align:2px}" +
    "table{border-collapse:collapse;margin:0 0 22px;font:12px/1.5 ui-monospace,monospace}" +
    "th,td{border-bottom:1px solid #dcdad4;padding:5px 12px 5px 0;text-align:left}" +
    "th{font-weight:600;color:#5c6169}" +
    "figure{margin:0 0 22px;padding:12px;background:#fff;border:1px solid #dcdad4}" +
    "figcaption{display:flex;justify-content:space-between;font:11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#5c6169;margin-bottom:8px}" +
    ".board svg{display:block;width:100%;height:auto;max-height:520px}" +
    "ul{margin:0;padding-left:18px}" +
    "</style>" +
    "<h1>" + escapeHtml(options.title ?? "改前改后对比") + "</h1>" +
    '<p class="lead">' + escapeHtml(basename(report.beforeFile)) + " → " + escapeHtml(basename(report.afterFile)) +
    "：共 " + String(report.stats.added) + " 段新增、" + String(report.stats.removed) + " 段删除，" +
    String(report.stats.addedVias) + " 个过孔新增、" + String(report.stats.removedVias) + " 个删除。" +
    "两图同原点同比例，可直接叠看。</p>" +
    '<div class="legend"><span><i style="background:#c03a2b"></i>删除</span><span><i style="background:#1f7a3f"></i>新增</span></div>' +
    "<table><thead><tr><th>层</th><th>改前</th><th>改后</th><th>+段</th><th>−段</th><th>+mm</th><th>−mm</th></tr></thead><tbody>" +
    table + "</tbody></table>" +
    rows +
    (findings === "" ? "" : "<h2>结论</h2><ul>" + findings + "</ul>") +
    "</html>"
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/u);
  return parts[parts.length - 1] ?? file;
}

export function writeDiffSvgs(beforeFile: string, afterFile: string, outDir: string, mkdir: (dir: string) => void): DiffSvg {
  try {
    const beforeText = readText(beforeFile);
    const afterText = readText(afterFile);
    // 目录已存在是常态（同一工程反复对比），建目录失败不该让整次对比失败。
    try {
      mkdir(outDir);
    } catch {
      // ignore EEXIST
    }
    const result = renderDiffSvg(beforeText, afterText);
    const written: string[] = [];
    for (const layer of result.layers) {
      const one = renderDiffSvg(beforeText, afterText, { layers: [layer] });
      const name = layer.replace(/\./gu, "_") + ".svg";
      writeFileSync(outDir + "/" + name, one.svg.replace(/\n/gu, "\r\n"), "utf8");
      written.push(name);
    }
    const all = renderDiffSvg(beforeText, afterText);
    writeFileSync(outDir + "/all.svg", all.svg.replace(/\n/gu, "\r\n"), "utf8");
    written.push("all.svg");
    return {
      ok: true,
      error: "",
      file: outDir,
      layers: written,
      widthMm: Math.round(all.box.x1 - all.box.x0),
      heightMm: Math.round(all.box.y1 - all.box.y0),
      notes: ["红=删除、绿=新增；每层一张，另有一张 all.svg 把各层叠在一起。", "同原点同比例：两张图按坐标直接对比即可。"],
    };
  } catch (error) {
    return { ...EMPTY_DIFF_SVG, error: "写差异图失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}
