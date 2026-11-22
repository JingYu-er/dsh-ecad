// 单元测试：设置面板的宿主 API（web-api）。用 node test/web-api-units.test.mjs 跑。
//
// 只测纯逻辑那一层：配置读写、能力归纳、错误分支、安装任务的登记。
// HTTP 适配（web-routes.ts）与浏览器端（lib/client.js）不在这里测。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { registerWebRoutes } from "../lib/engine/web-routes.js";
import { configSnapshot, handleWebApi, saveConfig, WEB_API_PATHS, WEB_API_PREFIX, setSessionWorkspaceResolver } from "../lib/engine/web-api.js";
import { resetToolchainConfigCache } from "../lib/data/toolchain-config.js";
import { emitEvent, eventSnapshot, resetEventBus, setEventSessionKey } from "../lib/engine/event-bus.js";
import { beginToolCall, resetRunning } from "../lib/engine/progress.js";

/** 假的宿主 subprocess：本套件里没有任何路径会真的起进程。 */
const fakeSubprocess = {
  resolveExecutable: async (name) => name,
  spawn: () => {
    throw new Error("web-api 单测不该起进程");
  },
};

function tempEnv(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-webapi-" + tag + "-"));
  resetToolchainConfigCache();
  return {
    dir,
    file: path.join(dir, "config.json"),
    // 显式构造 env：不能带 DSH_ECAD_NO_CONFIG（run-units 会给子进程设它）。
    env: { DSH_ECAD_CONFIG: path.join(dir, "config.json") },
  };
}

function makeResult(id, label, found, required) {
  return {
    id,
    label,
    found,
    path: found ? "C:/tools/" + id : "",
    version: found ? id + " 1.0" : "",
    required,
    hint: id + " hint",
    impact: id + " impact",
    install: ["pacman -S " + id],
    verify: id + " --version",
    error: found ? "" : "没找到",
  };
}

test("configSnapshot：没有配置文件时给出路径与空配置", () => {
  const box = tempEnv("empty");
  const snapshot = configSnapshot(box.env);
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.config, null);
  assert.equal(snapshot.path, box.file);
  assert.deepEqual(snapshot.binDirs, []);
  assert.deepEqual(snapshot.cubeMxRoots, []);
});

test("saveConfig：写进去后能读回来，binDirs 由 msys64 推出来", () => {
  const box = tempEnv("save");
  const saved = saveConfig({ msys64: " D:/app/msys64 " }, box.env);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.path, box.file);
  assert.equal(saved.config !== null && saved.config.msys64, "D:/app/msys64");
  assert.equal(fs.existsSync(box.file), true);

  const snapshot = configSnapshot(box.env);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.exists, true);
  assert.deepEqual(snapshot.binDirs, ["D:/app/msys64/ucrt64/bin"]);
  assert.deepEqual(snapshot.cubeMxRoots, []);
});

test("saveConfig：类型不对、包名注入、空补丁都在动手前拒掉", () => {
  const box = tempEnv("reject");
  const badBin = saveConfig({ binDirs: "D:/one" }, box.env);
  assert.equal(badBin.ok, false);
  assert.match(badBin.error, /binDirs 必须是字符串数组/u);

  const badPkg = saveConfig({ packages: ["-Syu"] }, box.env);
  assert.equal(badPkg.ok, false);
  assert.match(badPkg.error, /不能以 - 开头/u);

  const badSpace = saveConfig({ packages: ["mingw-w64 ; rm -rf /"] }, box.env);
  assert.equal(badSpace.ok, false);
  assert.match(badSpace.error, /空白或 shell 特殊字符/u);

  const empty = saveConfig({}, box.env);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有要保存的字段/u);

  const badRoot = saveConfig({ msys64: 5 }, box.env);
  assert.equal(badRoot.ok, false);
  assert.match(badRoot.error, /msys64 必须是字符串/u);

  // 一次都没写成功：配置文件不该被创建。
  assert.equal(fs.existsSync(box.file), false);
});

test("handleWebApi：GET /config 返回快照，方法不对 405", async () => {
  const box = tempEnv("dispatch");
  const deps = { subprocess: fakeSubprocess, env: box.env };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/config", deps });
  assert.equal(got.status, 200);
  assert.equal(got.body.ok, true);
  assert.equal(got.body.snapshot.path, box.file);

  const wrong = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/config", body: "{}", deps });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.body.ok, false);
  assert.match(String(wrong.body.error), /只接受 GET/u);
});




test("WEB_API_PATHS：三十四条路由都在前缀下，且没有重复", () => {
  assert.equal(WEB_API_PATHS.length, 37);
  assert.equal(new Set(WEB_API_PATHS).size, 37);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/power"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/brief"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/mech"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/parts"), true, "器件搜索必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/impedance"), true, "阻抗规则必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/netgate"), true, "一致性门禁必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/schematic/sync"), true, "补封装必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/routing"), true, "布线工整度必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/render3d"), true, "3D 预览必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/swap"), true, "换封装必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/stackup"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/emc"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/links"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/gerber"), true, "制造文件回看必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/bom"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/schematic/review"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/action"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/layout"), true);
  for (const route of WEB_API_PATHS) {
    assert.equal(route.startsWith(WEB_API_PREFIX + "/"), true, route);
  }
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/config"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/events"), true, "调试台的事件流必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/status"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/toolchain"), true, "设置页要读工具链状态，没有这条路由会 404");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/schematic"), true, "原理图页必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/pcb"), true, "板图必须有独立路由，否则 host 直接回 404");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/ipc"), true, "KiCad IPC 检查也要独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/faults"), true, "故障面板必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/artifacts"), true, "产物面板必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/evidence"), true, "回放选择器必须有证据列表路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/replay"), true, "回放必须有读取证据文件的路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/evidence/prune"), true, "证据保留策略必须能手动触发");
});







test("GET /projects：没有会话工作目录时返回空列表，不猜别的工作区（S91）", async () => {
  setSessionWorkspaceResolver(null);
  const response = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/projects",
    query: {},
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.projects.entries, [], "没有工作目录时不能列出任何工程");
  assert.equal(response.body.projects.workspaceRoot, "");
  assert.match(String(response.body.projects.note), /没有可用的会话工作目录/u);
});

