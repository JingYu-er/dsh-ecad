/**
 * 用「我们自己的规则」调 KiCadRoutingTools 的 route.py（S195）。
 *
 * autoroute.py 的路线是「按工艺下限布一遍」，net class 只当上限提示；
 * 想把线画整齐，必须显式给 route.py 传宽度、间距、电源网与排序策略，
 * 并打开它自带的 45° smoothing。这里只负责拼参数、跑、把汇总拿回来。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubprocessService } from "../../../types.js";
import { runCapture } from "../../subprocess-runner.js";
import type { KrtRuntime } from "./krt.js";

const ROUTE_REL = join("py_router", "route.py");
const PLANES_REL = join("py_router", "route_planes.py");

export interface OwnRuleOptions {
  /** 信号线宽（mm）。 */
  trackWidthMm: number;
  /** 间距（mm）。 */
  clearanceMm: number;
  /** 电源网名（逗号分隔传入 route.py）；不给就当作没有需要加宽的电源网。 */
  powerNets?: readonly string[];
  /** 电源线宽（mm），缺省同 trackWidthMm。 */
  powerWidthMm?: number;
  /** 只在哪些铜层布；默认 F.Cu,B.Cu。 */
  layers?: readonly string[];
  /** 排序策略：mps（最大平面子集，默认）/ inside_out / original。 */
  ordering?: "mps" | "inside_out" | "original";
  /** 过孔外径 / 钻孔（mm）。 */
  viaSizeMm?: number;
  viaDrillMm?: number;
  /** 最多拆几次已布的线（0 = 不拆）。 */
  maxRipup?: number;
  /** 网格步长（mm）。 */
  gridStepMm?: number;
  /** 只布这些网络；缺省交给引擎按 scope 决定。 */
  nets?: readonly string[];
  /** 45° 平滑，默认开。 */
  smoothing?: boolean;
  /** 走线相对板边留空（mm）。 */
  boardEdgeClearanceMm?: number;
  /** 焊盘出口收窄段长度（mm），默认 0.8；引擎默认 2.5 会让细段占比过高。 */
  neckdownMm?: number;
}

export interface OwnRuleRequest {
  subprocess: SubprocessService;
  runtime: KrtRuntime;
  inputPcb: string;
  outputPcb: string;
  options: OwnRuleOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
}


/** 按括号配平从 `(layers` 处取整块（KiCad 的层表是跨行的，不能按 `[^)]*` 截）。 */
function layersBlock(pcbText: string): string {
  const start = pcbText.indexOf("(layers");
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < pcbText.length; i += 1) {
    const ch = pcbText[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return pcbText.slice(start, i + 1);
    }
  }
  return "";
}

/** 板上铜层数：从层表里数 F/B/In*.Cu（去重），读不到按 2 层。 */
export function copperLayersOf(pcbText: string): number {
  const block = layersBlock(pcbText);
  if (block === "") return 2;
  const names = new Set<string>();
  for (const match of block.matchAll(/"(F|B|In\d+)\.Cu"/gu)) names.add(match[0]);
  return names.size === 0 ? 2 : names.size;
}

export interface OwnRuleReport {
  ok: boolean;
  error: string;
  output: string;
  seconds: number;
  /** route.py 写出的汇总（--json-out），字段随引擎版本变化，原样回传。 */
  summary: Record<string, unknown>;
  /** 产出板子的走线宽度分布（mm → 段数）与「细段」统计。 */
  widths: Record<string, number>;
  /** 窄于请求宽度的段数占比（焊盘出口的 tap 会被引擎压到工艺下限）。 */
  thinRatio: number;
  segments: number;
  log: string;
}

/**
 * 内层分配：In1 给地，In2 给「焊盘最多」的那个电源网（S199）。
 *
 * 一块板通常有 3V3 和 5V 两个电源，内层只有两片可用；把焊盘最多的那个
 * 铺成平面收益最大，其余电源网继续走外层铜皮。
 */
