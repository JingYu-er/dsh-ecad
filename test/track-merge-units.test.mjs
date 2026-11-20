import test from "node:test";
import assert from "node:assert/strict";

import { mergeCollinearTracks } from "../lib/engine/ecad/pcb/track-merge.js";

function board(segments) {
  return (
    "(kicad_pcb\n" +
    segments
      .map(
        ([x1, y1, x2, y2, width, layer, net]) =>
          `\t(segment\n\t\t(start ${x1} ${y1})\n\t\t(end ${x2} ${y2})\n\t\t(width ${width})\n\t\t(layer "${layer}")\n\t\t(net "${net}")\n\t\t(uuid "00000000-0000-4000-a000-00000000000${Math.round(Math.random() * 9)}")\n\t)\n`,
      )
      .join("") +
    ")\n"
  );
}

test("共线合并：三段连成一条直线的接缝会被并成一段（S201）", () => {
  const text = board([
    [0, 0, 1, 0, 0.2, "F.Cu", "A"],
    [1, 0, 2, 0, 0.2, "F.Cu", "A"],
    [2, 0, 3, 0, 0.2, "F.Cu", "A"],
  ]);
  const result = mergeCollinearTracks(text);
  assert.equal(result.before, 3);
  assert.equal(result.after, 1);
  assert.ok(result.text.includes("(start 0 0)"));
  assert.ok(result.text.includes("(end 3 0)"));
});

test("共线合并：不同网络、不同宽度、拐弯都不合并（S201）", () => {
  const text = board([
    [0, 0, 1, 0, 0.2, "F.Cu", "A"],
    [1, 0, 2, 0, 0.2, "F.Cu", "B"], // 网络不同
    [2, 0, 3, 0, 0.3, "F.Cu", "B"], // 宽度不同
    [3, 0, 3, 1, 0.3, "F.Cu", "B"], // 拐弯
  ]);
  const result = mergeCollinearTracks(text);
  assert.equal(result.before, 4);
  assert.equal(result.after, 4);
});