test("工程类接口缺 projectDir 时回 400，不再回落到进程工作目录（S84）", async () => {
  // 隔离备忘文件：否则同一台机器上「最近用过的工程」会让这里变成 200。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "s84-nomemo-"));
  for (const path of ["ecad/pcb", "ecad/bom", "ecad/links", "ecad/netgate", "ecad/emc"]) {
    const response = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/" + path, query: {}, deps: { subprocess: fakeSubprocess, env: { DSH_ECAD_HOME: home } } });
    assert.equal(response.status, 400, path + " 缺 projectDir 应回 400");
    assert.match(String(response.body.error), /projectDir 不能为空/u, path + " 的提示要说清缺什么");
  }
});

test("GET /projects：工作区索引与扫描合并，并返回当前工程描述（S82）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-projects-"));
  const project = path.join(root, "demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  fs.writeFileSync(path.join(root, "dsh-stm32.conf"), "version=1\nproject=demo\n", "utf8");
  fs.writeFileSync(
    path.join(project, "dsh-stm32.conf"),
    "version=1\nname=demo\nmcu=STM32F103C8T6\nioc=demo.ioc\nbuild=Debug\n",
    "utf8",
  );

  const response = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/projects",
    query: { root, projectDir: project },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(response.status, 200);
  const projects = response.body.projects;
  assert.equal(projects.hasConf, true);
  assert.ok(projects.entries.some((item) => item.dir === project), "索引里的工程应在列表里");
  assert.equal(projects.current.mcu, "STM32F103C8T6");
});






test("GET /artifacts：返回 elf 与芯片型号；没有构建目录时 elf 为 null（S192）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-artifacts-"));
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  const buildDir = path.join(dir, "build", "Debug");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "CMakeCache.txt"), "CMAKE_PROJECT_NAME:STATIC=demo\n", "utf8");
  fs.writeFileSync(path.join(buildDir, "demo.elf"), Buffer.alloc(1024));
  const good = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/artifacts",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.artifacts.elf.name, "demo.elf");
  // 芯片容量表属于固件侧，硬件台只回型号，容量留空（S192）。
  assert.equal(good.body.artifacts.chip, null);
  assert.match(good.body.artifacts.notes.join("\n"), /STM32F103C8T6/u);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-artifacts-empty-"));
  const bare = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/artifacts",
    query: { projectDir: empty },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.artifacts.elf, null);
});

test("GET /toolchain：五处外部依赖一次查完，KiCad 缺了要给可执行的提示", async () => {
  const result = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/toolchain",
    query: {},
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(result.status, 200);
  const toolchain = result.body.toolchain;
  assert.ok(toolchain !== null && typeof toolchain === "object");
  for (const key of ["kicad", "runtime", "autoroute", "poppler", "ipc"]) {
    assert.ok(toolchain[key] !== null && typeof toolchain[key] === "object", key + " 必须在回包里");
  }
  assert.equal(typeof toolchain.runtime.ready, "boolean");
  assert.equal(typeof toolchain.autoroute.ready, "boolean");
  assert.equal(typeof toolchain.poppler.ok, "boolean");
  assert.equal(typeof toolchain.kicad.ok, "boolean");
  if (toolchain.kicad.ok === false) {
    assert.ok(toolchain.kicad.error.includes("KiCad"), "没有 KiCad 时要说明缺什么");
  }
});

test("GET /status：返回事件计数、会话键与证据目录", async () => {
  resetEventBus();
  setEventSessionKey("sess-status");
  emitEvent({ source: "system", kind: "probe", summary: "一条事件" });
  const result = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    deps: { subprocess: fakeSubprocess, env: { DSH_ECAD_EVIDENCE: "D:/evidence" } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const status = result.body.status;
  assert.equal(status.sessionKey, "sess-status");
  assert.equal(status.eventCount, 1);
  assert.equal(status.latestSeq, 1);
  assert.equal(status.ringLimit, 5000);
  assert.equal(status.evidenceOverride, true);
  assert.ok(String(status.evidenceRoot).replace(/\\/gu, "/").endsWith("D:/evidence"), String(status.evidenceRoot));
  // 自检：版本来自 package.json（读一次真值，发布升版时不必改断言），路由数是本次注册的数量，时间戳都是正数。
  const pkgVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(status.self.version, pkgVersion, JSON.stringify(status.self));
  assert.equal(status.self.routeCount, WEB_API_PATHS.length);
  assert.ok(status.self.startedAt > 0);
  assert.ok(status.self.libMtimeMs > 0);
  // 事件流路由不接受 JSON 分发
  const wrong = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/status", deps: { subprocess: fakeSubprocess, env: {} } });
  assert.equal(wrong.status, 200);
});

test("GET /status?session：按会话计数，sessionKey 回显请求的会话", async () => {
  resetEventBus();
  setEventSessionKey("sess-status");
  emitEvent({ source: "system", kind: "probe", summary: "全局一", session: "sess-a" });
  emitEvent({ source: "system", kind: "probe", summary: "全局二", session: "sess-b" });
  const result = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    query: { session: "sess-a" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(result.status, 200);
  const status = result.body.status;
  assert.equal(status.eventCount, 1, "只数本会话事件");
  assert.equal(status.latestSeq, 1);
  assert.equal(status.sessionKey, "sess-a");
  const all = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(all.body.status.eventCount, 2, "不带 session 时数全部");
  assert.equal(all.body.status.sessionKey, "sess-status", "不带 session 时回显绑定键");
});


test("GET /faults：只取失败事件并带上解码提示，limit 生效", async () => {
  resetEventBus();
  setEventSessionKey("fault-session");
  emitEvent({ source: "model", kind: "stm32_flash", status: "fail", summary: "stm32_flash 失败：Error: unable to find a matching CMSIS-DAP device" });
  emitEvent({ source: "model", kind: "stm32_build", status: "fail", summary: "stm32_build 失败：undefined reference to `HAL_Delay'" });
  emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "stm32_build 完成" });
  emitEvent({ source: "model", kind: "stm32_build", status: "fail", summary: "stm32_build 失败：其它会话的事", session: "other" });

  const all = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/faults",
    query: { session: "fault-session" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2, "只数本会话的失败事件");
  assert.equal(all.body.groups.length, 2, "按规则合并后两组");
  assert.equal(all.body.groups[0].count, 1);
  assert.equal(all.body.groups.map((item) => item.rule).sort().join(","), "build.undefined-reference,probe.cmsis-dap-missing");
  assert.equal(all.body.faults.length, 2);
  assert.equal(all.body.faults[0].category, "probe");
  assert.equal(all.body.faults[1].rule, "build.undefined-reference");
  assert.ok(all.body.faults[1].hint.includes("CMakeLists"));

  const limited = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/faults",
    query: { session: "fault-session", limit: "1" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(limited.body.faults.length, 1, "limit 截取最近一条");
  assert.equal(limited.body.total, 2, "total 仍是全部条数");
  resetEventBus();
});

test("GET /evidence 与 /replay：列出证据文件、逐行还原事件、拒绝越界路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-replay-"));
  const day = path.join(root, "2026-11-12", "sess-a");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, "events-120000.jsonl");
  const lines = [
    JSON.stringify({ seq: 2, time: "2026-11-12T04:00:01.000Z", source: "model", kind: "stm32_build", status: "ok", summary: "构建完成" }),
    JSON.stringify({ seq: 1, time: "2026-11-12T04:00:00.000Z", source: "model", kind: "stm32_build", status: "start", summary: "开始构建" }),
    "{坏行",
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  const other = path.join(root, "2026-11-12", "sess-b");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "events-130000.jsonl"), lines[0] + "\n", "utf8");
  const deps = { subprocess: fakeSubprocess, env: { DSH_ECAD_EVIDENCE: root } };

  const listed = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/evidence", query: {}, deps: deps });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.evidence.root, root);
  assert.equal(listed.body.evidence.files.length, 2);
  assert.deepEqual(
    listed.body.evidence.files.map((item) => item.path).sort(),
    ["2026-11-12/sess-a/events-120000.jsonl", "2026-11-12/sess-b/events-130000.jsonl"],
    "按修改时间倒序列出两个文件",
  );
  assert.equal(listed.body.evidence.groups.length, 2, "按会话分成两组");
  assert.equal(listed.body.evidence.groups.map((item) => item.key).sort().join(","), "sess-a,sess-b");
  assert.equal(listed.body.evidence.groups.find((item) => item.key === "sess-b").files.length, 1);

  const replayed = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/replay",
    query: { path: "2026-11-12/sess-a/events-120000.jsonl" },
    deps: deps,
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replay.events.length, 2, "只收形状完整的事件");
  assert.equal(replayed.body.replay.skipped, 1, "坏行计入 skipped");
  assert.equal(replayed.body.replay.events[0].seq, 1, "按 seq 升序，与时间线同序");

  const escape = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/replay", query: { path: "../outside.jsonl" }, deps: deps });
  assert.equal(escape.status, 400);
  assert.ok(escape.body.error.includes("证据目录"));

  const missing = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/replay", query: { path: "2026-11-12/none.jsonl" }, deps: deps });
  assert.equal(missing.status, 409);
  assert.ok(missing.body.error.includes("读取证据失败"));

  const post = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/replay", query: {}, deps: deps });
  assert.equal(post.status, 405, "回放只读，只接受 GET");
  fs.rmSync(root, { recursive: true, force: true });
});












