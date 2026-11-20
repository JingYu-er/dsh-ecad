import test from "node:test";
import assert from "node:assert/strict";

import {
  FREE_STACKUPS,
  estimateFabCost,
  freeStackupFor,
  holeCostOf,
  mmToMil,
  routingPreset,
  stackupCostOf,
  traceCostOf,
} from "../lib/engine/ecad/pcb/fab-tier.js";
import { checkDfm } from "../lib/engine/ecad/dfm.js";

test("成本档位：免费叠层只有 4 层 3313 与 6 层 3313，其余加 100–300（S193）", () => {
  assert.equal(FREE_STACKUPS.length, 2);
  const four = freeStackupFor(4);
  assert.ok(four !== null);
  assert.equal(four.id, "JLC04161H-3313");
  assert.equal(four.totalMm, 1.56);
  assert.equal(four.materials.length, 7);
  const six = freeStackupFor(6);
  assert.ok(six !== null);
  assert.equal(six.id, "JLC06161H-3313");
  assert.equal(six.totalMm, 1.54);
  assert.equal(six.materials.length, 11);
  assert.equal(freeStackupFor(2), null);

  assert.equal(stackupCostOf(2).free, true);
  assert.equal(stackupCostOf(2).surchargeYuan, 0);
  assert.equal(stackupCostOf(4).free, true);
  assert.equal(stackupCostOf(6).surchargeYuan, 0);

  const other = stackupCostOf(4, "别的板厚 2 oz");
  assert.equal(other.free, false);
  assert.equal(other.surchargeYuan, 200);
  assert.match(other.note, /100–300/u);
});

test("成本档位：孔径按下单页档位加收，0.3 起免费，越细越贵（S193）", () => {
  assert.equal(holeCostOf(0).addYuan, 0);
  assert.equal(holeCostOf(0.3).addYuan, 0);
  assert.equal(holeCostOf(0.4).addYuan, 0, "0.4 的孔也落在 0.3 档以内");
  assert.equal(holeCostOf(0.25).addYuan, 300);
  assert.equal(holeCostOf(0.2).addYuan, 300);
  assert.equal(holeCostOf(0.15).addYuan, 400);
  assert.equal(holeCostOf(0.1).addYuan, 400);
  assert.equal(holeCostOf(0.08).belowCapability, true);
  assert.match(holeCostOf(0.2).note, /300/u);
});

test("成本档位：多层 <3.5 mil 加 20%/30%，2 层不编数字（S193）", () => {
  assert.equal(Math.round(mmToMil(0.089) * 10) / 10, 3.5);
  const ok4 = traceCostOf(4, 0.2, 0.15);
  assert.equal(ok4.tier, "standard");
  assert.equal(ok4.surchargePct, 0);
  assert.match(ok4.note, /≥ 3\.5 mil/u);

  const fine4 = traceCostOf(4, 0.08, 0.08);
  assert.equal(fine4.tier, "fine");
  assert.equal(fine4.surchargePct, 20);
  assert.match(fine4.note, /20%/u);

  const fine10 = traceCostOf(10, 0.08, 0.08);
  assert.equal(fine10.surchargePct, 30);

  const two = traceCostOf(2, 0.1, 0.1);
  assert.equal(two.tier, "fine");
  assert.equal(two.surchargePct, 0, "2 层没有公开的加价条目，不能编数字");
  assert.match(two.note, /公开文档未列/u);
});

test("成本档位：布线预设不贴下限，2 层间距放到 0.30（S196）", () => {
  const two = routingPreset(2);
  assert.equal(two.signalWidthMm, 0.3);
  assert.equal(two.signalClearanceMm, 0.3);
  assert.equal(two.criticalSpacingMm, 0.9);
  assert.equal(two.viaDrillMm, 0.3);

  const four = routingPreset(4);
  assert.equal(four.signalWidthMm, 0.2);
  assert.equal(four.signalClearanceMm, 0.15);
  assert.equal(four.criticalSpacingMm, 0.6);
  assert.equal(four.powerWidthMm, 0.45);
  assert.ok(mmToMil(four.signalClearanceMm) > 3.5);
  assert.match(four.note, /加价线/u);

  const six = routingPreset(6);
  assert.equal(six.signalWidthMm, 0.2);
});

test("成本档位：三条加价合起来能算总加价，走线按货款比例折金额（S193）", () => {
  const report = estimateFabCost({
    layers: 4,
    minTrackMm: 0.08,
    minClearanceMm: 0.08,
    minDrillMm: 0.2,
    priceYuan: 100,
  });
  assert.equal(report.trace.surchargePct, 20);
  assert.equal(report.hole.addYuan, 300);
  assert.equal(report.stackup.surchargeYuan, 0);
  // 20% × 100 元 + 300 元孔径 + 0 层压
  assert.equal(report.surchargeYuan, 320);
  assert.equal(report.notes.length, 3);
});

test("成本档位：DFM 会把细线与小孔点名，标准档不报（S193）", () => {
  const fine = `(kicad_pcb (version 20241229)
  (layers "F.Cu" "B.Cu")
  (gr_line (start 0 0) (end 30 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 30 0) (end 30 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 30 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
  (segment (start 1 1) (end 5 1) (width 0.08) (layer "F.Cu"))
  (via (at 5 1) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu"))
)`;
  const report = checkDfm(fine);
  const rules = report.findings.map((finding) => finding.rule);
  assert.ok(rules.includes("dfm.trace-tier"), "2 层 0.08 mm 走线要报精细档");
  assert.ok(rules.includes("dfm.hole-tier"), "0.2 mm 孔要报 +300");
  const hole = report.findings.find((finding) => finding.rule === "dfm.hole-tier");
  assert.match(hole.message, /300/u);

  const clean = `(kicad_pcb (version 20241229)
  (layers "F.Cu" "B.Cu")
  (gr_line (start 0 0) (end 30 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 30 0) (end 30 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 30 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
  (segment (start 1 1) (end 5 1) (width 0.3) (layer "F.Cu"))
  (via (at 5 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu"))
)`;
  const cleanRules = checkDfm(clean).findings.map((finding) => finding.rule);
  assert.equal(cleanRules.includes("dfm.hole-tier"), false);
  assert.equal(cleanRules.includes("dfm.trace-tier"), false);
});
