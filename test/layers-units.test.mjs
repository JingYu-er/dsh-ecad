import assert from "node:assert/strict";
import test from "node:test";

import { copperLayersOfBoard, layerSvgArgv } from "../lib/engine/ecad/pcb/layers.js";
import { coverageOf } from "../lib/engine/ecad/pcb/coverage.js";

const BOARD = `(kicad_pcb (version 20241229) (generator "test")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(1 "In1.Cu" signal)
\t\t(4 "B.Cu" signal)
\t)
\t(net 0 "")
\t(net 1 "GND")
\t(segment (start 0 0) (end 1 0) (width 0.25) (layer "F.Cu") (net 1))
\t(segment (start 0 1) (end 1 1) (width 0.25) (layer "In1.Cu") (net 1))
\t(zone (net 1) (net_name "GND") (layer "In1.Cu") (filled_polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)
`;

test("逐层图：一行层只认板层表，argv 保持同原点同比例（S230）", () => {
  // 板层表只有三个铜层；封装里的 (layers "F.Cu" "F.Paste") 不能算进来。
  assert.deepEqual(copperLayersOfBoard(BOARD + '\t(footprint "x" (layer "F.Cu") (layers "F.Cu" "F.Paste" "F.Mask"))\n'), ["F.Cu", "In1.Cu", "B.Cu"]);

  const argv = layerSvgArgv({
    kicadCli: "kicad-cli",
    output: "out/F_Cu.svg",
    layer: "F.Cu",
    boardFile: "board.kicad_pcb",
    blackAndWhite: true,
  });
  assert.deepEqual(argv, [
    "kicad-cli",
    "pcb",
    "export",
    "svg",
    "--output",
    "out/F_Cu.svg",
    "--layers",
    "F.Cu",
    "--page-size-mode",
    "2",
    "--exclude-drawing-sheet",
    "--mode-single",
    "--black-and-white",
    "board.kicad_pcb",
  ]);
  // 「只留板面」是两张图能叠的前提：页码模式不是 2 时原点会随图纸变。
  assert.equal(argv[argv.indexOf("--page-size-mode") + 1], "2");

  // 覆盖记录也认同一份层表：In1 有填充、F.Cu 只有信号。
  const coverage = coverageOf(BOARD);
  assert.deepEqual(coverage.layers.map((layer) => layer.name), ["F.Cu", "In1.Cu", "B.Cu"]);
  assert.equal(coverage.layers[1].filled, 1);
  assert.equal(coverage.layers[0].zones, 0);
});
