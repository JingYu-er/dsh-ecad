import test from "node:test";
import assert from "node:assert/strict";

import { copperLayersOf, effectiveRouteSpec, failedNetsOf, ownPlaneArgv, ownRuleArgv, planeAssignment, widthHistogram } from "../lib/engine/ecad/pcb/krt-own.js";

test("自有规则布线：net/layer/电源宽度都按空格分隔的列表传（S195）", () => {
  const argv = ownRuleArgv("C:/krt", {
    inputPcb: "in.kicad_pcb",
    outputPcb: "out.kicad_pcb",
    options: {
      trackWidthMm: 0.2,
      clearanceMm: 0.15,
      powerNets: ["*GND*", "*VCC*"],
      powerWidthMm: 0.45,
      layers: ["F.Cu", "B.Cu"],
      ordering: "mps",
      viaSizeMm: 0.45,
      viaDrillMm: 0.25,
      maxRipup: 2,
      nets: ["SIG_A", "SIG_B"],
    },
  });
  const text = argv.join(" ");
  assert.ok(text.includes("py_router/route.py".replace("/", "\\")) || text.includes("route.py"));
  assert.ok(argv.includes("--track-width") && argv[argv.indexOf("--track-width") + 1] === "0.200");
  assert.ok(argv.includes("--clearance") && argv[argv.indexOf("--clearance") + 1] === "0.150");
  // nargs="+" 的参数必须是多个独立 token，不能拼成 "F.Cu,B.Cu"
  const layers = argv.slice(argv.indexOf("--layers") + 1, argv.indexOf("--layers") + 3);
  assert.deepEqual(layers, ["F.Cu", "B.Cu"]);
  const nets = argv.slice(argv.indexOf("--nets") + 1, argv.indexOf("--nets") + 3);
  assert.deepEqual(nets, ["SIG_A", "SIG_B"]);
  const powers = argv.slice(argv.indexOf("--power-nets") + 1, argv.indexOf("--power-nets") + 3);
  assert.deepEqual(powers, ["*GND*", "*VCC*"]);
  const widths = argv.slice(argv.indexOf("--power-nets-widths") + 1, argv.indexOf("--power-nets-widths") + 3);
  assert.deepEqual(widths, ["0.450", "0.450"]);
  assert.ok(argv.includes("--smoothing"));
  assert.ok(argv.includes("--clearance-ceiling"));
});

test("自有规则布线：铜层数从 (layers …) 里数，读不到按 2 层（S195）", () => {
  assert.equal(copperLayersOf('(layers "F.Cu" "In1.Cu" "In2.Cu" "B.Cu")'), 4);
  assert.equal(copperLayersOf('(layers "F.Cu" "B.Cu")'), 2);
  assert.equal(copperLayersOf("(kicad_pcb)"), 2);
  // KiCad 真文件的层表是跨行嵌套的，按 [^)]* 截只会抓到一半
  const multiline = '(kicad_pcb (layers\n  (0 "F.Cu" signal)\n  (2 "B.Cu" signal)\n  (5 "F.SilkS" user)\n))';
  assert.equal(copperLayersOf(multiline), 2);
});

test("自有规则布线：产出板子的线宽分布能数出来，细段占比据此算（S196）", () => {
  const board = [
    "(kicad_pcb",
    "  (segment (start 1 1) (end 2 1) (width 0.3) (layer \"F.Cu\") (net 1))",
    "  (segment\n    (start 1 2)\n    (end 2 2)\n    (width 0.127)\n    (layer \"F.Cu\")\n    (net 1)\n  )",
    "  (segment (start 1 3) (end 2 3) (width 0.3) (layer \"B.Cu\") (net 2))",
    ")",
  ].join("\n");
  const widths = widthHistogram(board);
  assert.equal(widths["0.3000"], 2);
  assert.equal(widths["0.1270"], 1);
});

test("自有规则布线：第一轮没布通的网点出来去重，第二轮只补这些（S197）", () => {
  const failed = failedNetsOf({ failed_single: ["A", "B"], open_single: ["B", "C"], failed: undefined });
  assert.deepEqual(failed, ["A", "B", "C"]);
  assert.deepEqual(failedNetsOf({}), []);
});