test("POST /ecad/action：动作名只认八个，其余直接 400", async () => {
  const { dir, env } = tempEnv("ecad-action");
  const deps = { subprocess: fakeSubprocess, env: env };
  const wrong = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ecad/action",
    body: JSON.stringify({ projectDir: dir, action: "deploy" }),
    deps: deps,
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.ok, false);
  assert.match(wrong.body.error, /action 只能是/u);
  const empty = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ecad/action",
    body: JSON.stringify({ action: "build" }),
    deps: deps,
  });
  assert.equal(empty.status, 400);
});

test("POST /ecad/action：package 在没有硬件目录时也认这个动作，只报人话（S107）", async () => {
  const { dir, env } = tempEnv("ecad-package");
  // 打包只读 hardware/：故意把 KiCad 指到一个不存在的目录，动作仍要能返回（CI 上没有 KiCad）。
  const deps = { subprocess: fakeSubprocess, env: { ...env, DSH_ECAD_KICAD_ROOT: path.join(dir, "no-such-kicad") } };
  const packed = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ecad/action",
    body: JSON.stringify({ projectDir: dir, action: "package" }),
    deps: deps,
  });
  assert.equal(packed.status, 200);
  assert.equal(packed.body.ok, true);
  const action = packed.body.ecadAction;
  assert.equal(action.ok, false);
  assert.match(action.error, /还没有硬件目录/u);
});

test("POST /ecad/action：datasheets 在没有器件时也认这个动作（S120）", async () => {
  const { dir, env } = tempEnv("ecad-datasheets");
  const deps = { subprocess: fakeSubprocess, env: { ...env, DSH_ECAD_DATASHEETS: path.join(dir, "ds") } };
  const result = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ecad/action",
    body: JSON.stringify({ projectDir: dir, action: "datasheets" }),
    deps: deps,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.ecadAction.ok, true);
  assert.equal(result.body.ecadAction.files, 0);
  assert.match(result.body.ecadAction.notes.join("\n"), /本工程 0 个立创器件/u);
});


