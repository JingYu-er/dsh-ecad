// npm pack 解包烟测：挡住"作者本机测不出、发布形态必炸"的一整类问题。
//
// 为什么要有它：
//   1) npm 打包永远排除 .gitignore（它同时是 npm 的忽略过滤器），而它曾被列为必需文件
//      ——npm 安装的用户 100% 失败，源码安装的开发者完全测不出。
//   2) 跑的是"打包出来的 lib"，不是"源码目录"——漏拷的引擎、没进包的数据文件都会在这里现形。
//
// 跑法：npm run test:pack（pack 到临时目录，不动仓库）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用插件自己的解包器（lib/engine/tar.js）：Windows 自带的是 libarchive 的 bsdtar，
// 读不懂 npm 用 pax 扩展头标记的非 ASCII 文件名，会直接报
// "Archive entry has empty or unreadable filename"。
import { extractTarGz } from "../lib/engine/tar.js";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "dsh-pack-smoke-"));
const failures = [];
const say = (ok, name, detail = "") => {
  console.log((ok ? "  · " : "  ✗ ") + name + (ok || detail === "" ? "" : "：" + detail));
  if (!ok) failures.push(name + (detail === "" ? "" : "：" + detail));
};

try {
  // 1) npm pack 到临时目录
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = execFileSync(npm, ["pack", "--json", "--pack-destination", work], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const meta = JSON.parse(out.trim());
  const packed = meta[0].filename;
  say(existsSync(join(work, packed)), "npm pack 产出 tarball");
  const unpacked = meta[0].unpackedSize;
  console.log("  · 解包大小：" + (unpacked / 1024).toFixed(1) + " KB / " + meta[0].size + " B（压缩）");

  // 2) 用插件自己的 tar 解包，断言必需文件都在
  const extracted = extractTarGz(readFileSync(join(work, packed)), work, { maxBytes: 256 * 1024 * 1024 });
  const pkgRoot = join(work, "package");
  say(existsSync(pkgRoot), "解包出 package/ 目录", extracted === 0 ? "返回 0" : "");

  const mustHave = [
    "lib/index.js",
    "lib/client.js",
    "lib/tools/pcb.js",
    "lib/tools/ecad.js",
    "lib/engine/ecad/pcb/pcb-svg.js",
    "lib/engine/ecad/fabrication.js",
    "lib/engine/ecad/bom.js",
    "lib/engine/ecad/netgate.js",
    "cordis.patch.yml",
    "assets/manifest.json",
  ];
  for (const rel of mustHave) {
    say(existsSync(join(pkgRoot, rel)), "包内文件存在：" + rel);
  }

  // client 源与构建产物等价（copy-client 是原样复制）
  const clientSrc = readFileSync(join(root, "client", "client.js"));
  const clientLib = readFileSync(join(pkgRoot, "lib", "client.js"));
  say(clientSrc.equals(clientLib), "lib/client.js 与 client/client.js 逐字节一致");

  // 3) 用**解包出来的** lib 真渲染一块板：验证 ecad 引擎在发布形态下能加载
  const pcbSvg = await import("file://" + join(pkgRoot, "lib", "engine", "ecad", "pcb", "pcb-svg.js").replace(/\\/gu, "/"));
  const board = [
    "(kicad_pcb (version 20241229) (generator smoke)",
    '  (layers "F.Cu" "B.Cu")',
    '  (gr_line (start 0 0) (end 20 0) (width 0.1) (layer "Edge.Cuts"))',
    '  (gr_line (start 20 0) (end 20 10) (width 0.1) (layer "Edge.Cuts"))',
    '  (gr_line (start 20 10) (end 0 10) (width 0.1) (layer "Edge.Cuts"))',
    '  (gr_line (start 0 10) (end 0 0) (width 0.1) (layer "Edge.Cuts"))',
    ')',
  ].join("\n");
  const rendered = pcbSvg.renderPcbSvg(
    (await import("file://" + join(pkgRoot, "lib", "engine", "ecad", "pcb", "scene.js").replace(/\\/gu, "/"))).parsePcbScene(
      board,
      join(pkgRoot, "smoke.kicad_pcb"),
    ),
    { maxPx: 120 },
  );
  say(rendered.ok === true, "解包产物能解析并渲染板图", rendered.ok ? "" : rendered.error);
  say(typeof rendered.svg === "string" && rendered.svg.includes("viewBox"), "板图 SVG 带 viewBox");
  say(Math.abs(rendered.widthMm - 23.2) < 0.5, "板图宽度含边距（20 + 2×1.6 mm）", String(rendered.widthMm));
} catch (error) {
  say(false, "烟测本身异常", error instanceof Error ? error.message : String(error));
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
}

console.log("");
if (failures.length > 0) {
  console.log("pack-smoke：失败 " + failures.length + " 项");
  console.log(failures.map((line) => "  · " + line).join("\n"));
  process.exitCode = 1;
} else {
  console.log("pack-smoke：全部通过");
}
