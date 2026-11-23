import test from "node:test";
import assert from "node:assert/strict";

import { analyzeSilk } from "../lib/engine/ecad/pcb/silk.js";

function board(pads, silkLines) {
  const padText = pads
    .map(
      (pad, index) =>
        '\t\t(pad "' + String(index + 1) + '" smd rect (at ' + String(pad.x) + " " + String(pad.y) + ") (size " +
        String(pad.w) + " " + String(pad.h) + ') (layers "' + (pad.layer ?? "F.Cu") + '" "F.Mask"))',
    )
    .join("\n");
  const silkText = silkLines
    .map(
      (line) =>
        "\t\t(fp_line (start " + String(line.x1) + " " + String(line.y1) + ") (end " + String(line.x2) + " " + String(line.y2) +
        ') (stroke (width 0.12) (type solid)) (layer "' + (line.layer ?? "F.SilkS") + '"))',
    )
    .join("\n");
  return '(kicad_pcb (version 20240108)\n\t(footprint "Test:QFN"\n\t\t(property "Reference" "U1")\n\t\t(at 10 10)\n' + padText + "\n" + silkText + "\n\t)\n)\n";
}

test("丝印体检：压到焊盘开窗要报，绕在外面的不报（S238）", () => {
  const clean = board([{ x: 0, y: 0, w: 2, h: 1 }], [{ x1: -2, y1: 1.2, x2: 2, y2: 1.2 }]);
  const cleanReport = analyzeSilk(clean);
  assert.equal(cleanReport.hits.overPad, 0);
  assert.equal(cleanReport.ok, true);

  const over = board([{ x: 0, y: 0, w: 2, h: 1 }], [{ x1: -2, y1: 0, x2: 2, y2: 0 }]);
  const overReport = analyzeSilk(over);
  assert.equal(overReport.hits.overPad, 1);
  assert.equal(overReport.ok, false);
  assert.match(overReport.findings[0].message, /U1 的丝印压到了/);
});

test("丝印体检：位号放在本体正中记一条提示，挪到角上不记（S238）", () => {
  const centered = '(kicad_pcb (version 20240108)\n\t(footprint "Test:IC"\n\t\t(property "Reference" "U2")\n\t\t(at 5 5)\n' +
    '\t\t(fp_text reference "U2" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1))))\n' +
    '\t\t(pad "1" smd rect (at -2 0) (size 1 0.6) (layers "F.Cu" "F.Mask"))\n\t)\n)\n';
  const centeredReport = analyzeSilk(centered);
  assert.equal(centeredReport.hits.centered, 1);
  assert.ok(centeredReport.findings.some((finding) => finding.id === "silk.centered-ref"));

  const corner = centered.replace('(fp_text reference "U2" (at 0 0)', '(fp_text reference "U2" (at -3.5 -2.5)');
  const cornerReport = analyzeSilk(corner);
  assert.equal(cornerReport.hits.centered, 0);
});

test("丝印体检：文字压在焊盘上要报，空板给说明", () => {
  const textOnPad = '(kicad_pcb (version 20240108)\n\t(footprint "Test:IC"\n\t\t(property "Reference" "U3")\n\t\t(at 0 0)\n' +
    '\t\t(pad "1" smd rect (at 2 0) (size 1 1) (layers "F.Cu" "F.Mask"))\n' +
    '\t\t(fp_text user "U3" (at 2 0) (layer "F.SilkS") (effects (font (size 1 1))))\n\t)\n)\n';
  const report = analyzeSilk(textOnPad);
  assert.equal(report.hits.textOnPad, 1);
  assert.ok(report.findings.some((finding) => finding.id === "silk.text-on-pad"));

  const empty = analyzeSilk("(kicad_pcb (version 20240108)\n)\n");
  assert.equal(empty.hits.segments, 0);
  assert.ok(empty.notes.some((note) => note.includes("没有丝印线")));
  assert.equal(analyzeSilk("").error, "板子文件是空的");
});
