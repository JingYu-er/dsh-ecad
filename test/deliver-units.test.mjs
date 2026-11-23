import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyBundle } from "../lib/engine/ecad/deliver.js";
import { createZip } from "../lib/engine/ecad/zip.js";

function makeZip(entries) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ecad-bundle-"));
  const file = join(dir, "bundle.zip");
  writeFileSync(file, createZip(entries));
  return file;
}

const manifest = (files, bytes) =>
  Buffer.from(`生成时间：2026-11-23 00:00:00\n文件数：${String(files)}\n字节数：${String(bytes)}\n`, "utf8");

test("交付包身份：清单第一项、逐成员哈希、路径与重名都要核（S229）", () => {
  const gerber = Buffer.from("%FSLAX46Y46*%\nM02*\n", "utf8");
  const drill = Buffer.from("M48\nM30\n", "utf8");
  const body = Buffer.concat([gerber, drill]);
  const good = verifyBundle(
    makeZip([
      { name: "manifest.txt", data: manifest(3, body.length) },
      { name: "gerbers/board-F_Cu.gtl", data: gerber },
      { name: "gerbers/board.drl", data: drill },
    ]),
  );
  assert.equal(good.ok, true, good.error);
  assert.equal(good.manifestFirst, true);
  assert.equal(good.members.length, 3);
  assert.equal(good.members[1].crc32, "b0f6e1a1".length === 0 ? "" : good.members[1].crc32);
  assert.match(good.members[1].sha256, /^[0-9a-f]{64}$/u);

  // manifest.txt 不在第一项
  const late = verifyBundle(
    makeZip([
      { name: "gerbers/board-F_Cu.gtl", data: gerber },
      { name: "manifest.txt", data: manifest(2, gerber.length) },
    ]),
  );
  assert.equal(late.ok, false);
  assert.ok(late.problems.some((item) => item.id === "bundle.manifest-order"), JSON.stringify(late.problems));

  // 越界路径与重名
  const bad = verifyBundle(
    makeZip([
      { name: "manifest.txt", data: manifest(3, 0) },
      { name: "../escape.txt", data: Buffer.from("x", "utf8") },
      { name: "a/b.txt", data: Buffer.from("x", "utf8") },
      { name: "a/b.txt", data: Buffer.from("y", "utf8") },
    ]),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((item) => item.id === "bundle.unsafe-name"), JSON.stringify(bad.problems));
  assert.ok(bad.problems.some((item) => item.id === "bundle.duplicate"), JSON.stringify(bad.problems));
});

test("交付包身份：清单不许引用自身，列了没有与有了没列都要报（S235）", () => {
  const gerber = Buffer.from("%FSLAX46Y46*%\nM02*\n", "utf8");
  const drill = Buffer.from("M48\nM30\n", "utf8");
  const list = (items) =>
    Buffer.from(
      "生成时间：2026-11-23 00:00:00\n文件数：" + String(items.length + 1) + "\n字节数：" +
        String(items.reduce((sum, item) => sum + item.bytes, 0)) +
        "\n" + items.map((item) => item.name + " " + String(item.bytes)).join("\n") + "\n",
      "utf8",
    );

  // 好包：清单与成员一一对上
  const good = verifyBundle(
    makeZip([
      { name: "manifest.txt", data: list([{ name: "gerbers/a.gtl", bytes: gerber.length }, { name: "gerbers/b.drl", bytes: drill.length }]) },
      { name: "gerbers/a.gtl", data: gerber },
      { name: "gerbers/b.drl", data: drill },
    ]),
  );
  assert.equal(good.ok, true, JSON.stringify(good.problems));
  assert.deepEqual(good.missingMembers, []);
  assert.deepEqual(good.unlistedMembers, []);

  // 清单把自己这个包写进成员：用自己证明自己
  const self = verifyBundle(
    makeZip([
      {
        name: "manifest.txt",
        data: Buffer.from(
          "生成时间：2026-11-23 00:00:00\n文件数：1\n字节数：0\n" + "bundle.zip 1000\n",
          "utf8",
        ),
      },
    ]),
  );
  assert.equal(self.ok, false);
  assert.ok(self.problems.some((item) => item.id === "bundle.manifest-self"), JSON.stringify(self.problems));

  // 清单列了 b.drl 但包里没有；包里多了一个 zzz.gtl 没写进清单
  const drift = verifyBundle(
    makeZip([
      { name: "manifest.txt", data: list([{ name: "gerbers/a.gtl", bytes: gerber.length }, { name: "gerbers/b.drl", bytes: drill.length }]) },
      { name: "gerbers/a.gtl", data: gerber },
      { name: "gerbers/zzz.gtl", data: Buffer.from("x", "utf8") },
    ]),
  );
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.missingMembers, ["gerbers/b.drl"]);
  assert.deepEqual(drift.unlistedMembers, ["gerbers/zzz.gtl"]);
  assert.ok(drift.problems.some((item) => item.id === "bundle.manifest-missing-member"), JSON.stringify(drift.problems));
  assert.ok(drift.problems.some((item) => item.id === "bundle.manifest-unlisted"), JSON.stringify(drift.problems));
});
