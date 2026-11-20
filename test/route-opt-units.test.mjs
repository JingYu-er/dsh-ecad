import test from "node:test";
import assert from "node:assert/strict";

import { optimizeRoutes } from "../lib/engine/ecad/pcb/route-opt.js";

function segment(net, layer, x1, y1, x2, y2, widthMm = 0.2) {
  return { net, layer, widthMm, x1, y1, x2, y2 };
}

function angle(s) {
  const deg = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

test("线形后处理：斜线拆成正交段 + 45° 段，两端点不动（S194）", () => {
  const result = optimizeRoutes([segment("SIG", "F.Cu", 0, 0, 10, 4)], []);
  assert.equal(result.segments.length, 2);
  assert.equal(result.split, 1);
  const [first, second] = result.segments;
  assert.ok(Math.abs(first.x2 - 6) < 1e-9 && Math.abs(first.y2 - 0) < 1e-9);
  assert.ok(Math.abs(second.x1 - 6) < 1e-9 && Math.abs(second.y1 - 0) < 1e-9);
  assert.ok(Math.abs(second.x2 - 10) < 1e-9 && Math.abs(second.y2 - 4) < 1e-9);
  assert.ok(Math.abs(angle(first) % 90) < 1e-6);
  assert.ok(Math.abs(angle(second) - 45) < 1e-6);
});

test("线形后处理：接近 45° 的段吸附过去，长度不变（S194）", () => {
  const result = optimizeRoutes([segment("SIG", "F.Cu", 0, 0, 10, 10.2)], []);
  assert.equal(result.segments.length, 1);
  assert.equal(result.snapped, 1);
  const only = result.segments[0];
  // 吸附保持长度不变（起点不动），所以终点落在 45° 射线上、按原长度外推
  const length = Math.hypot(only.x2 - only.x1, only.y2 - only.y1);
  assert.ok(Math.abs(length - Math.hypot(10, 10.2)) < 1e-9);
  assert.ok(Math.abs(angle(only) - 45) < 1e-6);
  assert.ok(result.diagonalRatio > 0.99);
});

test("线形后处理：同网络同层同宽度的共线段合并成一段（S194）", () => {
  const result = optimizeRoutes([
    segment("SIG", "F.Cu", 0, 0, 5, 0),
    segment("SIG", "F.Cu", 5, 0, 10, 0),
    segment("OTHER", "F.Cu", 5, 0, 10, 0),
  ], []);
  const sig = result.segments.filter((s) => s.net === "SIG");
  assert.equal(sig.length, 1);
  assert.equal(result.merged, 1);
  assert.equal(sig[0].x1, 0);
  assert.equal(sig[0].x2, 10);
  // 不同网络不会被合并
  assert.equal(result.segments.filter((s) => s.net === "OTHER").length, 1);
});

test("线形后处理：两端都不接线的过孔被删掉，接线的留下（S194）", () => {
  const result = optimizeRoutes(
    [segment("SIG", "F.Cu", 0, 0, 5, 0), segment("SIG", "B.Cu", 5, 0, 10, 0)],
    [
      { net: "SIG", x: 5, y: 0, drillMm: 0.3, diameterMm: 0.6 },
      { net: "SIG", x: 30, y: 30, drillMm: 0.3, diameterMm: 0.6 },
    ],
  );
  assert.equal(result.vias.length, 1);
  assert.equal(result.viasDropped, 1);
  assert.equal(result.vias[0].x, 5);
});

test("线形后处理：零长短段丢弃并写进 notes（S194）", () => {
  const result = optimizeRoutes([
    segment("SIG", "F.Cu", 0, 0, 0.001, 0),
    segment("SIG", "F.Cu", 0, 0, 10, 0),
  ], []);
  assert.equal(result.dropped, 1);
  assert.equal(result.segments.length, 1);
  assert.ok(result.notes.some((note) => note.includes("过短")));
});