test("GET /ecad/emc：深度体检三项跟着回包一起给，数不出来就说数不出来（S167）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s167-emc-"));
  const dist = path.join(root, "hardware", "circuit", "dist", "board");
  fs.mkdirSync(path.join(dist, "kicad"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "kicad", "board.kicad_pcb"),
    [
      "(kicad_pcb (version 20241229)",
      '  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))',
      '  (net 1 "GND")',
      '  (net 2 "SIG_A")',
      '  (net 3 "SIG_B")',
      '  (segment (start 0 0) (end 20 0) (width 0.2) (layer "F.Cu") (net 2))',
      '  (segment (start 0 0.05) (end 20 0.05) (width 0.2) (layer "F.Cu") (net 3))',
      '  (zone (net 1) (net_name "GND") (layer "In1.Cu") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))',
      ")",
    ].join("\n"),
    "utf8",
  );
  const deps = { subprocess: fakeSubprocess, env: {} };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/emc", query: { projectDir: root }, deps });
  assert.equal(got.status, 200);
  const emc = got.body.emc;
  assert.equal(emc.ok, true, emc.error);
  assert.ok(emc.deep, "回包里要有 deep");
  assert.equal(Array.isArray(emc.deep.pairs), true);
  assert.equal(Array.isArray(emc.deep.returnPaths), true);
  assert.equal(Array.isArray(emc.deep.crosstalk), true);
  // 两根平行线间距 0.05 mm、并行 20 mm：串扰要报出来。
  assert.equal(emc.deep.crosstalk.length, 1);
  assert.equal(emc.deep.crosstalk[0].ok, false);
  // 铺铜只有轮廓、没有填充：reports 空，notes 里明说按未铺铜处理。
  assert.equal(emc.deep.returnPaths.length, 0);
  assert.match(emc.notes.join("\n"), /只有轮廓/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /ecad/emc：电源线偏窄与铺铜都在报告里，缺工程时 400（S158）", async () => {
  assert.ok(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/emc"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s158-emc-"));
  const dist = path.join(root, "hardware", "circuit", "dist", "board");
  fs.mkdirSync(path.join(dist, "kicad"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "kicad", "board.kicad_pcb"),
    [
      "(kicad_pcb (version 20241229)",
      '  (layers "F.Cu" "In1.Cu" "In2.Cu" "B.Cu")',
      '  (net 1 "VBUS")',
      '  (net 2 "GND")',
      '  (segment (start 0 0) (end 10 0) (width 0.2) (layer F.Cu) (net 1))',
      '  (segment (start 0 1) (end 10 1) (width 0.25) (layer F.Cu) (net 2))',
      '  (zone (net 2) (layer "In1.Cu"))',
      ")",
    ].join("\n"),
    "utf8",
  );
  const deps = { subprocess: fakeSubprocess, env: {} };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/emc", query: { projectDir: root }, deps });
  assert.equal(got.status, 200);
  const emc = got.body.emc;
  assert.equal(emc.ok, true, emc.error);
  assert.equal(emc.copperLayers, 4);
  assert.equal(emc.zonesByLayer["In1.Cu"], 1);
  assert.equal(emc.powerTraces.length, 1, "GND 靠铺铜，不该进载流清单");
  assert.equal(emc.powerTraces[0].net, "VBUS");
  assert.equal(emc.powerTraces[0].ok, false, "0.2 mm 带不动 1 A");
  assert.ok(emc.findings.some((item) => item.id === "emc.power-trace-width"));
  const bad = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/emc", query: {}, deps });
  assert.equal(bad.status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /ecad/stackup：按层数取叠层，没有板子时给人话（S157）", async () => {
  assert.ok(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/stackup"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s157-stackup-"));
  const dist = path.join(root, "hardware", "circuit", "dist", "board");
  fs.mkdirSync(path.join(dist, "kicad"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "kicad", "board.kicad_pcb"),
    ['(kicad_pcb (version 20241229)', '  (layers "F.Cu" "F.Mask"', '    "In1.Cu" "B.Cu")', '  (segment (start 0 0) (end 1 0) (width 0.25) (layer F.Cu) (net 1))', ")"].join("\n"),
    "utf8",
  );
  const deps = { subprocess: fakeSubprocess, env: {} };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/stackup", query: { projectDir: root }, deps });
  assert.equal(got.status, 200);
  const stackup = got.body.stackup;
  assert.equal(stackup.ok, true, stackup.error);
  assert.equal(stackup.copperLayers, 3);
  assert.deepEqual(stackup.traceWidths, [0.25]);
  const fifty = stackup.suggestions.find((item) => item.kind === "microstrip" && item.targetOhm === 50);
  assert.ok(fifty !== undefined && fifty.widthMm > 0);
  // 没有板子：回空报告与可读提示，不是 500。
  fs.rmSync(path.join(dist, "kicad", "board.kicad_pcb"), { force: true });
  const empty = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/stackup", query: { projectDir: root }, deps });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.stackup.ok, false);
  assert.match(String(empty.body.stackup.error), /kicad_pcb|构建|KiCad 工程/u);
  // 缺 projectDir：400。
  const bad = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/stackup", query: {}, deps });
  assert.equal(bad.status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /ecad/bom：读 circuit.json 分组，没价也照样出行（S156）", async () => {
  assert.ok(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/bom"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s156-bom-"));
  const dist = path.join(root, "hardware", "circuit", "dist", "board");
  fs.mkdirSync(path.join(dist, "kicad"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "circuit.json"),
    JSON.stringify([
      { type: "source_component", source_component_id: "s1", name: "R1", ftype: "simple_resistor", display_resistance: "1k", supplier_part_numbers: { jlcpcb: ["C1", "C9"] } },
      { type: "source_component", source_component_id: "s2", name: "R2", ftype: "simple_resistor", display_resistance: "1k", supplier_part_numbers: { jlcpcb: ["C1"] } },
      { type: "cad_component", source_component_id: "s1", model_step_url: "https://kicad-mod-cache.tscircuit.com/Resistor_SMD/R_0402_1005Metric.step" },
      { type: "cad_component", source_component_id: "s2", model_step_url: "https://kicad-mod-cache.tscircuit.com/Resistor_SMD/R_0402_1005Metric.step" },
      { type: "source_component", source_component_id: "s3", name: "J1", ftype: "simple_connector", supplier_part_numbers: { jlcpcb: [] } },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(dist, "kicad", "board.kicad_pcb"), "(kicad_pcb (version 20241229) (layers (0 \"F.Cu\" signal)))", "utf8");
  const deps = { subprocess: fakeSubprocess, env: {} };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/bom", query: { projectDir: root }, deps });
  assert.equal(got.status, 200);
  const bom = got.body.bom;
  assert.equal(bom.ok, true, bom.error);
  assert.equal(bom.componentCount, 3);
  assert.equal(bom.lines.length, 2);
  // 行按首位的位号排序：J1 在 R1 前面（前缀字母序）。
  assert.deepEqual(bom.lines[0].refs, ["J1"]);
  assert.equal(bom.lines[0].value, "connector");
  assert.equal(bom.lines[0].lcsc, "");
  assert.deepEqual(bom.lines[1].refs, ["R1", "R2"]);
  assert.equal(bom.lines[1].qty, 2);
  assert.equal(bom.lines[1].lcsc, "C1");
  assert.deepEqual(bom.lines[1].alternatives, ["C9"]);
  assert.equal(bom.lines[1].footprint, "Resistor_SMD:R_0402_1005Metric");
  assert.equal(bom.missingLcsc, 1);
  assert.equal(bom.partsUsd, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /ecad/pcb：给工程就出板图，层开关与缺板提示都对（S151）", async () => {
  // host 只为 WEB_API_PATHS 里的路径注册 handler：漏登记就 404，绕开 serve 直接测 handleWebApi 是发现不了的。
  assert.ok(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/pcb"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s151-pcb-"));
  const kicad = path.join(root, "hardware", "kicad");
  fs.mkdirSync(kicad, { recursive: true });
  fs.writeFileSync(
    path.join(kicad, "board.kicad_pcb"),
    [
      '(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))',
      '  (gr_line (start 0 0) (end 20 0) (width 0.1) (layer Edge.Cuts))',
      '  (gr_line (start 20 0) (end 20 10) (width 0.1) (layer Edge.Cuts))',
      '  (gr_line (start 20 10) (end 0 10) (width 0.1) (layer Edge.Cuts))',
      '  (gr_line (start 0 10) (end 0 0) (width 0.1) (layer Edge.Cuts))',
      '  (footprint "tscircuit:r0402" (layer F.Cu) (at 10 5 0) (property "Reference" "R1" (at 0 0 0))',
      '    (pad "1" smd rect (at -1 0 0) (size 1 0.6) (layers F.Cu F.Mask)))',
      '  (segment (start 0 0) (end 5 0) (width 0.25) (layer F.Cu) (net 1))',
      '  (segment (start 0 1) (end 5 1) (width 0.25) (layer B.Cu) (net 1)))',
    ].join("\n"),
    "utf8",
  );
  const deps = { subprocess: fakeSubprocess, env: {} };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/pcb", query: { projectDir: root }, deps });
  assert.equal(got.status, 200);
  assert.equal(got.body.pcbView.ok, true, got.body.pcbView.error);
  assert.equal(got.body.pcbView.pads, 1);
  assert.equal(got.body.pcbView.tracks, 2);
  assert.match(got.body.pcbView.svg, /<svg/u);
  // 3D：路由只给几何，客户端自己画（S209）。
  assert.equal(got.body.pcbView.boxes.length, 1);
  assert.equal(got.body.pcbView.boxes[0].ref, "R1");
  // 这颗夹具只有一个焊盘：高度按「脚数 1」估成 1 mm。
  assert.equal(got.body.pcbView.boxes[0].heightMm, 1);
  assert.equal(got.body.pcbView.boxes[0].side, "F");
  assert.equal(got.body.pcbView.boxes[0].estimated, true);
  assert.deepEqual(got.body.pcbView.board3d, { x0: 0, y0: 0, x1: 20, y1: 10, thicknessMm: 1.6 });

  // 高亮（S210）：带 focus 就把该位号的焊盘描边 + 套方框；没命中就不画框。
  const focused = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/pcb", query: { projectDir: root, focus: "R1" }, deps });
  assert.equal(focused.body.pcbView.focus, "R1");
  assert.match(focused.body.pcbView.svg, /d32-pcb-focus/u, "命中高亮要画方框");
  assert.match(focused.body.pcbView.svg, /state-warn-primary/u, "命中焊盘要用强调色描边");
  const notFocused = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/pcb", query: { projectDir: root, focus: "U9" }, deps });
  assert.equal(notFocused.body.pcbView.focus, "U9");
  assert.doesNotMatch(notFocused.body.pcbView.svg, /d32-pcb-focus/u, "没命中就不要画框");

  const hidden = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/pcb", query: { projectDir: root, bottom: "0", refs: "0" }, deps });
  assert.equal(hidden.body.pcbView.ok, true);
  assert.doesNotMatch(hidden.body.pcbView.svg, /state-success-primary/u);

  fs.rmSync(path.join(kicad, "board.kicad_pcb"));
  const none = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/pcb", query: { projectDir: root }, deps });
  assert.equal(none.status, 200);
  assert.equal(none.body.pcbView.ok, false);
  assert.match(none.body.pcbView.error, /KiCad 工程|kicad_pcb/u);

  const noProject = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/pcb", query: {}, deps });
  assert.equal(noProject.status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test("registerWebRoutes：host 的 dispatch 表里真的有板图路由（S151 回归）", () => {
  const registered = [];
  const ctx = {
    inject(_names, fn) {
      fn({
        get(name) {
          if (name === "webServer") return { register: (route) => registered.push(route.path) };
          if (name === "subprocess") return { runCapture: async () => ({ stdout: "", stderr: "", code: 0 }) };
          return undefined;
        },
      });
    },
  };
  registerWebRoutes(ctx);
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/pcb"), true, "少了这条，浏览器只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/bom"), true, "少了这条，BOM 只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/stackup"), true, "少了这条，叠层只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/emc"), true, "少了这条，EMC 只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/power"), true, "少了这条，电源预算只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/brief"), true, "少了这条，需求文档只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/mech"), true, "少了这条，机械只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/parts"), true, "少了这条，器件搜索只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/impedance"), true, "少了这条，阻抗规则只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/netgate"), true, "少了这条，一致性门禁只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/schematic/sync"), true, "少了这条，补封装只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/render3d"), true, "少了这条，3D 预览只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/swap"), true, "少了这条，换封装只会看到 404");
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad/glb"), true, "少了这条，3D 实体拿不到 GLB");
  assert.equal(registered.includes(WEB_API_PREFIX + "/viewer.js"), true, "少了这条，three 视图脚本拿不到");
  // JSON 路由 36 条 + 二进制路由 2 条（GLB 与 viewer.js）。
  assert.equal(registered.length, 39);
  assert.equal(registered.includes(WEB_API_PREFIX + "/ecad"), true);
});

test("GET /ecad/power：电源网络与线宽判据都在报告里，缺工程时 400（S160）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-power-"));
  try {
    const kicad = path.join(dir, "hardware", "kicad");
    fs.mkdirSync(kicad, { recursive: true });
    fs.writeFileSync(
      path.join(kicad, "board.kicad_pcb"),
      [
        "(kicad_pcb (version 20241229) (generator pcbnew)",
        '  (net 0 "")',
        '  (net 1 "GND")',
        '  (net 2 "VBUS")',
        '  (net 3 "V3V3")',
        "  (segment (start 0 0) (end 10 0) (width 0.2) (layer F.Cu) (net 2))",
        "  (segment (start 0 0) (end 10 0) (width 0.3) (layer F.Cu) (net 3))",
        ")",
        "",
      ].join("\n"),
      "utf8",
    );
    const okReply = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/power",
      query: { projectDir: dir },
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(okReply.status, 200);
    const power = okReply.body.power;
    assert.equal(power.ok, true, power.error);
    assert.equal(power.rails.length, 2, "GND 不进电源轨");
    assert.equal(power.rails.find((item) => item.net === "VBUS").ok, false, "0.2 mm 不够 1 A");
    assert.equal(power.rails.find((item) => item.net === "V3V3").assumed, true);
    assert.equal(power.unfilled, 0);

    const badReply = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/power",
      query: {},
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(badReply.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET/POST /ecad/brief：先看三份文档在不在，POST 才写出骨架（S161）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-brief-"));
  try {
    const program = path.join(dir, "program");
    fs.mkdirSync(program, { recursive: true });
    fs.writeFileSync(
      path.join(program, "demo.ioc"),
      [
        "Mcu.CPN=STM32F103C8T6",
        "Mcu.Name=STM32F103C8Tx",
        "Mcu.Package=LQFP48",
        "RCC.APB1Freq_Value=36000000",
        "RCC.APB2Freq_Value=72000000",
        "",
      ].join("\n"),
      "utf8",
    );
    const first = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/brief",
      query: { projectDir: dir },
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(first.status, 200);
    const before = first.body.brief;
    assert.equal(before.ok, true, before.error);
    assert.equal(before.files.length, 3);
    assert.equal(before.files.filter((file) => file.exists).length, 0, "还没生成时三份都该是缺的");
    assert.equal(before.mcu, "STM32F103C8T6");

    const written = await handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/ecad/brief",
      query: { projectDir: dir },
      body: JSON.stringify({ write: true }),
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(written.status, 200);
    assert.equal(written.body.brief.written.length, 3);
    assert.equal(fs.existsSync(path.join(dir, "docs", "01-MRD.md")), true);

    const again = await handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/ecad/brief",
      query: { projectDir: dir },
      body: JSON.stringify({ write: true }),
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(again.body.brief.skipped.length, 3, "已有文件不能再覆盖一次");

    const badReply = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/brief",
      query: {},
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(badReply.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET/POST /ecad/mech：读板框与定位孔，POST 才写 DXF（S162）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mech-"));
  try {
    const kicad = path.join(dir, "hardware", "kicad");
    fs.mkdirSync(kicad, { recursive: true });
    fs.writeFileSync(
      path.join(kicad, "board.kicad_pcb"),
      [
        "(kicad_pcb (version 20241229) (generator pcbnew)",
        '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
        '  (gr_line (start 0 0) (end 20 0) (width 0.1) (layer "Edge.Cuts"))',
        '  (gr_line (start 20 0) (end 20 10) (width 0.1) (layer "Edge.Cuts"))',
        '  (gr_line (start 20 10) (end 0 10) (width 0.1) (layer "Edge.Cuts"))',
        '  (gr_line (start 0 10) (end 0 0) (width 0.1) (layer "Edge.Cuts"))',
        '  (footprint "MountingHole" (layer "F.Cu") (at 2 2)',
        '    (property "Reference" "H1" (at 0 0 0))',
        '    (pad "" np_thru_hole circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask"))',
        "  )",
        ")",
        "",
      ].join("\n"),
      "utf8",
    );
    const read = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/mech",
      query: { projectDir: dir },
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(read.status, 200);
    const mech = read.body.mech;
    assert.equal(mech.ok, true, mech.error);
    assert.equal(mech.widthMm, 20);
    assert.equal(mech.heightMm, 10);
    assert.equal(mech.mountingHoles, 1);
    assert.equal(mech.savedTo, "", "GET 不落盘");
    assert.equal(fs.existsSync(path.join(dir, "mech", "board.dxf")), false);

    const exported = await handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/ecad/mech",
      query: { projectDir: dir },
      body: JSON.stringify({ export: true }),
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.mech.bytes > 0, true);
    assert.equal(fs.existsSync(path.join(dir, "mech", "board.dxf")), true);

    const badReply = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/mech",
      query: {},
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(badReply.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /ecad：共享运行时与工程挂载分开报（S152）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ecad-runtime-"));
  const project = path.join(root, "proj");
  fs.mkdirSync(project, { recursive: true });
  const home = path.join(root, "home");
  const env = { ...process.env, DSH_ECAD_HOME: home };
  const first = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad", query: { projectDir: project }, deps: { subprocess: null, env } });
  assert.equal(first.body.ecad.runtime.ready, false, "运行时目录不存在时不能报就绪");
  assert.equal(first.body.ecad.runtime.bytes, 0);
  assert.equal(first.body.ecad.installed, false);
  const cli = path.join(home, "ecad-runtime", "node_modules", "tscircuit", "cli.mjs");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "// cli\n", "utf8");
  const second = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad", query: { projectDir: project }, deps: { subprocess: null, env } });
  assert.equal(second.body.ecad.runtime.ready, true, "共享运行时存在即就绪，与工程是否挂载无关");
  assert.equal(second.body.ecad.runtime.linked, false, "工程没挂载要如实报 false");
});

test("GET /ecad/ipc：连不上 KiCad 时给人话，不抛（S153）", async () => {
  // 这个用例只验证信封与降级：本机 KiCad 若开着，会拿到 ok:true；没开则必须是带 error 的 ok:false。
  const out = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/ipc", query: {}, deps: { subprocess: null, env: process.env } });
  assert.equal(out.status === 200 || out.status === 400, true);
  const ipc = out.body.ipc;
  assert.equal(typeof ipc.ok, "boolean");
  if (ipc.ok) {
    assert.equal(typeof ipc.boardName, "string");
    assert.equal(ipc.boardName.length > 0, true);
  } else {
    assert.equal(ipc.error.length > 0, true);
    assert.equal(ipc.kind.length > 0, true);
  }
});

test("IPC 输出解析：取最后一行 JSON，忽略 KiCad 的告警（S153）", async () => {
  const { parseIpcOutput } = await import("../lib/engine/ecad/pcb/ipc.js");
  const okly = parseIpcOutput('warning: something\n{"ok":true,"data":{"version":"10.0.7"}}\n');
  assert.equal(okly.ok, true);
  assert.equal(okly.data.version, "10.0.7");
  const failed = parseIpcOutput('{"ok":false,"error":{"kind":"FAILED_PRECONDITION","message":"连不上"}}');
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, "FAILED_PRECONDITION");
  assert.equal(failed.error, "连不上");
  const garbage = parseIpcOutput("no json here");
  assert.equal(garbage.ok, false);
  assert.equal(garbage.kind, "INTERNAL");
});

test("GET /ecad/parts：命中缓存时不联网，空关键词 400（S163）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-parts-"));
  const home = path.join(root, "home");
  try {
    fs.mkdirSync(home, { recursive: true });
    // 预先写一条缓存：10|1|c8734（路由默认 limit=10） —— 请求必须命中它，否则会去联网。
    fs.writeFileSync(
      path.join(home, "part-search.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "10|1|c8734": {
            at: Date.now(),
            total: 7,
            hits: [
              {
                code: "C8734",
                mpn: "STM32F103C8T6",
                brand: "ST",
                packageName: "",
                stock: 6000,
                minBuy: 1,
                priceUsd: 0.9402,
                ladder: [{ qty: 1, priceUsd: 0.9402 }],
                category: "",
                datasheetUrl: "",
                inStock: true,
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const env = { ...process.env, DSH_ECAD_HOME: home };
    const hit = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/parts",
      query: { q: "C8734" },
      deps: { subprocess: fakeSubprocess, env },
    });
    assert.equal(hit.status, 200);
    const parts = hit.body.parts;
    assert.equal(parts.ok, true, parts.error);
    assert.equal(parts.cached, true, "有缓存就不该联网");
    assert.equal(parts.hits.length, 1);
    assert.equal(parts.hits[0].code, "C8734");
    assert.equal(parts.hits[0].priceUsd, 0.9402);
    assert.match(parts.notes.join("；"), /接口没给封装字段/u);

    const empty = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/parts",
      query: {},
      deps: { subprocess: fakeSubprocess, env },
    });
    assert.equal(empty.status, 400);
    assert.match(String(empty.body.error), /q 不能为空/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET /ecad/links：差分对、平面层与去耦距离都在报告里，缺工程时 400（S165）", async () => {
  assert.ok(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/links"));
  assert.ok(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ecad/layout-check"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-links-"));
  const kicad = path.join(root, "hardware", "circuit", "dist", "board", "kicad");
  fs.mkdirSync(kicad, { recursive: true });
  fs.writeFileSync(path.join(kicad, "board.kicad_pcb"), [
    "(kicad_pcb (version 20241229)",
    '  (layers "F.Cu" "In1.Cu" "B.Cu")',
    '  (net 1 "GND")',
    '  (net 2 "V3V3")',
    '  (net 3 "USB_DP")',
    '  (net 4 "USB_DN")',
    '  (footprint "x:u1" (layer "F.Cu") (at 10 10) (property "Reference" "U1")',
    '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net 2 "V3V3"))',
    '    (pad "2" smd rect (at 2 0) (layers "F.Cu") (net 1 "GND")))',
    '  (footprint "x:c1" (layer "F.Cu") (at 11 10) (property "Reference" "C1") (property "Value" "100nF")',
    '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net 2 "V3V3"))',
    '    (pad "2" smd rect (at 1 0) (layers "F.Cu") (net 1 "GND")))',
    '  (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 3))',
    '  (segment (start 0 1) (end 10 1) (width 0.2) (layer "In1.Cu") (net 4))',
    '  (zone (net 1) (layer "In1.Cu") (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10))))',
    "  )",
    "",
  ].join("\n"), "utf8");
  const deps = { subprocess: fakeSubprocess, env: {} };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/links", query: { projectDir: root }, deps });
  assert.equal(got.status, 200);
  const view = got.body.links;
  assert.equal(view.ok, true, view.error);
  assert.equal(view.copperLayers, 3);
  assert.equal(view.pairs.length, 1);
  assert.equal(view.pairs[0].id, "USB");
  assert.equal(view.decaps.length, 1);
  assert.equal(view.decaps[0].ref, "C1");
  const bad = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/links", query: {}, deps });
  assert.equal(bad.status, 400);
});

test("GET /ecad/layout-check：去耦离电源脚远、晶振离主控远都要点名，缺 projectDir 时 400（S203）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-layout-"));
  try {
    const kicad = path.join(root, "hardware", "circuit", "dist", "board", "kicad");
    fs.mkdirSync(kicad, { recursive: true });
    const pads = [];
    for (let index = 1; index <= 8; index += 1) {
      const net = index === 1 ? "V3V3" : "GND";
      pads.push('    (pad "' + String(index) + '" smd rect (at ' + String(index) + ' 0) (layers "F.Cu") (net "' + net + '"))');
    }
    fs.writeFileSync(path.join(kicad, "board.kicad_pcb"), [
      "(kicad_pcb (version 20241229)",
      '  (layers "F.Cu" "B.Cu")',
      '  (gr_line (start 0 0) (end 60 0) (width 0.1) (layer "Edge.Cuts"))',
      '  (gr_line (start 60 0) (end 60 40) (width 0.1) (layer "Edge.Cuts"))',
      '  (gr_line (start 60 40) (end 0 40) (width 0.1) (layer "Edge.Cuts"))',
      '  (gr_line (start 0 40) (end 0 0) (width 0.1) (layer "Edge.Cuts"))',
      '  (footprint "x:u1" (layer "F.Cu") (at 10 10) (property "Reference" "U1") (property "Value" "MCU")',
      ...pads,
      "  )",
      '  (footprint "x:c1" (layer "F.Cu") (at 30 10) (property "Reference" "C1") (property "Value" "100nF")',
      '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net "V3V3"))',
      '    (pad "2" smd rect (at 1 0) (layers "F.Cu") (net "GND")))',
      '  (footprint "x:y1" (layer "F.Cu") (at 45 30) (property "Reference" "Y1") (property "Value" "8MHz")',
      '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net "XTAL_IN"))',
      '    (pad "2" smd rect (at 1 0) (layers "F.Cu") (net "XTAL_OUT")))',
      '  (footprint "x:j1" (layer "F.Cu") (at 30 20) (property "Reference" "J1") (property "Value" "USB")',
      '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net "GND")))',
      "  )",
      "",
    ].join("\n"), "utf8");
    const deps = { subprocess: fakeSubprocess, env: process.env };
    const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/layout-check", query: { projectDir: root }, deps });
    assert.equal(got.status, 200);
    const view = got.body.layoutCheck;
    assert.equal(view.ok, true, view.error);
    assert.equal(view.mcu, "U1");
    const ids = view.findings.map((item) => item.id);
    assert.ok(ids.includes("layout.decap-far"), "去耦电容离电源脚远要点名：" + ids.join(","));
    assert.ok(ids.includes("layout.crystal-far"), "晶振离主控远要点名：" + ids.join(","));
    assert.ok(ids.includes("layout.connector-inside"), "接口没贴边要给提示：" + ids.join(","));
    const bad = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/layout-check", query: {}, deps });
    assert.equal(bad.status, 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET /ecad/render3d：没有 KiCad 工具链就直说，缺 projectDir 时 400（S180）", async () => {
  const deps = { subprocess: fakeSubprocess, env: { ...process.env, DSH_ECAD_BIN_DIRS: "" } };
  const bad = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/render3d", query: {}, deps });
  assert.equal(bad.status, 400);
});

test("GET /ecad/gerber：读导出的 Gerber 与钻孔，没导出时给人话（S166）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-gerber-api-"));
  const deps = { subprocess: fakeSubprocess, env: process.env };
  try {
    const first = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/gerber", query: { projectDir: root }, deps });
    assert.equal(first.status, 200);
    assert.equal(first.body.gerber.ok, false);
    assert.match(String(first.body.gerber.error), /读不到 Gerber|没有 Gerber|ecad_export/u);
    const dir = path.join(root, "hardware", "out", "gerbers");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "b-F_Cu.gtl"), ["%FSLAX46Y46*%", "%MOMM*%", "G01*", "%ADD10C,0.4*%", "D10*", "X0Y0D02*", "X10000000Y0D01*", "M02*"].join("\n"));
    fs.writeFileSync(path.join(dir, "b.drl"), ["M48", "METRIC", "T1C0.400", "%", "G90", "G05", "T1", "X1.0Y-1.0", "M30"].join("\n"));
    const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/gerber", query: { projectDir: root, layers: "F_Cu" }, deps });
    assert.equal(got.status, 200);
    const view = got.body.gerber;
    assert.equal(view.ok, true, view.error);
    assert.equal(view.drillHoles, 1);
    assert.match(view.svg, /<svg/u);
    const bad = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/gerber", query: {}, deps });
    assert.equal(bad.status, 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET/POST /ecad/impedance：GET 只出规则文本，POST 才写进 .kicad_dru（S168）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-imp-route-"));
  try {
    const kicad = path.join(dir, "hardware", "kicad");
    fs.mkdirSync(kicad, { recursive: true });
    fs.writeFileSync(path.join(kicad, "board.kicad_pro"), "{}\n", "utf8");
    fs.writeFileSync(path.join(kicad, "board.kicad_pcb"), [
      "(kicad_pcb (version 20241229)",
      '  (layers "F.Cu" "B.Cu")',
      '  (net 1 "VBUS") (net 2 "GND")',
      '  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1))',
      ")",
      "",
    ].join("\n"), "utf8");

    const dry = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/impedance",
      query: { projectDir: dir, nets: "VBUS" },
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(dry.status, 200);
    const before = dry.body.impedance;
    assert.equal(before.ok, true, before.error);
    assert.equal(before.written, false);
    assert.equal(before.rules.length, 1);
    assert.ok(before.rules[0].includes("阻抗 50Ω 单端 VBUS"));
    assert.equal(fs.existsSync(path.join(kicad, "board.kicad_dru")), false, "GET 不该写盘");

    const written = await handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/ecad/impedance",
      query: { projectDir: dir, nets: "VBUS" },
      body: JSON.stringify({ write: true }),
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(written.status, 200);
    const after = written.body.impedance;
    assert.equal(after.ok, true, after.error);
    assert.equal(after.written, true);
    const dru = fs.readFileSync(path.join(kicad, "board.kicad_dru"), "utf8");
    assert.ok(dru.includes("阻抗 50Ω 单端 VBUS"));
    assert.equal((dru.match(/\(version 1\)/gu) || []).length, 1);

    const missing = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/impedance",
      query: {},
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(missing.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /ecad/netgate：没有板子时给人话，缺 projectDir 时 400（S169）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-gate-route-"));
  try {
    const empty = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/netgate",
      query: { projectDir: dir },
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(empty.status, 200);
    const gate = empty.body.netgate;
    assert.equal(gate.ok, false);
    assert.ok(String(gate.error).length > 0);
    // 手绘层信息跟着回包一起走（S176）：没有手绘层也要显式说没有。
    assert.equal(typeof gate.hand, "object");
    assert.equal(gate.hand.exists, false);
    assert.deepEqual(gate.hand.partsOnlyInHand, []);

    const missing = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/netgate",
      query: {},
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(missing.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET/POST /schematic/edit：指令存盘，GET 读回来，缺端点 400（S170）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-schedit-"));
  try {
    fs.mkdirSync(path.join(dir, "hardware", "circuit"), { recursive: true });
    const saved = await handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/schematic/edit",
      query: { projectDir: dir },
      body: JSON.stringify({ a: { ref: "R1", pin: "1" }, b: { ref: "C1", pin: "2" } }),
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.snippet.edits.length, 1);
    assert.equal(saved.body.snippet.edits[0].op, "connect");
    assert.ok(saved.body.snippet.replay !== undefined, "存完要顺带告诉面板重放结果");
    assert.equal(saved.body.snippet.replay.applied, 0, "没有构建产物时只能存指令");
    assert.ok(saved.body.snippet.replay.notes.some((note) => note.includes("还没有构建产物")));

    const listed = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/schematic/edit",
      query: { projectDir: dir },
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.snippet.edits.length, 1);
    assert.ok(listed.body.snippet.store.endsWith("schematic-edits.json"));

    const bad = await handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/schematic/edit",
      query: { projectDir: dir },
      body: JSON.stringify({ a: { ref: "R1", pin: "1" } }),
      deps: { subprocess: fakeSubprocess, env: process.env },
    });
    assert.equal(bad.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /schematic/sync：没有手绘层就直说先 seed，缺 projectDir 时 400（S177）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-schsync-"));
  try {
    const noProject = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/schematic/sync",
      query: {},
      deps: { subprocess: fakeSubprocess, env: {} },
    });
    assert.equal(noProject.status, 400);

    const missing = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/schematic/sync",
      query: { projectDir: dir },
      deps: { subprocess: fakeSubprocess, env: {} },
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.sync.ok, false);
    assert.match(String(missing.body.sync.error), /手绘层/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET/POST /ecad/swap：缺 ref 与 footprint 时 400，参数齐了没工具链也给人话（S182）", async () => {
  const deps = { subprocess: fakeSubprocess, env: { ...process.env, DSH_ECAD_BIN_DIRS: "" } };
  const noProject = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/swap", query: {}, deps });
  assert.equal(noProject.status, 400);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s182-swap-"));
  try {
    const noRef = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/swap", query: { projectDir: root }, deps });
    assert.equal(noRef.status, 400);
    assert.match(String(noRef.body.error), /ref 不能为空/u);
    const noFootprint = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ecad/swap", query: { projectDir: root, ref: "U1" }, deps });
    assert.equal(noFootprint.status, 400);
    assert.match(String(noFootprint.body.error), /footprint 不能为空/u);
    const noTool = await handleWebApi({
      method: "GET",
      path: WEB_API_PREFIX + "/ecad/swap",
      query: { projectDir: root, ref: "U1", footprint: "Package_QFP:X" },
      deps,
    });
    assert.equal(noTool.status, 200);
    assert.equal(noTool.body.swap.ok, false);
    assert.match(String(noTool.body.swap.error), /KiCad 工具链|还没有可用的 \.kicad_pcb/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