export function planeAssignment(pcbText: string, copperLayers: number): { nets: string[]; layers: string[] } {
  // 焊盘块是跨行的（(pad "" smd rect \n (size …) \n (net "GND") …），
  // 按「下一个 (pad 之前」切片取网络名，比按括号配平简单且不会漏。
  const padCounts = new Map<string, number>();
  const starts: number[] = [];
  for (let index = pcbText.indexOf("(pad "); index >= 0; index = pcbText.indexOf("(pad ", index + 5)) {
    starts.push(index);
  }
  for (let cursor = 0; cursor < starts.length; cursor += 1) {
    const end = cursor + 1 < starts.length ? starts[cursor + 1]! : pcbText.length;
    const net = /\(net\s+"([^"]+)"\)/u.exec(pcbText.slice(starts[cursor]!, end));
    if (net === null) continue;
    const name = net[1] ?? "";
    if (name === "") continue;
    padCounts.set(name, (padCounts.get(name) ?? 0) + 1);
  }
  const nets: string[] = [];
  const layers: string[] = [];
  const ground = [...padCounts.keys()].find((name) => /^(?:GND|VSS|AGND|PGND|DGND)$/iu.test(name));
  if (ground !== undefined) {
    nets.push(ground);
    layers.push("In1.Cu");
  }
  if (copperLayers >= 4) {
    const power = [...padCounts.entries()]
      .filter(([name]) => /^\+?(?:3V3|V3V3|VCC|VDD|5V|VBUS|VBAT|VIN)$/iu.test(name))
      .sort((a, b) => b[1] - a[1])[0];
    if (power !== undefined) {
      nets.push(power[0]);
      layers.push("In2.Cu");
    }
  }
  return { nets, layers };
}

/** 平面铺铜（4/6 层）：GND 走内层整片，电源按需要再一层。参数用同一个 preset。 */
export interface PlaneRequest {
  readonly subprocess: SubprocessService;
  readonly runtime: KrtRuntime;
  readonly inputPcb: string;
  readonly outputPcb: string;
  readonly options: OwnRuleOptions;
  readonly planeNets: readonly string[];
  readonly planeLayers: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PlaneReport {
  ok: boolean;
  error: string;
  output: string;
  seconds: number;
  zones: Array<{ layer: string; net: string }>;
  padCoverage: string;
  log: string;
}

/** 拼 route_planes.py 参数。 */
export function ownPlaneArgv(runtimeRoot: string, request: Omit<PlaneRequest, "subprocess" | "runtime" | "timeoutMs" | "signal">): string[] {
  const options = request.options;
  return [
    join(runtimeRoot, PLANES_REL), request.inputPcb, "--output", request.outputPcb, "--overwrite",
    "--nets", ...request.planeNets,
    "--plane-layers", ...request.planeLayers,
    "--track-width", (options.powerWidthMm ?? options.trackWidthMm).toFixed(3),
    "--clearance", options.clearanceMm.toFixed(3),
    "--via-size", (options.viaSizeMm ?? 0.45).toFixed(3),
    "--via-drill", (options.viaDrillMm ?? 0.25).toFixed(3),
    "--zone-clearance", options.clearanceMm.toFixed(3),
  ];
}

/** 跑平面铺铜，取回 zones 与几何核对结果。 */
export async function runOwnRulePlanes(request: PlaneRequest): Promise<PlaneReport> {
  const argv = ownPlaneArgv(request.runtime.root, request);
  const started = Date.now();
  const result = await runCapture(request.subprocess, {
    argv: [request.runtime.python, ...argv],
    cwd: request.runtime.root,
    env: { PYTHONPATH: [request.runtime.root, process.env["PYTHONPATH"] ?? ""].filter((item) => item !== "").join(";") },
    timeoutMs: request.timeoutMs ?? 900_000,
    maxBytes: 4 * 1024 * 1024,
    signal: request.signal,
  });
  const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
  const produced = existsSync(request.outputPcb);
  const summaryLine = result.stdout.split(/\r?\n/u).reverse().find((line) => line.startsWith("JSON_SUMMARY:"));
  let zones: Array<{ layer: string; net: string }> = [];
  let padCoverage = "";
  if (summaryLine !== undefined) {
    try {
      const parsed = JSON.parse(summaryLine.slice("JSON_SUMMARY:".length)) as { plane_zones?: unknown; pads?: unknown; pads_scope?: string };
      if (Array.isArray(parsed.plane_zones)) {
        zones = parsed.plane_zones.map((item) => {
          const zone = item as { layer?: unknown; net?: unknown };
          return { layer: String(zone.layer ?? ""), net: String(zone.net ?? "") };
        });
      }
      const pads = parsed.pads as { geometric_failed?: unknown } | undefined;
      if (pads !== undefined && typeof pads.geometric_failed === "number") padCoverage = parsed.pads_scope ?? "";
    } catch {
      zones = [];
    }
  }
  const tail = result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-1)[0] ?? "";
  const error = result.timedOut
    ? "平面铺铜超时（" + String(Math.round(seconds)) + " 秒）"
    : result.exitCode === 0 && produced
      ? ""
      : "平面铺铜没有产出板子：" + (tail === "" ? "引擎没有给出原因" : tail);
  return { ok: error === "", error, output: produced ? request.outputPcb : "", seconds, zones, padCoverage, log: result.stdout.slice(-2000) };
}

