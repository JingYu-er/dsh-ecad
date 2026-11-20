import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { planDecapMoves } from "../lib/engine/ecad/pcb/decap-place.js";

const dir = fileURLToPath(new URL("./fixtures/kicad-10-d-nfc/", import.meta.url));

test("去耦落位：按电源脚就近拉，挪完互不重叠（S205）", () => {
  const board = readFileSync(dir + "D_NFC.kicad_pcb", "utf8");
  const result = planDecapMoves(board, { schematicFile: dir + "D_NFC.kicad_sch" });
  assert.ok(result.moves.length >= 3, "至少应有几颗电容被拉近：" + JSON.stringify(result.notes));
  for (const move of result.moves) {
    assert.ok(move.afterMm < move.beforeMm, move.ref + " 应该更近了");
    assert.ok(move.afterMm <= 5, move.ref + " 挪完要落在 5 mm 内");
  }
  // 挪完之后彼此不能压在一起（0.4 mm 容差，避免浮点边界）。
  for (let i = 0; i < result.moves.length; i += 1) {
    for (let j = i + 1; j < result.moves.length; j += 1) {
      const a = result.moves[i].to;
      const b = result.moves[j].to;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 0.4, result.moves[i].ref + " 与 " + result.moves[j].ref + " 撞在一起了");
    }
  }
  assert.match(result.notes.join(" "), /去耦拉近/u);
});

test("去耦落位：没有原理图时不瞎挪，直接说明原因（S205）", () => {
  const board = readFileSync(dir + "D_NFC.kicad_pcb", "utf8");
  const result = planDecapMoves(board);
  assert.equal(result.moves.length, 0);
  assert.match(result.notes.join(" "), /power_in/u);
});

test("去耦落位：板上没有电容时安静返回（S205）", () => {
  const result = planDecapMoves("(kicad_pcb (version 20241229))", {});
  assert.equal(result.moves.length, 0);
  assert.match(result.notes.join(" "), /没有识别到去耦电容/u);
});
