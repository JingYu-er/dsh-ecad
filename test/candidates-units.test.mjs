import test from "node:test";
import assert from "node:assert/strict";

import { compareCandidates, renderCandidatesMarkdown } from "../lib/engine/ecad/pcb/candidates.js";

function boardTracks(tracks) {
  const segments = tracks
    .map(
      (track) =>
        '\t(segment (start ' + String(track.x1) + " " + String(track.y1) + ") (end " + String(track.x2) + " " + String(track.y2) +
        ") (width " + String(track.width ?? 0.25) + ') (layer "' + (track.layer ?? "F.Cu") + '") (net ' + String(track.net ?? 1) + "))",
    )
    .join("\n");
  return '(kicad_pcb (version 20240108) (general (thickness 1.6))\n\t(layers "F.Cu" "B.Cu")\n\t(net 1 "GND")\n' + segments + "\n)\n";
}

test("候选比较：几何改变按身份键算，判据增减会写成记录（S240）", () => {
  const base = boardTracks([{ x1: 0, y1: 0, x2: 10, y2: 0 }]);
  const same = boardTracks([{ x1: 0, y1: 0, x2: 10, y2: 0 }]);
  const added = boardTracks([
    { x1: 0, y1: 0, x2: 10, y2: 0 },
    { x1: 10, y1: 0, x2: 10, y2: 5 },
  ]);

  const report = compareCandidates("base.kicad_pcb", base, [
    { label: "原样另存", file: "same.kicad_pcb", text: same },
    { label: "多走一段", file: "added.kicad_pcb", text: added },
  ]);

  assert.equal(report.ok, true);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].addedSegments, 0);
  assert.equal(report.rows[0].verdict, "持平");
  assert.equal(report.rows[1].addedSegments, 1);
  assert.equal(report.rows[1].removedSegments, 0);
  assert.ok(report.markdown.includes("| 候选 | 真实几何改变 | 约束核验（相对基线） | 结论 |"));
  assert.ok(report.markdown.includes("原样另存"));
});

test("候选比较：直线多拐一个 90° 会被记成判据变差（S240）", () => {
  const base = boardTracks([{ x1: 0, y1: 0, x2: 10, y2: 0 }]);
  const corner = boardTracks([
    { x1: 0, y1: 0, x2: 5, y2: 0 },
    { x1: 5, y1: 0, x2: 5, y2: 5 },
  ]);
  const report = compareCandidates("base.kicad_pcb", base, [{ label: "拐弯", file: "corner.kicad_pcb", text: corner }]);
  assert.equal(report.rows[0].rightAngles, 1);
  assert.equal(report.rows[0].verdict, "更差");
  assert.ok(report.rows[0].score > 0);
});

test("候选比较：空输入与空候选都如实报（S240）", () => {
  assert.equal(compareCandidates("base.kicad_pcb", "", []).error, "基线板子是空的");
  const empty = boardTracks([]);
  assert.equal(compareCandidates("base.kicad_pcb", empty, []).error, "一个候选都没给");
  const markdown = renderCandidatesMarkdown(
    "base.kicad_pcb",
    { segments: 1, vias: 0, rightAngles: 0, acuteAngles: 0, stairRuns: 0, badExits: 0, busUneven: 0, gaps: 2 },
    [],
  );
  assert.ok(markdown.includes("基线缺陷：回流缺口 2 处"));
});
