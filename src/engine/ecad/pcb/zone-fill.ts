/**
 * 导出制造文件前的铺铜填充（S188）。
 *
 * 关键事实（实测，KiCad 10.0.7）：`kicad-cli pcb drc --refill-zones` 只在内存里
 * 重铺一次给 DRC 用，**不会把 filled_polygon 写回板子**——直接拿这块板导 Gerber，
 * 覆铜是空心的。要真正落盘只能走 pcbnew 的 ZONE_FILLER + SaveBoard。
 *
 * 所以这里不调用 DRC，而是自己跑一小段 pcbnew 脚本：有铺铜区才填，填完存盘。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SubprocessService } from "../../../types.js";
import { runCapture } from "../../subprocess-runner.js";
import { ecadEnv, type EcadToolchain } from "../toolchain.js";

export const ZONE_FILL_SCRIPT = [
  "import json, sys, pcbnew",
  "payload = json.load(open(sys.argv[1], encoding='utf-8'))",
  "board = pcbnew.LoadBoard(payload['boardFile'])",
  "zones = list(board.Zones())",
  "filled = False",
  "error = ''",
  "if zones:",
  "    try:",
  "        filler = pcbnew.ZONE_FILLER(board)",
  "        filler.Fill(board.Zones())",
  "        pcbnew.SaveBoard(payload['boardFile'], board)",
  "        filled = True",
  "    except Exception as exc:",
  "        error = str(exc)",
  "result = {'zones': len(zones), 'filled': filled, 'error': error}",
  "with open(sys.argv[2], 'w', encoding='utf-8') as handle:",
  "    json.dump(result, handle)",
].join("\n");

export interface ZoneFillResult {
  readonly ok: boolean;
  readonly error: string;
  /** 板子上的铺铜区数量。0 表示这块板根本没铺铜，Gerber 里也就不会有覆铜。 */
  readonly zones: number;
  readonly filled: boolean;
  readonly notes: readonly string[];
}

const EMPTY: ZoneFillResult = { ok: false, error: "", zones: 0, filled: false, notes: [] };

/** 从脚本输出里取结果；拿不到 JSON 就按失败处理，不把「没报错」当成功。 */
export function parseZoneFillOutput(text: string): { ok: boolean; zones: number; filled: boolean; error: string } {
  const line = text
    .split(/\r?\n/u)
    .reverse()
    .find((row) => row.trim().startsWith("{") && row.includes("\"zones\""));
  if (line === undefined) return { ok: false, zones: 0, filled: false, error: "" };
  try {
    const parsed = JSON.parse(line) as { zones?: number; filled?: boolean; error?: string };
    return {
      ok: true,
      zones: typeof parsed.zones === "number" ? parsed.zones : 0,
      filled: parsed.filled === true,
      error: typeof parsed.error === "string" ? parsed.error : "",
    };
  } catch {
    return { ok: false, zones: 0, filled: false, error: "" };
  }
}

/**
 * 重铺板上所有铺铜并写回文件。
 *
 * 不使用 `kicad-cli pcb drc --refill-zones`：它不落盘（见文件头注释）。
 */
export async function fillZones(
  subprocess: SubprocessService,
  toolchain: EcadToolchain,
  pcbFile: string,
  signal?: AbortSignal,
): Promise<ZoneFillResult> {
  if (toolchain.python === "") {
    return { ...EMPTY, ok: false, error: "没有 KiCad 自带的 python：铺铜填充要用 pcbnew", notes: ["跳过铺铜填充：没有找到 KiCad 自带的 python，Gerber 里的覆铜可能是空心的"] };
  }
  const dir = join(tmpdir(), "dsh-ecad-zonefill");
  mkdirSync(dir, { recursive: true });
  const scriptFile = join(dir, "zone_fill.py");
  const payloadFile = join(dir, "zone_fill.json");
  const resultFile = join(dir, "zone_fill.result.json");
  writeFileSync(scriptFile, ZONE_FILL_SCRIPT, "utf8");
  writeFileSync(payloadFile, JSON.stringify({ boardFile: pcbFile }), "utf8");

  const outcome = await runCapture(subprocess, {
    argv: [toolchain.python, scriptFile, payloadFile, resultFile],
    cwd: dirname(pcbFile),
    env: ecadEnv(toolchain),
    timeoutMs: 180_000,
    maxBytes: 64 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (outcome.exitCode !== 0) {
    const detail = (outcome.stdout + "\n" + outcome.stderr).trim().split(/\r?\n/u).slice(-4).join("\n");
    return { ...EMPTY, ok: false, error: "铺铜填充失败：" + (detail || "pcbnew 退出码非 0"), notes: ["铺铜没填充：Gerber 里的覆铜可能是空心的"] };
  }

  let text = "";
  try {
    text = readFileSync(resultFile, "utf8");
  } catch {
    text = "";
  }
  const parsed = parseZoneFillOutput(text);
  if (!parsed.ok) {
    return { ...EMPTY, ok: false, error: "铺铜填充没返回结果：pcbnew 可能没跑起来", notes: ["铺铜没填充：Gerber 里的覆铜可能是空心的"] };
  }
  if (parsed.error !== "") {
    return { ok: false, error: "铺铜填充失败：" + parsed.error, zones: parsed.zones, filled: false, notes: ["铺铜没填充：Gerber 里的覆铜可能是空心的"] };
  }
  const notes: string[] = [];
  if (parsed.zones === 0) {
    notes.push("板上没有铺铜区：Gerber 里不会有覆铜（要整板 GND 就先铺铜再导出）");
  } else if (parsed.filled) {
    notes.push("已重铺 " + String(parsed.zones) + " 个铺铜区并写回板子");
  }
  return { ok: true, error: "", zones: parsed.zones, filled: parsed.filled, notes };
}
