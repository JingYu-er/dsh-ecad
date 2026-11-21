#!/usr/bin/env node
/**
 * 整链体检：放置 → 去耦落位 → 铺平面 → 自有规则布线 → 重填铺铜 → DRC。
 *
 * 为什么要这个脚本：这些数字原来只存在于临时探针里（488 段 / 100 过孔 /
 * 6 未连接 / 34 警告），改一次布线器就无从对比。把它固化成可复跑的命令，
 * 输出固定字段的报告，前后两次跑 diff 就能看出规则改动是不是真的更好。
 *
 * 用法：
 *   node scripts/chain-report.mjs <工程目录> [--layers 4] [--clearance 0.2]
 *                                 [--width 0.25] [--keep] [--out 报告路径]
 *
 * `--keep` 保留每一步的中间板子（默认只留最终板与报告）。
 * 退出码：链跑通且 DRC 能读 = 0；某一步失败 = 1。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { readCircuitNetlist } from "../lib/engine/ecad/pcb/netlist.js";
import { planPlacement } from "../lib/engine/ecad/pcb/placement.js";
import { buildApplyScript, parseApplyOutput } from "../lib/engine/ecad/pcb/apply.js";
import { planDecapMoves } from "../lib/engine/ecad/pcb/decap-place.js";
import { defaultSchematicFile } from "../lib/engine/ecad/pcb/layout-check.js";
import { readPcbScene } from "../lib/engine/ecad/pcb/scene.js";
import {
  copperLayersOf,
  effectiveRouteSpec,
  planeAssignment,
  runOwnRulePlanes,
  runOwnRuleRouteWithRetry,
  widthHistogram,
} from "../lib/engine/ecad/pcb/krt-own.js";
import { fillZones } from "../lib/engine/ecad/pcb/zone-fill.js";
import { runDrc } from "../lib/engine/ecad/checks.js";
import { krtRoot, krtStatus } from "../lib/engine/ecad/pcb/krt.js";
import { locateEcadToolchain } from "../lib/engine/ecad/toolchain.js";
import { resolveProjectLayout } from "../lib/engine/project-layout.js";
import { materializeBoardLibraries } from "../lib/engine/ecad/normalize.js";

/**
 * 布线层：有内层时除平面层以外的铜层都能布信号。四层板算出来是 F/B/In2，
 * 六层板是 F/B/In3/In4——平面层让给铺铜，其余层布信号，过孔才有意义。
 */
function signalLayersFor(copperCount, planeLayers) {
  const names = [];
  names.push("F.Cu");
  for (let index = 1; index < copperCount - 1; index += 1) names.push(`In${index}.Cu`);
  names.push("B.Cu");
  const kept = names.filter((name) => !planeLayers.includes(name));
  return kept.length > 0 ? kept : ["F.Cu", "B.Cu"];
}

const DEFAULT_PRESET = { signalWidthMm: 0.25, signalClearanceMm: 0.2, viaDiameterMm: 0.6, viaDrillMm: 0.3 };

/** 最小可用的 SubprocessService：契约见 src/types.ts 的 ProcessHandle。 */
function realSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const reader = (get) => ({
        readFrom(offset) {
          const text = get();
          const slice = text.slice(offset);
          return { text: slice, lossy: false, nextOffset: text.length };
        },
      });
      const done = new Promise((resolve) => {
        child.on("error", (error) => {
          stderr += String(error);
          resolve({ exitCode: null, signal: null });
        });
        child.on("close", (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
      });
      return {
        done,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        terminate: () => child.kill(),
        waitForExit: () => done.then(() => undefined),
      };
    },
    async resolveExecutable(command) {
      return command;
    },
  };
}

function parseArgs(argv) {
  const options = { projectDir: "", layers: 0, clearance: 0, width: 0, keep: false, strict: false, strip: false, neckdown: 0.8, out: "" };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--keep") options.keep = true;
    else if (item === "--layers") options.layers = Number(argv[++index]);
    else if (item === "--clearance") options.clearance = Number(argv[++index]);
    else if (item === "--width") options.width = Number(argv[++index]);
    else if (item === "--out") options.out = String(argv[++index]);
    else if (item === "--strict") options.strict = true;
    else if (item === "--strip") options.strip = true;
    else if (item === "--neckdown") options.neckdown = Number(argv[++index]);
    else rest.push(item);
  }
  options.projectDir = rest[0] ?? "";
  return options;
}