/** 从汇总里取这一轮没布通的网络名（不重复、保持原顺序）。 */
export function failedNetsOf(summary: Record<string, unknown>): string[] {
  const raw = [summary["failed_single"], summary["open_single"], summary["failed"]];
  const names: string[] = [];
  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    for (const name of item) {
      const text = String(name);
      if (text !== "" && !names.includes(text)) names.push(text);
    }
  }
  return names;
}

/**
 * 两轮布线：第一轮按我们的规则布全部网络；没布通的，带着更大的 rip-up
 * 预算在已布好的板子上补第二轮（而不是从头再来，那样会把第一轮的好线拆掉）。
 */
export async function runOwnRuleRouteWithRetry(
  request: Parameters<typeof runOwnRuleRoute>[0],
  options: { readonly retryRipup?: number; readonly retryMaxNets?: number } = {},
): Promise<OwnRuleReport & { readonly retried: readonly string[] }> {
  const first = await runOwnRuleRoute(request);
  const failed = first.ok ? failedNetsOf(first.summary) : [];
  const limit = options.retryMaxNets ?? 12;
  const retried = failed.slice(0, limit);
  if (!first.ok || retried.length === 0) return { ...first, retried: [] };
  const second = await runOwnRuleRoute({
    ...request,
    inputPcb: first.output === "" ? request.inputPcb : first.output,
    outputPcb: request.outputPcb,
    options: {
      ...request.options,
      nets: retried,
      maxRipup: options.retryRipup ?? Math.max(6, (request.options.maxRipup ?? 2) * 3),
    },
  });
  if (!second.ok) return { ...first, retried: [] };
  return {
    ...second,
    seconds: Math.round((first.seconds + second.seconds) * 10) / 10,
    log: first.log + "\n--- 第二轮补布 ---\n" + second.log,
    summary: { ...second.summary, retried_nets: retried, first_pass_failed: failed },
    retried,
  };
}

