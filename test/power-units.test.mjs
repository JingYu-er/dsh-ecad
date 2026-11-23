import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { analyzePower, viaCurrentA } from "../lib/engine/ecad/pcb/power-spec.js";

const root = new URL("../", import.meta.url);

function board(parts) {
  return "(kicad_pcb\n" + parts.join("\n") + "\n)\n";
}

test("粗供电：细段按电流判、有铺铜的网络不判线宽（S234）", () => {
  const thin = analyzePower(
    board([
      '(net 1 "V3V3")',
      '(segment (start 0 0) (end 5 0) (width 0.1) (layer "F.Cu") (net 1))',
      '(segment (start 5 0) (end 9 0) (width 0.3) (layer "F.Cu") (net 1))',
    ]),
    { currents: [{ net: "V3V3", currentA: 0.5 }] },
  );
  assert.equal(thin.ok, true);
  assert.equal(thin.thin.length, 1);
  assert.equal(thin.thin[0].widthMm, 0.1);
  assert.ok(thin.thin[0].requiredMm > 0.1);
  assert.equal(thin.findings[0].id, "power.thin-segment");

  const poured = analyzePower(
    board([
      '(net 1 "V3V3")',
      '(segment (start 0 0) (end 5 0) (width 0.1) (layer "F.Cu") (net 1))',
      '(zone (net 1) (layer "F.Cu") (filled_polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))',
    ]),
    { currents: [{ net: "V3V3", currentA: 0.5 }] },
  );
  assert.equal(poured.thin.length, 0);
  assert.equal(poured.findings.length, 0);
  assert.ok(poured.notes.some((note) => note.includes("铺铜")));
});

test("粗供电：并联过孔按每孔载流算，不够就报（S234）", () => {
  const text = board([
    '(net 2 "VBUS")',
    '(segment (start 0 0) (end 5 0) (width 1) (layer "F.Cu") (net 2))',
    '(via (at 1 1) (size 0.6) (drill 0.3) (net 2))',
  ]);
  const report = analyzePower(text, { currents: [{ net: "VBUS", currentA: 3 }] });
  assert.equal(report.vias.length, 1);
  const via = report.vias[0];
  assert.equal(via.vias, 1);
  assert.ok(via.perViaA > 1 && via.perViaA < 3, "Ø0.3 孔每孔应在 1–3 A 之间，实际 " + String(via.perViaA));
  assert.equal(via.ok, false);
  assert.equal(via.needed, 2);
  assert.equal(report.findings.find((finding) => finding.id === "power.via-shortfall") !== undefined, true);
  assert.equal(viaCurrentA(0.6, 25, 10) > viaCurrentA(0.3, 25, 10), true);
});

test("粗供电：没有顶层声明时按内联网络名识别（S234）", () => {
  const text = board([
    '(footprint "x" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (net "GND")))',
    '(segment (start 0 0) (end 5 0) (width 0.2) (layer "B.Cu") (net "GND"))',
  ]);
  const report = analyzePower(text, { currents: [{ net: "GND", currentA: 1 }] });
  assert.equal(report.specs.length, 1);
  assert.equal(report.specs[0].net, "GND");
  assert.equal(report.specs[0].source, "given");
  assert.equal(report.thin.length, 1);
});

test("粗供电：真板子上跑不炸（S234）", () => {
  const file = process.env["DSH_ECAD_POWER_BOARD"] ?? "";
  if (file === "") return;
  const report = analyzePower(readFileSync(file, "utf8"), {});
  assert.equal(typeof report.ok, "boolean");
  assert.ok(Array.isArray(report.specs));
  void root;
});
