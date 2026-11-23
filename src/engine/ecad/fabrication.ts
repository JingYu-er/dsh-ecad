/**
 * ECAD 制造文件导出（S100）：Gerber、钻孔、贴片坐标与 STEP 一次落盘。
 *
 * 全部交给 kicad-cli：它是 KiCad 自己的一块，输出与 KiCad 里点「制造输出」一致，
 * 不需要在本插件里重写一遍写文件的格式。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SubprocessService } from "../../types.js";
import { runCapture } from "../subprocess-runner.js";
import { ecadEnv, type EcadToolchain } from "./toolchain.js";
import { exportStep } from "./checks.js";
import { readBoardBox } from "./dfm.js";
import { fillZones } from "./pcb/zone-fill.js";
import { normalizePosCsv } from "./pcb/pos.js";
import { createZip, type ZipEntry } from "./zip.js";
import { readBom, renderBomCsv } from "./bom.js";

export interface FabricationFile {
  readonly name: string;
  readonly bytes: number;
}

export interface FabricationExport {
  readonly ok: boolean;
  readonly error: string;
  readonly outDir: string;
  readonly gerberDir: string;
  readonly gerbers: readonly FabricationFile[];
  readonly stepFile: string;
  readonly stepBytes: number;
  readonly posFile: string;
  /** 平移到板左下角、Y 向上的贴片坐标（SMT 厂要的 CPL）。拿不到就为空串。 */
  readonly cplFile: string;
  readonly cplCount: number;
  readonly drillFiles: readonly FabricationFile[];
  /** 一次下厂用的整包（Gerber + 钻孔 + CPL + BOM + 清单）。未要 bundle 时为空串。 */
  readonly bundleFile: string;
  readonly bundleBytes: number;
  readonly bundleFiles: number;
  readonly notes: readonly string[];
  /** 明确跳过的 DRC 检查（写进 ignored.txt）。 */
  readonly ignoredChecks?: readonly string[];
  /** 明确决定不修的可制造性告警（写进 ignored.txt）。 */
  readonly dfmIgnored?: readonly string[];
}

function listFiles(dir: string): FabricationFile[] {
  const files: FabricationFile[] = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir).sort()) {
    try {
      const info = statSync(join(dir, name));
      if (info.isFile()) files.push({ name, bytes: info.size });
    } catch {
      // 单个文件读不到不影响整批导出，跳过即可。
    }
  }
  return files;
}

function tail(text: string, limit = 800): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
}

