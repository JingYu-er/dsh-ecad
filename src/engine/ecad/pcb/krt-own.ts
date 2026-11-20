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

export interface OwnRuleOptions {
  /** 信号线宽（mm）。 */
  trackWidthMm: number;
  /** 间距（mm）。 */
  clearanceMm: number;
  /** 电源网名（逗号分隔传入 route.py）。 */
  powerNets: readonly string[];
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
  if (options.powerNets.length > 0) {
    args.push("--power-nets", ...options.powerNets);
    if (options.powerWidthMm !== undefined) {
      // 宽度按电源网逐个给，长度必须与 --power-nets 一致
      args.push("--power-nets-widths", ...options.powerNets.map(() => options.powerWidthMm?.toFixed(3) ?? ""));
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
