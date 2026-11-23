import test from "node:test";
import assert from "node:assert/strict";

import { applyWiden, planWiden } from "../lib/engine/ecad/pcb/widen.js";

function board(segments, pads = []) {
  const padText = pads
    .map(
      (pad, index) =>
        '\t(footprint "T:P" (property "Reference" "U' + String(index + 1) + '")\n\t\t(at 0 0)\n' +
        '\t\t(pad "1" smd rect (at ' + String(pad.x) + " " + String(pad.y) + ") (size " + String(pad.w) + " " + String(pad.h) +
        ') (layers "F.Cu" "F.Mask") (net 9 "V3V3"))\n\t)',
    )
    .join("\n");
  const segmentText = segments
    .map(
      (track, index) =>
        '\t(segment (start ' + String(track.x1) + " " + String(track.y1) + ") (end " + String(track.x2) + " " + String(track.y2) +
        ") (width " + String(track.width) + ') (layer "' + (track.layer ?? "F.Cu") + '") (net ' + String(index + 1) + '))',
    )
    .join("\n");
  return '(kicad_pcb (version 20240108) (general (thickness 1.6))\n\t(layers "F.Cu" "B.Cu")\n\t(net 1 "A")\n\t(net 2 "B")\n\t(net 9 "V3V3")\n' +
    padText + "\n" + segmentText + "\n)\n";
}

test("细走线加宽：周围有空间就补到 0.2，写回时只改宽度（S242）", () => {
  const text = board([
    { x1: 0, y1: 0, x2: 10, y2: 0, width: 0.127 },
    { x1: 0, y1: 2, x2: 10, y2: 2, width: 0.127 },
  ]);
  const plan = planWiden(text, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.thin, 2);
  assert.equal(plan.widened.length, 2);
  assert.equal(plan.blocked.length, 0);

  const next = applyWiden(text, plan);
  assert.equal(next.applied, 2);
  assert.equal(next.missed, 0);
  assert.ok(next.text.includes("(width 0.200)"));
  assert.equal((next.text.match(/\(width 0.127\)/gu) ?? []).length, 0);
});

test("细走线加宽：焊盘旁边挤不下的保持原宽并如实列出（S242）", () => {
  const text = board(
    [{ x1: 0, y1: 0, x2: 10, y2: 0, width: 0.127 }],
    [{ x: 5, y: 0.31, w: 0.4, h: 0.4 }],
  );
  const plan = planWiden(text, {});
  assert.equal(plan.widened.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, "pad");
  assert.ok(plan.notes.some((note) => note.includes("保持原宽")));

  const next = applyWiden(text, plan);
  assert.equal(next.applied, 0);
  assert.ok(next.text.includes("(width 0.127)"));
});

test("细走线加宽：全是粗线时不报改动（S242）", () => {
  const text = board([{ x1: 0, y1: 0, x2: 10, y2: 0, width: 0.25 }]);
  const plan = planWiden(text, {});
  assert.equal(plan.thin, 0);
  assert.ok(plan.notes.some((note) => note.includes("不需要加宽")));
  assert.equal(planWiden("").error, "板子文件是空的");
});
