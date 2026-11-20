/**
 * KiCadRoutingTools 运行时（S145）。
 *
 * 我们不再自己写布线器：把 `drandyhaas/KiCadRoutingTools`（MIT）当作外部运行时，
 * 由它做平面、扇出、去耦、差分与布线，我们只负责调用、解析与呈现。
 * 运行时要落在一个固定目录（默认 `~/.dsh-ecad/kicad-routing-tools`），
 * 里面必须有 `py_router/autoroute.py` 与编译好的 `grid_router` 模块。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubprocessService } from "../../../types.js";
import { runCapture } from "../../subprocess-runner.js";
import { ecadHome } from "../../ecad-home.js";
import { envValue } from "../../env-compat.js";

export interface KrtRuntime {
  root: string;
  python: string;
}

export interface KrtLocate {
  runtime: KrtRuntime | null;
  error: string;
}

export interface KrtPlanStep {
  tag: string;
  tool: string;
  what: string;
  why: string;
  optional: boolean;
}

export interface KrtAutorouteReport {
  ok: boolean;
  error: string;
  output: string;
  dryRun: boolean;
  seconds: number;
  steps: KrtPlanStep[];
  openNets: number | null;
  drc: number | null;
  warnings: string[];
  log: string;
}

const AUTHOROUTE_REL = join("py_router", "autoroute.py");

/**
 * tscircuit 导出的 `.kicad_pcb` 把层名写成不带引号的形式（`(layer F.Cu)`），
 * KiCad 自己认，但 KiCadRoutingTools 的解析器只认带引号的写法，读不到就把
 * 800 多条既有走线当成「不存在」——布线器会从这些铜箔中间穿过去，结果全是短接。
 * 喂给引擎之前统一成带引号的写法（S145）。只处理单行、明确是层名的位置，
 * 不碰 `(layers ...)` 这种跨行表，否则会把文件写坏。
 */
/** 运行时根目录：显式变量优先，否则落在插件自己的 home 下。 */
export function krtRoot(env: Record<string, string | undefined> = process.env): string {
  const explicit = (envValue(env, "KRT_ROOT") ?? "").trim().replace(/\\/gu, "/");
  if (explicit !== "") return explicit;
  return ecadHome(env).replace(/\\/gu, "/") + "/kicad-routing-tools";
}

/** 运行时是否可用：脚本在即可用；Rust 模块可能装在 python 的 site-packages 里。 */
export function krtStatus(root: string): { ok: boolean; error: string; hasModule: boolean } {
  if (!existsSync(join(root, AUTHOROUTE_REL))) {
    return { ok: false, error: "KiCadRoutingTools 还没安装：把仓库放到 " + root, hasModule: false };
  }
  const hasModule = existsSync(join(root, "grid_router.pyd")) || existsSync(join(root, "grid_router.so"));
  return { ok: true, error: "", hasModule };
}

/** 读取 VERSION，用于在报告里标注引擎版本。 */
export function krtVersion(root: string): string {
  const file = join(root, "VERSION");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function quoteLayerNames(text: string): { text: string; quoted: number } {
  let quoted = 0;
  let out = text.replace(/\(layer ([A-Za-z0-9]+\.[A-Za-z0-9]+)\)/gu, (_whole, name: string) => {
    quoted += 1;
    return '(layer "' + name + '")';
  });
  out = out.replace(/\(layers ([^)\n]*)\)/gu, (whole, body: string) => {
    const names = body.split(/\s+/u).filter((item) => item !== "");
    if (names.length < 2 || names.some((item) => item.includes("("))) return whole;
    if (names.every((item) => item.startsWith('"'))) return whole;
    quoted += 1;
    return "(layers " + names.map((item) => (item.startsWith('"') ? item : '"' + item + '"')).join(" ") + ")";
  });
  return { text: out, quoted };
}

/**
 * 给焊盘上的字符串网络补 KiCad 的网络表。
 *
 * tscircuit 导出的板子只有 `(net "GND")` 这种内联写法，没有顶层的 `(net <id> "GND")` 声明；
 * KiCadRoutingTools 按「网络表 + 焊盘网络号」建网，读不到声明就当没有网络，于是整块板
 * 「0 个网络要布」，跑完 20 秒什么都不改（S208）。
 */
