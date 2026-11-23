import test from "node:test";
import assert from "node:assert/strict";

import { planOrthogonalize } from "../lib/engine/ecad/pcb/ortho.js";

function board(segments) {
  const text = segments
    .map(
      (track, index) =>
        '\t(segment (start ' + String(track.x1) + " " + String(track.y1) + ") (end " + String(track.x2) + " " + String(track.y2) +
        ") (width " + String(track.width ?? 0.25) + ') (layer "F.Cu") (net ' + String(track.net ?? 1) + "))",
    )
    .join("\n");
  return '(kicad_pcb (version 20240108) (general (thickness 1.6))\n\t(layers "F.Cu" "B.Cu")\n' + text + "\n)\n";
}

test("走线风格：长斜线能改成 L 形就报候选，被别的东西挡住就保留（S243）", () => {
  const text = board([
    { x1: 0, y1: 0, x2: 5, y2: 5 },
    // 挡在另一条候选旁边的一条横线
    { x1: 0, y1: 6.4, x2: 10, y2: 6.4, net: 2 },
    { x1: 10, y1: 10, x2: 15, y2: 15 },
  ]);
  const report = planOrthogonalize(text, { minRunMm: 2, clearanceMm: 0.2 });
  assert.equal(report.ok, true);
  assert.equal(report.runs.length, 2);
  assert.ok(report.candidates.length >= 1);
  // 斜线占比按总长算
  assert.ok(report.diagonalShare > 0.5);
  assert.ok(report.notes.some((note) => note.includes("斜线占比")));
  // 只读：不改文本
  assert.equal(report.applied, 0);
});

test("走线风格：全横竖的板子没有长斜线，斜线占比为 0（S243）", () => {
  const text = board([
    { x1: 0, y1: 0, x2: 10, y2: 0 },
    { x1: 10, y1: 0, x2: 10, y2: 8 },
  ]);
  const report = planOrthogonalize(text, {});
  assert.equal(report.runs.length, 0);
  assert.equal(report.diagonalShare, 0);
  assert.equal(report.candidates.length, 0);
  assert.equal(planOrthogonalize("").error, "板子文件是空的");
});
