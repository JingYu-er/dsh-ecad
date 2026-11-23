import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyEscapes, planEscapes } from "../lib/engine/ecad/pcb/escape.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const board = (extra) =>
  "(kicad_pcb (version 20241229) (generator pcbnew)\n" +
  '  (general (thickness 1.6))\n' +
  '  (layers "F.Cu" "B.Cu")\n' +
  '  (net 0 "")\n  (net 1 "SIG")\n  (net 2 "GND")\n' +
  '  (footprint "Test:SOIC" (layer "F.Cu") (at 20 20)\n' +
  '    (property "Reference" "U1")\n' +
  '    (pad "1" smd rect (at 0 0) (size 1.4 0.5) (layers "F.Cu" "F.Mask") (net 1 "SIG"))\n' +
  '    (pad "2" smd rect (at 0 1.27) (size 1.4 0.5) (layers "F.Cu" "F.Mask") (net 2 "GND"))\n' +
  "  )\n" +
  extra +
  ")\n";

test("焊盘逃逸短段：长轴外侧铺 0.8 mm，周围有别的网就不铺（S245）", () => {
  const dir = tempDir("ecad-escape-");
  const file = join(dir, "board.kicad_pcb");
  writeFileSync(file, board(""), "utf8");
  const plan = planEscapes(readFileSync(file, "utf8"), {});
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.stubs.length, 2, "两颗有网络的焊盘都该铺");
  const first = plan.stubs.find((stub) => stub.pad === "1");
  assert.ok(first);
  assert.equal(first.from.x, 20.7, "从焊盘长轴外侧开始");
  assert.equal(first.to.x, 21.5, "短段 0.8 mm");
  assert.equal(first.widthMm, 0.2);

  // 在短段落点上放一条别的网走线，这颗就不该铺
  const blocked = board(
    '  (segment (start 21.6 19) (end 21.6 21) (width 0.25) (layer "F.Cu") (net 2))\n',
  );
  const second = planEscapes(blocked, {});
  assert.equal(second.stubs.length, 1, "被别的网挡住的那颗不铺");
  assert.equal(second.skipped.length, 1);
  assert.match(second.skipped[0].reason, /太近/u);
});

test("焊盘逃逸短段：写回时按板子的网络写法补 (segment)，有声明写编号、没声明写名字（S245）", () => {
  const declared = board("");
  const added = applyEscapes(declared, planEscapes(declared, {}));
  assert.equal(added.added, 2);
  assert.match(added.text, /\(segment \(start 20\.7 20\) \(end 21\.5 20\) \(width 0\.2\) \(layer "F\.Cu"\) \(net 1\)\)/u);

  const inline = declared.replace('  (net 1 "SIG")\n', "").replace('(net 1 "SIG")', '(net "SIG")');
  const inlinePlan = planEscapes(inline, {});
  const inlineAdded = applyEscapes(inline, inlinePlan);
  assert.match(inlineAdded.text, /\(net "SIG"\)/u, "没有声明表时写内联名字");
});

test("焊盘逃逸短段：空板说清楚原因，不长篇报错（S245）", () => {
  const plan = planEscapes('(kicad_pcb (version 20241229)\n  (layers "F.Cu" "B.Cu")\n)\n', {});
  assert.equal(plan.ok, false);
  assert.match(plan.error, /没有读到一个焊盘/u);
});