test("4/6 层先铺平面：GND 走内层，参数用同一套 preset（S198）", () => {
  const argv = ownPlaneArgv("C:/krt", {
    inputPcb: "a.kicad_pcb",
    outputPcb: "b.kicad_pcb",
    planeNets: ["GND"],
    planeLayers: ["In1.Cu"],
    options: { trackWidthMm: 0.2, clearanceMm: 0.15, powerNets: ["GND"], powerWidthMm: 0.45, viaSizeMm: 0.45, viaDrillMm: 0.25 },
  });
  assert.match(argv[0], /route_planes\.py$/u);
  assert.deepEqual(argv.slice(argv.indexOf("--nets"), argv.indexOf("--nets") + 2), ["--nets", "GND"]);
  assert.deepEqual(argv.slice(argv.indexOf("--plane-layers"), argv.indexOf("--plane-layers") + 2), ["--plane-layers", "In1.Cu"]);
  assert.equal(argv[argv.indexOf("--track-width") + 1], "0.450");
});

test("内层分配：地固定 In1，电源取焊盘最多的那个，2 层只有地（S199）", () => {
  const board = (nets) =>
    "(kicad_pcb " + nets.map((net, i) => `(pad "${i + 1}" smd rect (at 0 0) (size 0.3 0.4) (layers \"F.Cu\") (net \"${net}\"))`).join(" ") + ")";
  const four = planeAssignment(board(["GND", "GND", "GND", "V3V3", "V3V3", "5V"]), 4);
  assert.deepEqual(four, { nets: ["GND", "V3V3"], layers: ["In1.Cu", "In2.Cu"] });
  // 2 层没有内层可用，只返回地
  assert.deepEqual(planeAssignment(board(["GND", "V3V3"]), 2), { nets: ["GND"], layers: ["In1.Cu"] });
  // 没有地网就一个平面都不铺，交给调用方回退
  assert.deepEqual(planeAssignment(board(["SDA", "SCL"]), 4), { nets: [], layers: [] });
});

test("内层分配认图纸路径前缀：/ADS1256/AVDD_5V 这种名字也算电源网（S200）", () => {
  const board =
    '(kicad_pcb ' +
    ['(pad "1" smd rect (at 0 0) (size 0.3 0.4) (layers "F.Cu") (net "GND"))',
     '(pad "2" smd rect (at 0 0) (size 0.3 0.4) (layers "F.Cu") (net "/ADS1256/AVDD_5V"))',
     '(pad "3" smd rect (at 0 0) (size 0.3 0.4) (layers "F.Cu") (net "/ADS1256/AVDD_5V"))',
     '(pad "4" smd rect (at 0 0) (size 0.3 0.4) (layers "F.Cu") (net "/ADS1256/GNDA"))'].join(" ") +
    ")";
  assert.deepEqual(planeAssignment(board, 4), { nets: ["GND", "/ADS1256/AVDD_5V"], layers: ["In1.Cu", "In2.Cu"] });
});

test("引擎以自身目录为 cwd：相对路径要按输入板所在目录解析（S200）", () => {
  const argv = ownRuleArgv("C:/krt", {
    inputPcb: "D:/proj/PCB1.kicad_pcb",
    outputPcb: "PCB1-own.kicad_pcb",
    options: { trackWidthMm: 0.2, clearanceMm: 0.15 },
  });
  assert.equal(argv[1], "D:/proj/PCB1.kicad_pcb");
  assert.ok(argv[argv.indexOf("--output") + 1].replace(/\\/gu, "/").startsWith("D:/proj/"));
});

test("预设不能比板子自己的规则更松：间距/过孔取较严的一侧（S200）", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dsh-ecad-spec-"));
  try {
    const board = join(dir, "PCB1.kicad_pcb");
    writeFileSync(board, "(kicad_pcb)", "utf8");
    writeFileSync(
      join(dir, "PCB1.kicad_pro"),
      JSON.stringify({ net_settings: { classes: [{ name: "Default", clearance: 0.19812, via_diameter: 0.6, via_drill: 0.3, track_width: 0.19812 }] } }),
      "utf8",
    );
    const preset = { signalWidthMm: 0.2, signalClearanceMm: 0.15, viaDiameterMm: 0.45, viaDrillMm: 0.25 };
    const spec = effectiveRouteSpec(board, preset);
    assert.equal(spec.clearanceMm, 0.19812);
    assert.equal(spec.viaDiameterMm, 0.6);
    assert.equal(spec.viaDrillMm, 0.3);
    assert.equal(spec.trackWidthMm, 0.2);
    assert.ok(spec.notes.some((note) => note.includes("板子自己的规则")));

    // 板子没写规则时按预设，并且要说明「读不到板子的规则」
    const bare = join(dir, "bare.kicad_pcb");
    writeFileSync(bare, "(kicad_pcb)", "utf8");
    const loose = effectiveRouteSpec(bare, preset);
    assert.equal(loose.clearanceMm, 0.15);
    assert.ok(loose.notes.some((note) => note.includes("没有 .kicad_pro")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