async function runExport(
  subprocess: SubprocessService,
  toolchain: EcadToolchain,
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error: string }> {
  const outcome = await runCapture(subprocess, {
    argv: [...argv],
    cwd,
    env: ecadEnv(toolchain),
    timeoutMs: 300_000,
    maxBytes: 256 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (outcome.exitCode === 0) return { ok: true, error: "" };
  return { ok: false, error: tail(outcome.stdout + "\n" + outcome.stderr) || "kicad-cli 执行失败" };
}

/**
 * 导出制造文件。
 *
 * 落点：`<outDir>/gerbers/`（Gerber 与钻孔）、`<outDir>/<board>.step`、
 * `<outDir>/<board>-pos.csv`。中途某一步失败不删已产出的文件，错误里说明是哪一步。
 */
export async function exportFabrication(
  subprocess: SubprocessService,
  toolchain: EcadToolchain,
  pcbFile: string,
  outDir: string,
  signal?: AbortSignal,
  options?: { readonly bundle?: boolean },
): Promise<FabricationExport> {
  const empty: FabricationExport = {
    ok: false,
    error: "",
    outDir,
    gerberDir: "",
    gerbers: [],
    stepFile: "",
    stepBytes: 0,
    posFile: "",
    cplFile: "",
    cplCount: 0,
    drillFiles: [],
    bundleFile: "",
    bundleBytes: 0,
    bundleFiles: 0,
    notes: [],
  };
  if (toolchain.kicadCli === "") return { ...empty, error: "没有 kicad-cli：装一个 KiCad 10" };
  if (!existsSync(pcbFile)) return { ...empty, error: "还没有 .kicad_pcb：先跑一次 stm32_ecad_build" };

  const board = (pcbFile.split(/[\\/]/u).pop() ?? "board").replace(/\.kicad_pcb$/u, "");
  const gerberDir = join(outDir, "gerbers");
  mkdirSync(gerberDir, { recursive: true });
  const notes: string[] = [];
  const cwd = dirname(pcbFile);

  // 先真重铺一次：kicad-cli 的 dry DRC refill 不落盘，不填就导出的 Gerber 覆铜是空心的。
  const zones = await fillZones(subprocess, toolchain, pcbFile, signal);
  for (const note of zones.notes) notes.push(note);
  if (!zones.ok && zones.error !== "") notes.push(zones.error);

  const gerbers = await runExport(
    subprocess,
    toolchain,
    [toolchain.kicadCli, "pcb", "export", "gerbers", "-o", gerberDir, pcbFile],
    cwd,
    signal,
  );
  if (!gerbers.ok) return { ...empty, error: "Gerber 导出失败：" + gerbers.error };

  const drill = await runExport(
    subprocess,
    toolchain,
    [toolchain.kicadCli, "pcb", "export", "drill", "-o", gerberDir, pcbFile],
    cwd,
    signal,
  );
  const drillFiles = listFiles(gerberDir).filter((file) => /\.(drl|nc|g\d+|xln)$/iu.test(file.name));
  if (!drill.ok) notes.push("钻孔文件导出失败：" + drill.error);

  const posFile = join(outDir, board + "-pos.csv");
  const pos = await runExport(
    subprocess,
    toolchain,
    [toolchain.kicadCli, "pcb", "export", "pos", "--format", "csv", "--units", "mm", "-o", posFile, pcbFile],
    cwd,
    signal,
  );
  if (!pos.ok) notes.push("贴片坐标导出失败：" + pos.error);

  // CPL：KiCad 的 pos.csv 是页面坐标（Y 朝下、负数），平移成「板左下角、Y 向上」。
  let cplFile = "";
  let cplCount = 0;
  if (pos.ok) {
    try {
      const box = readBoardBox(readFileSync(pcbFile, "utf8"));
      const cpl = normalizePosCsv(readFileSync(posFile, "utf8"), box);
      for (const note of cpl.notes) notes.push(note);
      if (cpl.ok) {
        cplFile = join(outDir, board + "-cpl.csv");
        writeFileSync(cplFile, cpl.text, "utf8");
        cplCount = cpl.rows.length;
      } else if (cpl.error !== "") {
        notes.push("CPL 没生成：" + cpl.error + "（原样保留 pos.csv）");
      }
    } catch (error) {
      notes.push("CPL 没生成：" + (error instanceof Error ? error.message : String(error)) + "（原样保留 pos.csv）");
    }
  }

  const step = await exportStep(subprocess, toolchain, pcbFile, join(outDir, board + ".step"), signal);
  if (!step.ok) notes.push("STEP 导出失败：" + step.error);
  if (step.missingModels.length > 0) notes.push("缺 3D 模型：" + step.missingModels.join("、"));

  const gerbers_list = listFiles(gerberDir);
  if (gerbers_list.length === 0) notes.push("Gerber 目录是空的：检查板子是否已经铺铜/布线");

  // 整包（S190）：一个 zip 里放 Gerber、钻孔、CPL、BOM 与清单。SMT 厂与打样厂要的是「一次给全」。
  let bundleFile = "";
  let bundleBytes = 0;
  let bundleFiles = 0;
  if (options?.bundle === true && gerbers_list.length > 0) {
    const bundle = writeFabricationBundle({ pcbFile, board, outDir, gerberDir, files: gerbers_list, cplFile, stepFile: step.stepFile, stepBytes: step.bytes, notes });
    if (bundle.ok) {
      bundleFile = bundle.file;
      bundleBytes = bundle.bytes;
      bundleFiles = bundle.files;
      notes.push("整包已生成：" + bundle.file + "（" + String(bundle.files) + " 个文件）");
    } else {
      notes.push("整包没生成：" + bundle.error);
    }
  }

  return {
    ok: true,
    error: "",
    outDir,
    gerberDir,
    gerbers: gerbers_list,
    stepFile: step.stepFile,
    stepBytes: step.bytes,
    posFile: pos.ok ? posFile : "",
    cplFile,
    cplCount,
    drillFiles,
    bundleFile,
    bundleBytes,
    bundleFiles,
    notes,
  };
}

export interface BundleInput {
  readonly pcbFile: string;
  readonly board: string;
  readonly outDir: string;
  readonly gerberDir: string;
  readonly files: readonly FabricationFile[];
  readonly cplFile: string;
  readonly stepFile: string;
  readonly stepBytes: number;
  readonly notes: readonly string[];
  /** 明确跳过的 DRC 检查（写进 ignored.txt）。 */
  readonly ignoredChecks?: readonly string[];
  /** 明确决定不修的可制造性告警（写进 ignored.txt）。 */
  readonly dfmIgnored?: readonly string[];
}

/**
 * 把一次导出打成一个 zip。
 *
 * 目录结构照工厂习惯：`gerbers/` 放 Gerber 与钻孔（有些厂要求放一起），`cpl/` 放贴片坐标，
 * `bom.csv` 放元件清单，`manifest.txt` 写清楚每个文件的字节数与导出说明。
 * 3D 的 STEP 大于 8 MB 时不塞进来——它是给机械的，不是给板厂的。
 */
export function writeFabricationBundle(input: BundleInput): { ok: boolean; error: string; file: string; bytes: number; files: number } {
  const entries: ZipEntry[] = [];
  const lines: string[] = [];
  lines.push("板子：" + input.pcbFile);
  lines.push("导出目录：" + input.outDir);
  lines.push("");
  for (const file of input.files) {
    try {
      entries.push({ name: "gerbers/" + file.name, data: readFileSync(join(input.gerberDir, file.name)) });
      lines.push("gerbers/" + file.name + "  " + String(file.bytes) + " B");
    } catch (error) {
      lines.push("gerbers/" + file.name + "  读失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (input.cplFile !== "") {
    try {
      const name = input.cplFile.split(/[\\/]/u).pop() ?? "board-cpl.csv";
      entries.push({ name: "cpl/" + name, data: readFileSync(input.cplFile) });
      lines.push("cpl/" + name + "  " + String(statSync(input.cplFile).size) + " B");
    } catch (error) {
      lines.push("cpl 读失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }
  // BOM 可能没有 circuit.json（手工板）：有就带上，没有就明说。
  const circuitCandidates = [join(input.outDir, "..", "circuit.json"), join(input.outDir, "circuit.json")];
  const circuit = circuitCandidates.find((item) => existsSync(item)) ?? "";
  if (circuit !== "") {
    try {
      const report = readBom(circuit);
      if (report.ok && report.lines.length > 0) {
        entries.push({ name: "bom.csv", data: Buffer.from(renderBomCsv(report), "utf8") });
        lines.push("bom.csv  " + String(report.lines.length) + " 行 / " + String(report.componentCount) + " 个元件");
      } else {
        lines.push("bom.csv  没生成：" + (report.ok ? "清单为空" : report.error));
      }
    } catch (error) {
      lines.push("bom.csv  读失败：" + (error instanceof Error ? error.message : String(error)));
    }
  } else {
    lines.push("bom.csv  跳过：导出目录附近没有 circuit.json（手工画的板子没有 BOM 源）");
  }
  if (input.stepBytes > 0 && input.stepBytes <= 8 * 1024 * 1024) {
    try {
      entries.push({ name: "3d/" + (input.stepFile.split(/[\\/]/u).pop() ?? "board.step"), data: readFileSync(input.stepFile) });
      lines.push("3d/" + (input.stepFile.split(/[\\/]/u).pop() ?? "board.step") + "  " + String(input.stepBytes) + " B");
    } catch {
      lines.push("3d STEP 读失败，未进包");
    }
  } else if (input.stepBytes > 8 * 1024 * 1024) {
    lines.push("3d STEP 超过 8 MB，未进包（机械用，板厂不需要）");
  }
  lines.push("");
  lines.push("导出说明：");
  for (const note of input.notes) lines.push("- " + note);
  // 忽略项记录（S239）：板厂与复核的人都要知道「哪些告警是明确决定不修的」。
  // 没有忽略项也写一个文件——"没写"和"没有"是两件事。
  const ignoredLines: string[] = [];
  ignoredLines.push("板子：" + input.board + ".kicad_pcb");
  ignoredLines.push("导出目录：" + input.outDir);
  ignoredLines.push("");
  const ignoredChecks = input.ignoredChecks ?? [];
  const dfmIgnored = input.dfmIgnored ?? [];
  if (ignoredChecks.length === 0 && dfmIgnored.length === 0) {
    ignoredLines.push("无：这次没有跳过任何 DRC 检查，也没有明确不修的可制造性告警。");
  } else {
    if (ignoredChecks.length > 0) {
      ignoredLines.push("跳过的 DRC 检查：");
      for (const item of ignoredChecks) ignoredLines.push("- " + item);
      ignoredLines.push("");
    }
    if (dfmIgnored.length > 0) {
      ignoredLines.push("明确不修的可制造性告警：");
      for (const item of dfmIgnored) ignoredLines.push("- " + item);
    }
  }
  entries.unshift({ name: "ignored.txt", data: Buffer.from(ignoredLines.join("\n") + "\n", "utf8") });
  entries.unshift({ name: "manifest.txt", data: Buffer.from(lines.join("\n") + "\n", "utf8") });

  const file = join(input.outDir, input.board + "-fabrication.zip");
  try {
    const data = createZip(entries);
    writeFileSync(file, data);
    return { ok: true, error: "", file, bytes: data.length, files: entries.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), file: "", bytes: 0, files: 0 };
  }
}