export function assignNetIds(text: string): { text: string; nets: number } {
  const names = new Map<string, number>();
  let next = 1;
  // 已有数字编号的（KiCad 自己保存过的板子）先登记，避免重复发号。
  for (const match of text.matchAll(/\(net (\d+)(?: "([^"]*)")?\)/gu)) {
    const id = Number(match[1]);
    if (id >= next) next = id + 1;
    if (match[2] !== undefined && match[2] !== "") names.set(match[2], id);
  }
  for (const match of text.matchAll(/\(net "([^"]*)"\)/gu)) {
    const name = match[1] ?? "";
    if (name === "" || names.has(name)) continue;
    names.set(name, next);
    next += 1;
  }
  if (names.size === 0) return { text, nets: 0 };
  // 网络引用分两种写法，KiCad 10 认得很死：焊盘（pad）里必须带名字
  // `(net <id> "NAME")`，走线/过孔只接受编号 `(net <id>)`。写成另一种都会让
  // KiCad 报「应为 net name / 应为 ')'」而打不开板子（S208 两版都栽在这）。
  let rewritten = "";
  let depth = 0;
  let padDepth = -1;
  let at = 0;
  const inline = /\(net "([^"]*)"\)|\(|\)/gu;
  for (let match = inline.exec(text); match !== null; match = inline.exec(text)) {
    rewritten += text.slice(at, match.index);
    at = match.index + match[0].length;
    const netName = match[1];
    if (netName !== undefined) {
      const id = names.get(netName);
      const inPad = padDepth >= 0 && depth >= padDepth;
      rewritten += id === undefined
        ? '(net "' + netName + '")'
        : inPad ? "(net " + String(id) + ' "' + netName + '")' : "(net " + String(id) + ")";
      continue;
    }
    if (match[0] === "(") {
      depth += 1;
      if (/^\(pad\b/u.test(text.slice(match.index, match.index + 5))) padDepth = depth;
      rewritten += "(";
      continue;
    }
    // 收括号：退到 pad 块之外就不再算「在焊盘里」。
    if (padDepth >= 0 && depth < padDepth) padDepth = -1;
    depth -= 1;
    rewritten += ")";
  }
  rewritten += text.slice(at);
  // 只有焊盘里出现过、顶层没有声明的网络才补声明。
  // 顶层声明只认**一级缩进**那些行：焊盘里的网络缩进更深，不能当成已声明。
  const declared = new Set([...rewritten.matchAll(/^\t\(net \d+(?: "([^"]*)")?\)\s*$/gmu)].map((match) => match[1] ?? ""));
  const missing = [...names].filter(([name]) => name !== "" && !declared.has(name));
  if (missing.length === 0) return { text: rewritten, nets: names.size };
  const block = missing.map(([name, id]) => '\t(net ' + String(id) + ' "' + name + '")').join("\n");
  // 网络表要放在顶层子节点里：优先紧跟 (layers …) 之后，没有就插在 (kicad_pcb 之后。
  const layersAt = rewritten.indexOf("(layers");
  let insertAt = -1;
  if (layersAt >= 0) {
    let depth = 0;
    for (let i = layersAt; i < rewritten.length; i += 1) {
      const ch = rewritten[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          // 插到这一行之后（跳过 \r\n），否则会粘在 `(layers …)` 的右括号后面。
          let at = i + 1;
          while (at < rewritten.length && (rewritten[at] === "\r" || rewritten[at] === "\n")) at += 1;
          insertAt = at;
          break;
        }
      }
    }
  }
  if (insertAt < 0) {
    const head = rewritten.indexOf("(kicad_pcb");
    insertAt = head < 0 ? 0 : head + "(kicad_pcb".length + 1;
  }
  rewritten = rewritten.slice(0, insertAt) + block + "\n" + rewritten.slice(insertAt);
  return { text: rewritten, nets: names.size };
}

interface RawStep {
  tag?: string;
  tool?: string;
  what?: string;
  why?: string;
  optional?: boolean;
  state?: string;
  result?: string;
  seconds?: number;
}

function parseJsonLine(line: string, prefix: string): unknown {
  if (!line.startsWith(prefix)) return null;
  const body = line.slice(prefix.length).trim();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** 解析 autoroute.py 的 stdout：计划、步骤、摘要与告警。 */
export function parseAutorouteLog(text: string): {
  steps: KrtPlanStep[];
  openNets: number | null;
  drc: number | null;
  warnings: string[];
  error: string;
} {
  const steps: KrtPlanStep[] = [];
  const warnings: string[] = [];
  let openNets: number | null = null;
  let drc: number | null = null;
  let error = "";

  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("WARNING:")) {
      warnings.push(line.slice("WARNING:".length).trim());
      continue;
    }
    const plan = parseJsonLine(line, "AUTOROUTE_PLAN:") as { steps?: RawStep[] } | null;
    if (plan !== null && Array.isArray(plan.steps)) {
      for (const step of plan.steps) {
        steps.push({
          tag: step.tag ?? "",
          tool: step.tool ?? "",
          what: step.what ?? "",
          why: step.why ?? "",
          optional: step.optional === true,
        });
      }
      continue;
    }
    const summary = parseJsonLine(line, "AUTOROUTE_SUMMARY:") as {
      open_nets?: number | null;
      open?: number | null;
      drc_items?: number | null;
      error?: string | null;
    } | null;
    if (summary !== null) {
      // 不同版本里这个字段叫 open_nets 或 open，两个都认。
      if (typeof summary.open_nets === "number") openNets = summary.open_nets;
      else if (typeof summary.open === "number") openNets = summary.open;
      if (typeof summary.drc_items === "number") drc = summary.drc_items;
      if (typeof summary.error === "string" && summary.error !== "") error = summary.error;
      continue;
    }
  }
  return { steps, openNets, drc, warnings, error };
}

export interface KrtAutorouteRequest {
  subprocess: SubprocessService;
  runtime: KrtRuntime;
  inputPcb: string;
  outputPcb: string;
  dryRun: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 跑一次 autoroute。`dryRun` 只出计划不落盘；非 dryRun 时输出到 `outputPcb`。
 * 注意：引擎的子进程会从临时工作目录启动，Rust 模块装在 python 的 site-packages 里才稳，
 * 所以这里额外把运行时根目录塞进 PYTHONPATH 作为兜底。
 */
export async function runKrtAutoroute(request: KrtAutorouteRequest): Promise<KrtAutorouteReport> {
  const args = [join(request.runtime.root, AUTHOROUTE_REL), request.inputPcb, request.outputPcb];
  if (request.dryRun) args.push("--dry-run");
  const started = Date.now();
  const result = await runCapture(request.subprocess, {
    argv: [request.runtime.python, ...args],
    cwd: request.runtime.root,
    env: { PYTHONPATH: [request.runtime.root, process.env["PYTHONPATH"] ?? ""].filter((item) => item !== "").join(";") },
    timeoutMs: request.timeoutMs ?? 1_800_000,
    maxBytes: 8 * 1024 * 1024,
    signal: request.signal,
  });
  const parsed = parseAutorouteLog(result.stdout);
  const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
  const outputReady = request.dryRun || existsSync(request.outputPcb);
  const exitOk = result.exitCode === 0 && result.spawnError === null;
  const failure = parsed.error !== ""
    ? parsed.error
    : result.timedOut
      ? "路由超时（" + String(Math.round(seconds)) + " 秒）"
      : exitOk && outputReady
        ? ""
        : "路由没有产出板子：" + (result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-1)[0] ?? "未知原因");
  return {
    ok: failure === "",
    error: failure,
    output: request.dryRun ? "" : request.outputPcb,
    dryRun: request.dryRun,
    seconds,
    steps: parsed.steps,
    openNets: parsed.openNets,
    drc: parsed.drc,
    warnings: parsed.warnings,
    log: result.stdout.slice(-4000),
  };
}

/** 连通性检查：`check_connected.py` 的文本输出里 "unconnected" 那几行最有用。 */
export async function runKrtConnectedCheck(request: {
  subprocess: SubprocessService;
  runtime: KrtRuntime;
  pcbFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; error: string; unconnected: number | null; text: string }> {
  const result = await runCapture(request.subprocess, {
    argv: [request.runtime.python, join(request.runtime.root, "py_router", "check_connected.py"), request.pcbFile],
    cwd: request.runtime.root,
    env: { PYTHONPATH: request.runtime.root },
    timeoutMs: request.timeoutMs ?? 300_000,
    maxBytes: 2 * 1024 * 1024,
    signal: request.signal,
  });
  const match = /(\d+)\s+(?:open|unconnected)\b/iu.exec(result.stdout);
  const unconnected = match === null ? null : Number.parseInt(match[1] ?? "0", 10);
  const exitOk = result.exitCode === 0 && result.spawnError === null;
  return {
    ok: exitOk,
    error: exitOk ? "" : "连通性检查失败：" + result.stderr.slice(-200),
    unconnected,
    text: result.stdout.slice(-2000),
  };
}