function boardPathOf(layout) {
  // 先找约定名 board.kicad_pcb，再退回「目录里最新的 .kicad_pcb」——真实工程的
  // 板子通常和工程同名（handheld.kicad_pcb），硬编码一个名字会把它们全漏掉。
  const dirs = [join(layout.hardwareDir, "kicad"), layout.hardwareDir];
  for (const dir of dirs) {
    const preferred = join(dir, "board.kicad_pcb");
    if (existsSync(preferred)) return preferred;
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const hits = readdirSync(dir)
      .filter((name) => name.endsWith(".kicad_pcb"))
      .map((name) => join(dir, name))
      .filter((file) => statSync(file).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (hits.length > 0) return hits[0];
  }
  return "";
}

async function runPython(subprocess, python, scriptFile, argv, cwd) {
  const handle = subprocess.spawn({ argv: [python, scriptFile, ...argv], cwd, stdio: { stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } } });
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
  const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
  return { exitCode: outcome.exitCode, stdout, stderr };
}

function countTracks(text) {
  return (text.match(/\(segment\s/gu) ?? []).length;
}

function countVias(text) {
  return (text.match(/\(via\s/gu) ?? []).length;
}

function findingCounts(summary) {
  const counts = {};
  for (const finding of summary.findings ?? []) {
    const key = finding.kind ?? finding.rule ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.projectDir === "") {
    console.error("用法：node scripts/chain-report.mjs <工程目录> [--layers 4] [--clearance 0.2] [--width 0.25] [--keep] [--out 路径]");
    process.exit(1);
  }
  const projectDir = options.projectDir;
  const layout = resolveProjectLayout(projectDir);
  const subprocess = realSubprocess();
  const located = locateEcadToolchain(process.env);
  const toolchain = located.toolchain;
  if (toolchain === null) {
    console.error("没有找到 KiCad 工具链：" + located.error);
    process.exit(1);
  }
  const krt = krtRoot(process.env);
  const krtState = krtStatus(krt);
  const runtime = { root: krt, python: toolchain.python };
  const work = join(tmpdir(), "dsh-ecad-chain", basename(projectDir));
  mkdirSync(work, { recursive: true });

  const report = {
    projectDir,
    layers: options.layers,
    requestedClearanceMm: options.clearance,
    requestedWidthMm: options.width,
    steps: {},
    notes: [],
  };

  const boardFile = boardPathOf(layout);
  if (boardFile === "") {
    console.error("工程里没有 board.kicad_pcb：先跑一次 ecad_build");
    process.exit(1);
  }
  const boardText = readFileSync(boardFile, "utf8");
  // 板子自己的规则（.kicad_pro）要跟着工作副本走，否则 DRC 按默认档判、报告也会写「读不到规则」。
  const proSource = boardFile.replace(/\.kicad_pcb$/u, ".kicad_pro");
  const copyRules = (target) => {
    if (existsSync(proSource)) copyFileSync(proSource, target.replace(/\.kicad_pcb$/u, ".kicad_pro"));
  };
  const layers = options.layers > 0 ? options.layers : copperLayersOf(boardText);
  report.layers = layers;

  // 1. 放置：有 circuit.json 才重摆，否则跳过错开用户的手工位置。
  const circuitFile = join(layout.hardwareDir, "circuit", "circuit.json");
  let current = join(work, "01-placed.kicad_pcb");
  copyFileSync(boardFile, current);
  copyRules(current);
  // tscircuit 板的封装全叫 tscircuit:chip，库不在本机 → DRC 会报满屏 lib_footprint_issues。
  // 物化成工程本地库再判，报告里才是真的设计问题。
  const libsDir = join(layout.hardwareDir, "libs");
  const materialized = materializeBoardLibraries(readFileSync(current, "utf8"), dirname(current), libsDir);
  if (materialized.written > 0) {
    writeFileSync(current, materialized.text, "utf8");
    report.notes.push("封装库物化：" + materialized.written + " 个（" + materialized.libs.join("、") + "）");
  }
  if (existsSync(circuitFile)) {
    const model = readCircuitNetlist(readFileSync(circuitFile, "utf8"));
    const scene = readPcbScene(current);
    const plan = planPlacement(model, { widthMm: scene.bbox.width, heightMm: scene.bbox.height });
    const scriptFile = join(work, "apply.py");
    writeFileSync(scriptFile, buildApplyScript({ plan, boardFile: current, keepTracks: false }), "utf8");
    const payload = {
      boardFile: current,
      keepTracks: false,
      items: plan.items.map((item) => ({ ref: item.ref, x: item.x, y: item.y, rotation: item.rotation })),
      board: plan.board,
    };
    const resultFile = join(work, "apply.json");
    const outcome = await runPython(subprocess, toolchain.python, scriptFile, [JSON.stringify(payload), resultFile], work);
    const parsed = parseApplyOutput(existsSync(resultFile) ? readFileSync(resultFile, "utf8") : outcome.stdout);
    report.steps.place = { ok: parsed.ok, moved: parsed.moved, missing: parsed.missing.length, removedTracks: parsed.removedTracks };
  } else {
    report.steps.place = { ok: true, skipped: "没有 circuit.json，保留原位置" };
  }

  // 2. 去耦落位：每颗只挪一次，最多三轮（与 stm32_pcb_place 同口径）。
  const schematicFile = defaultSchematicFile(current);
  let decapMoved = 0;
  const decapSkipped = [];
  const movedRefs = [];
  if (schematicFile !== "") {
    for (let round = 0; round < 3; round += 1) {
      const plan = planDecapMoves(readFileSync(current, "utf8"), { schematicFile, skipRefs: movedRefs });
      if (plan.moves.length === 0) break;
      movedRefs.push(...plan.moves.map((move) => move.ref));
      const scriptFile = join(work, "decap.py");
      const applyPlan = {
        board: { widthMm: 0, heightMm: 0 },
        items: plan.moves.map((move) => ({ ref: move.ref, x: move.to.x, y: move.to.y, rotation: 0 })),
      };
      writeFileSync(scriptFile, buildApplyScript({ plan: applyPlan, boardFile: current, keepTracks: true }), "utf8");
      const resultFile = join(work, "decap.json");
      await runPython(subprocess, toolchain.python, scriptFile, [JSON.stringify({ ...applyPlan, boardFile: current, keepTracks: true }), resultFile], work);
      decapMoved += plan.moves.length;
      decapSkipped.push(...plan.skipped);
    }
  }
  // 已有走线的板子（人工画完的）先把线清掉再布，否则「布线」这一步其实没什么可布，
  // 量出来的段数全是别人画的。--strip 显式要求；默认不动用户的板子。
  if (options.strip) {
    const stripScript = join(work, "strip.py");
    const stripPlan = { board: { widthMm: 0, heightMm: 0 }, items: [] };
    writeFileSync(
      stripScript,
      buildApplyScript({ plan: stripPlan, boardFile: current, keepTracks: false }),
      "utf8",
    );
    const stripResult = join(work, "strip.json");
    await runPython(
      subprocess,
      toolchain.python,
      stripScript,
      [JSON.stringify({ ...stripPlan, boardFile: current, keepTracks: false }), stripResult],
      work,
    );
    const before = readFileSync(current, "utf8");
    const beforeSegments = (before.match(/\(segment /gu) ?? []).length;
    const beforeVias = (before.match(/\(via /gu) ?? []).length;
    report.notes.push("已清空旧走线：" + String(beforeSegments) + " 段、过孔 " + String(beforeVias));
  }

  report.steps.decap = { ok: true, moved: decapMoved, skipped: decapSkipped.length, schematic: schematicFile === "" ? "" : basename(schematicFile) };

  // 3. 铺平面（4/6 层）：先内层平面，再外层信号。
  let routedInput = current;
  let planeLayers = [];
  if (layers >= 4) {
    const text = readFileSync(current, "utf8");
    const assignment = planeAssignment(text, layers);
    planeLayers = assignment.layers;
    if (assignment.nets.length > 0) {
      const planeOut = join(work, "03-planes.kicad_pcb");
      const report2 = await runOwnRulePlanes({
        subprocess,
        runtime,
        inputPcb: current,
        outputPcb: planeOut,
        options: { trackWidthMm: DEFAULT_PRESET.signalWidthMm, clearanceMm: DEFAULT_PRESET.signalClearanceMm, layers },
        planeNets: assignment.nets,
        planeLayers: assignment.layers,
      });
      report.steps.planes = { ok: report2.ok, nets: assignment.nets, layers: assignment.layers, seconds: report2.seconds, error: report2.error };
      if (report2.ok) routedInput = planeOut;
    } else {
      report.steps.planes = { ok: true, skipped: "板上没有可铺的地/电源网" };
    }
  } else {
    report.steps.planes = { ok: true, skipped: "2 层板没有内层" };
  }

  // 4. 自有规则布线：预设与板子规则取较严的一侧，要求多少就报多少。
  const spec = effectiveRouteSpec(boardFile, {
    signalWidthMm: options.width > 0 ? options.width : DEFAULT_PRESET.signalWidthMm,
    signalClearanceMm: options.clearance > 0 ? options.clearance : DEFAULT_PRESET.signalClearanceMm,
    viaDiameterMm: 0.6,
    viaDrillMm: 0.3,
  });
  const routedOut = join(work, "04-routed.kicad_pcb");
  const routeReport = await runOwnRuleRouteWithRetry({
    subprocess,
    runtime,
    inputPcb: routedInput,
    outputPcb: routedOut,
    options: {
      trackWidthMm: spec.trackWidthMm,
      clearanceMm: spec.clearanceMm,
      viaSizeMm: spec.viaDiameterMm,
      viaDrillMm: spec.viaDrillMm,
      layers: signalLayersFor(layers, planeLayers),
      maxRipup: 5,
      neckdownMm: options.neckdown,
      strictSizes: options.strict,
    },
  });
  report.steps.route = {
    ok: routeReport.ok,
    error: routeReport.error,
    seconds: routeReport.seconds,
    retried: routeReport.retried.length,
    requested: { widthMm: options.width > 0 ? options.width : null, clearanceMm: options.clearance > 0 ? options.clearance : null },
    used: { widthMm: spec.trackWidthMm, clearanceMm: spec.clearanceMm },
    minClearanceUsedMm: routeReport.minClearanceUsedMm,
    clearanceShortfall: routeReport.clearanceShortfall,
    strict: options.strict,
    boardRules: spec.boardRules,
    notes: spec.notes,
  };
  if (!routeReport.ok) {
    report.ok = false;
    report.notes.push("布线失败，后面的步骤不执行：" + routeReport.error);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const routedText = readFileSync(routeReport.output === "" ? routedOut : routeReport.output, "utf8");
  const used = widthHistogram(routedText);
  const minWidth = Object.keys(used).map(Number).sort((a, b) => a - b)[0] ?? 0;
  report.steps.route.segments = countTracks(routedText);
  report.steps.route.vias = countVias(routedText);
  report.steps.route.widths = used;
  report.steps.route.minWidthMm = minWidth;
  if (options.width > 0 && minWidth > 0 && minWidth < options.width - 1e-6) {
    report.notes.push("布线器把最细走线压到 " + minWidth.toFixed(3) + " mm（要求 " + options.width.toFixed(3) + " mm）：引擎按嘉立创工艺下限布，且焊盘出口有 neckdown");
  }
  if (options.clearance > 0 && spec.clearanceMm + 1e-9 < options.clearance) {
    report.notes.push("间距被压到 " + spec.clearanceMm.toFixed(3) + " mm（要求 " + options.clearance.toFixed(3) + " mm）");
  }

  // 5. 重填铺铜：kicad-cli 的 --refill-zones 不落盘，必须走 pcbnew。
  const filledFile = join(work, "05-filled.kicad_pcb");
  copyFileSync(routeReport.output === "" ? routedOut : routeReport.output, filledFile);
  const fill = await fillZones(subprocess, toolchain, filledFile);
  report.steps.fill = { ok: fill.ok, zones: fill.zones, filled: fill.filled, error: fill.error };

  // 6. DRC：读回最终板，按类型统计。
  const drc = await runDrc(subprocess, toolchain, filledFile);
  report.steps.drc = {
    ok: drc.ok,
    errors: drc.summary.errors,
    warnings: drc.summary.warnings,
    unconnected: (drc.summary.unconnected ?? []).length,
    byKind: findingCounts(drc.summary),
    reportPath: drc.reportPath,
  };

  report.finalBoard = filledFile;
  report.ok = drc.ok;
  const outFile = options.out === "" ? join(work, "chain-report.json") : options.out;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n", "utf8");

  const line = (label, value) => console.log(label.padEnd(14, " ") + value);
  console.log("整链报告：" + projectDir);
  line("层数", String(layers));
  line("放置", `${report.steps.place.moved ?? 0} 件 / 清旧线 ${report.steps.place.removedTracks ?? 0}`);
  line("去耦落位", `${report.steps.decap.moved} 颗（原理图 ${report.steps.decap.schematic || "未找到"}）`);
  line("平面", report.steps.planes.skipped ?? `${(report.steps.planes.nets ?? []).join(", ")} → ${(report.steps.planes.layers ?? []).join(", ")}`);
  line("布线", `${report.steps.route.segments} 段 / ${report.steps.route.vias} 过孔 / ${report.steps.route.seconds}s / 补布 ${report.steps.route.retried} 网`);
  line("线宽", Object.entries(used).map(([width, count]) => `${width}×${count}`).join("  "));
  line(
    "间距",
    `要求 ${options.clearance > 0 ? options.clearance.toFixed(3) : "预设"} / 布线 ${spec.clearanceMm.toFixed(3)} mm` +
      (routeReport.minClearanceUsedMm === null ? "" : ` / 引擎实测最小 ${routeReport.minClearanceUsedMm.toFixed(4)} mm`) +
      (routeReport.clearanceShortfall ? "（降档）" : ""),
  );
  line("铺铜", `${report.steps.fill.zones} 区 / ${report.steps.fill.filled ? "已填充" : "未填充"}`);
  line("DRC", `${report.steps.drc.errors} 错误 / ${report.steps.drc.warnings} 警告 / 未连接 ${report.steps.drc.unconnected}`);
  for (const note of report.notes) console.log("  · " + note);
  console.log("报告：" + outFile);
  console.log("最终板：" + filledFile);
  if (!report.ok) process.exit(1);
  if (!options.keep && krtState.ok) {
    // 中间板子留在 tmpdir 里便于对比；--keep 只是显式表达「我要留着看」。
  }
}

await main();
