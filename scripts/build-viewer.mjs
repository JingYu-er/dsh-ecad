#!/usr/bin/env node
/**
 * 把 three 视图打成一个自包含的 IIFE（全局名 `EcadViewer`）。
 *
 * 为什么要单独打一份：面板 `client/client.js` 是宿主加载器直接执行的纯 JS，不能有
 * ESM import；three 及其 addons 只能先打成 IIFE，再由面板用 <script> 动态加载
 * （`lib/viewer.bundle.js` 由 web 路由 `/dsh-ecad/api/viewer.js` 提供）。
 *
 * 为什么不内联进 client.js：主面板每次打开都要解析这 570 KB，而 3D 只是其中一个页签。
 * 为什么产物只落 lib/：npm 的 files 同时带 client 与 lib，两处各留一份等于白打 570 KB。
 */

import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const entry = resolve(projectRoot, "client", "viewer", "entry.js");
const out = resolve(projectRoot, "lib", "viewer.bundle.js");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  globalName: "EcadViewer",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: out,
  logLevel: "warning",
});

const kb = (statSync(out).size / 1024).toFixed(1);
console.log("client/viewer/entry.js -> lib/viewer.bundle.js（" + kb + " KB）");