/** 统计产出板子里各宽度（mm，4 位）的走线段数。 */
export function widthHistogram(pcbText: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const hit of pcbText.matchAll(/\(segment\s/gu)) {
    const start = hit.index ?? 0;
    // 段块里第一个 ")" 只是 start 点的括号，宽度在后面，取 400 字符窗口再匹配
    const window = pcbText.slice(start, start + 400);
    const width = /\(width\s+([\d.]+)\)/u.exec(window);
    if (width !== null) {
      const key = Number(width[1]).toFixed(4);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** 拼 route.py 参数。单独导出是为了能单测（不跑子进程也能断言参数）。 */
export function ownRuleArgv(runtimeRoot: string, request: Omit<OwnRuleRequest, "subprocess" | "runtime" | "timeoutMs" | "signal">): string[] {
  const options = request.options;
  const args = [join(runtimeRoot, ROUTE_REL), request.inputPcb, "--output", request.outputPcb];
  args.push("--track-width", options.trackWidthMm.toFixed(3));
  args.push("--clearance", options.clearanceMm.toFixed(3));
  // 每个 net class 都按我们的间距上限走，别让某些 class 偷偷放宽
  args.push("--clearance-ceiling", options.clearanceMm.toFixed(3));
  // 这些参数在 route.py 里都是 nargs="+"：一个空格分隔的列表，不能拼成逗号串
  args.push("--layers", ...(options.layers ?? ["F.Cu", "B.Cu"]));
  // 焊盘出口的收窄段（neckdown）默认 2.5 mm，会把大半条走线压成 0.127；
  // 我们自己的规则里默认收到 0.8 mm，只留刚够出焊盘的一小段。
  args.push("--neckdown-length", (options.neckdownMm ?? 0.8).toFixed(2));
  args.push("--ordering", options.ordering ?? "mps");
  const powerNets = options.powerNets ?? [];
  if (powerNets.length > 0) {
    args.push("--power-nets", ...powerNets);
    if (options.powerWidthMm !== undefined) {
      // 宽度按电源网逐个给，长度必须与 --power-nets 一致
      args.push("--power-nets-widths", ...powerNets.map(() => options.powerWidthMm?.toFixed(3) ?? ""));
    }
  }
  if (options.viaSizeMm !== undefined) args.push("--via-size", options.viaSizeMm.toFixed(3));
  if (options.viaDrillMm !== undefined) args.push("--via-drill", options.viaDrillMm.toFixed(3));
  if (options.maxRipup !== undefined) args.push("--max-ripup", String(options.maxRipup));
  if (options.gridStepMm !== undefined) args.push("--grid-step", options.gridStepMm.toFixed(3));
  if (options.boardEdgeClearanceMm !== undefined) args.push("--board-edge-clearance", options.boardEdgeClearanceMm.toFixed(3));
  if (options.nets !== undefined && options.nets.length > 0) args.push("--nets", ...options.nets);
  if (options.smoothing !== false) args.push("--smoothing");
  return args;
}

/** 跑一次自有规则布线。失败时把 stderr 末行拼进 error，便于面板直接显示。 */
export async function runOwnRuleRoute(request: OwnRuleRequest): Promise<OwnRuleReport> {
  const summaryFile = request.outputPcb + ".summary.json";
  const argv = ownRuleArgv(request.runtime.root, {
    inputPcb: request.inputPcb,
    outputPcb: request.outputPcb,
    options: request.options,
  });
  argv.push("--json-out", summaryFile);
  const started = Date.now();
  const result = await runCapture(request.subprocess, {
    argv: [request.runtime.python, ...argv],
    cwd: request.runtime.root,
    env: { PYTHONPATH: [request.runtime.root, process.env["PYTHONPATH"] ?? ""].filter((item) => item !== "").join(";") },
    timeoutMs: request.timeoutMs ?? 1_800_000,
    maxBytes: 8 * 1024 * 1024,
    signal: request.signal,
  });
  const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
  let summary: Record<string, unknown> = {};
  if (existsSync(summaryFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(summaryFile, "utf8"));
      if (parsed !== null && typeof parsed === "object") summary = parsed as Record<string, unknown>;
    } catch {
      summary = {};
    }
  }
  const exitOk = result.exitCode === 0 && result.spawnError === null;
  const produced = existsSync(request.outputPcb);
  const tail = result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-1)[0] ?? "";
  const error = result.timedOut
    ? "布线超时（" + String(Math.round(seconds)) + " 秒）"
    : exitOk && produced
      ? ""
      : "布线没有产出板子：" + (tail === "" ? "引擎没有给出原因" : tail);
  const widths = produced ? widthHistogram(readFileSync(request.outputPcb, "utf8")) : {};
  const segments = Object.values(widths).reduce((sum, count) => sum + count, 0);
  const requested = request.options.trackWidthMm;
  const thin = Object.entries(widths)
    .filter(([width]) => Number(width) < requested - 1e-6)
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    ok: error === "",
    error,
    output: produced ? request.outputPcb : "",
    seconds,
    summary,
    widths,
    thinRatio: segments === 0 ? 0 : thin / segments,
    segments,
    log: result.stdout.slice(-4000),
  };
}
