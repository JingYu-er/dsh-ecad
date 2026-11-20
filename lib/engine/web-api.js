/**
 * 设置面板的宿主 API（Web 端）：浏览器插件 lib/client.js 用 fetch 调这里。
 *
 * 为什么走 HTTP 而不是 ctx.remote：面板只要读配置、跑探测、起安装三件事；
 * typert 的 remote 服务要另加一层协议定义与类型生成，对三个按钮的页面不值。
 * 路由由宿主 webServer 服务注册（与 dsh-market 同一做法），客户端相对 document.baseURI
 * 取路径，所以不论部署在根路径还是子路径都能用。
 *
 * 本文件分两层：
 *  - 纯函数（configSnapshot / saveConfig / probeTools / installPlan / 任务登记）—— 可离线单测；
 *  - handleWebApi 按路径分发，输入输出都是普通对象，不碰 Node 的 IncomingMessage。
 * HTTP 适配在 src/index.ts 里，保持极薄。
 */
import { binDirsFromConfig, configReadingDisabled, cubeMxRootsFromConfig, readToolchainConfig, toolchainConfigPath, updateToolchainConfig, } from "../data/toolchain-config.js";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EVENT_RING_LIMIT, eventSessionKey, eventSnapshot, subscribeEvents, } from "./event-bus.js";
import { evidencePolicy, evidenceRoot, pruneEvidence } from "./event-log.js";
import { readProjectConf, readWorkspaceIndex, scanWorkspaceProjects } from "./project-conf.js";
import { resolveProjectLayout } from "./project-layout.js";
import { applyLayoutFix, planLayoutFix } from "./project-repair.js";
import { runCapture } from "./subprocess-runner.js";
import { backupBoardFile, buildHandSyncScript, parseHandSyncOutput, planHandSync, } from "./ecad/pcb/hand-sync.js";
import { listRunning } from "./progress.js";
import { agentOfSession } from "./session-context.js";
import { readArtifacts } from "./artifacts.js";
import { decodeFault, groupFaults } from "./fault-hints.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { findRootSchematic, readSchematic } from "./schematic/model.js";
import { checkSchematic } from "./schematic/checks.js";
import { findLatestKicadBuild, listCircuitEntries, planEcadWorkspace, runTsciBuild } from "./ecad/tsci.js";
import { exportEmbeddedLibraries } from "./ecad/libs.js";
import { exportStep, runDrc, runErc } from "./ecad/checks.js";
import { checkDfm, writeDru } from "./ecad/dfm.js";
import { exportFabrication } from "./ecad/fabrication.js";
import { packageHardware, verifyPackage } from "./ecad/package.js";
import { locateEcadToolchain } from "./ecad/toolchain.js";
import { locatePoppler } from "./pdf/toolchain.js";
import { popplerDirs } from "../tools/pdf.js";
import { readPcbScene } from "./ecad/pcb/scene.js";
import { copperLayersOf, planeAssignment, runOwnRulePlanes, runOwnRuleRouteWithRetry } from "./ecad/pcb/krt-own.js";
import { routingPreset } from "./ecad/pcb/fab-tier.js";
import { connectPcbIpc } from "./ecad/pcb/ipc.js";
import { renderPcbSvg } from "./ecad/pcb/pcb-svg.js";
import { applyQuotes, readBom } from "./ecad/bom.js";
import { analyzeStackup, DEFAULT_TARGETS } from "./ecad/pcb/stackup.js";
import { analyzeEmc } from "./ecad/pcb/emc.js";
import { readEmcDeep } from "./ecad/pcb/emc-deep.js";
import { readLinks } from "./ecad/pcb/links.js";
import { editStorePath, readSchEdits, replaySchEditsTo, writeSchEdits } from "./schematic/edit.js";
import { readGerberSet } from "./ecad/pcb/gerber.js";
import { EMPTY_RENDER3D, renderBoard3d } from "./ecad/pcb/render3d.js";
import { suggestModelFixes } from "./ecad/pcb/model-fix.js";
import { EMPTY_SWAP, runSwap } from "./ecad/pcb/swap.js";
import { EMPTY_EXPORT3D, exportBoard3d } from "./ecad/pcb/render3d.js";
import { copyFileSync } from "node:fs";
import { analyzePowerBudget } from "./ecad/pcb/power.js";
import { collectBriefFacts, writeBriefs } from "./ecad/brief.js";
import { readImpedancePlan } from "./ecad/pcb/impedance.js";
import { checkNetGate, netGateSummary } from "./ecad/netgate.js";
import { readMech, writeMechDxf } from "./ecad/pcb/mech.js";
import { readCircuitNetlist } from "./ecad/pcb/netlist.js";
import { ensurePrices, priceCachePath, readPriceCache } from "./datasheet/price.js";
import { searchParts, searchCachePath } from "./datasheet/search.js";
import { runEcadDesign } from "./ecad/design.js";
import { readAutoState, writeAutoState } from "./ecad/autobuild.js";
import { ecadRuntimeDir, runtimeBytes, runtimeInstallMode, runtimeReady } from "./ecad/runtime.js";
import { runSchematicReview } from "./schematic/review.js";
import { datasheetStatus, ensureProjectDatasheets } from "./datasheet/auto.js";
import { krtRoot, krtStatus, krtVersion } from "./ecad/pcb/krt.js";
import { cacheBytes, datasheetCacheDir } from "./datasheet/store.js";
import { envValue } from "./env-compat.js";
function envOf(deps) {
    return deps.env ?? process.env;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 只留非空字符串，顺带去重；用于面板传来的目录数组。null 表示不是字符串数组。 */
function stringList(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (typeof item !== "string")
            return null;
        const trimmed = item.trim();
        if (trimmed === "")
            continue;
        if (!out.includes(trimmed))
            out.push(trimmed);
    }
    return out;
}
/** pacman 包名不允许以 - 开头：那会被当成选项，等于把安装变成任意标志注入。 */
function packageList(value) {
    const list = stringList(value);
    if (list === null)
        return { ok: false, packages: [], error: "packages 必须是字符串数组" };
    for (const name of list) {
        if (name.startsWith("-"))
            return { ok: false, packages: [], error: "包名不能以 - 开头：" + name };
        if (/[\s"'|&;<>]/u.test(name))
            return { ok: false, packages: [], error: "包名里有空白或 shell 特殊字符：" + name };
    }
    return { ok: true, packages: list, error: "" };
}
/** 面板打开时读取一次：配置内容，以及据此推导的 binDirs / CubeMX 根。 */
export function configSnapshot(env = process.env) {
    const read = readToolchainConfig(env);
    return {
        ok: read.config !== null,
        path: read.path,
        exists: read.exists,
        readingDisabled: configReadingDisabled(env),
        errors: [...read.errors],
        config: read.config,
        binDirs: binDirsFromConfig(read.config),
        cubeMxRoots: cubeMxRootsFromConfig(read.config),
    };
}
/**
 * 保存面板上改过的字段。
 * 只接受认识的键，每个键都能单独缺省（缺省 = 保留原值），这样前端可以只发 diff。
 */
export function saveConfig(payload, env = process.env) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, error: "请求体必须是 JSON 对象", path: toolchainConfigPath(env), config: null };
    }
    const patch = {};
    for (const key of ["msys64", "cubeMxRoot"]) {
        const value = payload[key];
        if (value === undefined)
            continue;
        if (typeof value !== "string") {
            return { ok: false, error: key + " 必须是字符串", path: toolchainConfigPath(env), config: null };
        }
        patch[key] = value.trim();
    }
    if (payload["binDirs"] !== undefined) {
        const binDirs = stringList(payload["binDirs"]);
        if (binDirs === null) {
            return { ok: false, error: "binDirs 必须是字符串数组", path: toolchainConfigPath(env), config: null };
        }
        patch.binDirs = binDirs;
    }
    if (payload["packages"] !== undefined) {
        const packages = packageList(payload["packages"]);
        if (!packages.ok) {
            return { ok: false, error: packages.error, path: toolchainConfigPath(env), config: null };
        }
        patch.packages = packages.packages;
    }
    if (Object.keys(patch).length === 0) {
        return {
            ok: false,
            error: "没有要保存的字段（msys64 / binDirs / packages / cubeMxRoot）",
            path: toolchainConfigPath(env),
            config: null,
        };
    }
    const written = updateToolchainConfig(patch, env);
    const read = readToolchainConfig(env);
    return { ok: written.ok, error: written.error, path: written.path, config: read.config };
}
/** 在指定目录里找唯一的 .ioc：没有或有多个都算「找不到」（不猜）。 */
function findIocFile(projectDir) {
    if (!existsSync(projectDir))
        return null;
    const names = readdirSync(projectDir).filter((name) => name.toLowerCase().endsWith(".ioc"));
    if (names.length !== 1)
        return null;
    return join(projectDir, names[0]);
}
/* ---------------------------- 分发 ---------------------------- */
export const WEB_API_PREFIX = "/dsh-ecad/api";
/** 工程类接口缺 projectDir 时的统一提示：不再回落到进程工作目录（S84）。 */
const PROJECT_DIR_REQUIRED = "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话";
/**
 * 会话工作目录解析器（S84）：宿主 `workingDirectory` 服务由 `src/index.ts` 注入。
 * 面板没传 projectDir 时先问它，避免把插件进程的 profile 目录当成工程。
 */
let sessionWorkspaceResolver = null;
export function setSessionWorkspaceResolver(resolver) {
    sessionWorkspaceResolver = resolver;
}
/**
 * 请求会话对应的 agent id（S91）：调试会话记的是启动它的 agent id，
 * 面板请求带的是会话 id，两者要对上才允许看／改这条调试会话。
 */
function callerAgentIdOf(sessionId) {
    if (sessionId === "")
        return "";
    const agent = agentOfSession(sessionId);
    if (agent === undefined || agent === null)
        return "";
    return typeof agent.id === "string" ? agent.id : "";
}
/**
 * 调试会话归属判定（S91）：owner 是启动它的 agent id，请求里带的是会话 id。
 * 两边都查得到且不相等才算「别人的」；查不到时不拦，保持老行为。
 */
export function debugSessionForeign(sessionId, owner) {
    if (sessionId === "" || owner === "")
        return false;
    const mine = callerAgentIdOf(sessionId);
    if (mine === "")
        return false;
    return owner !== mine;
}
/** 当前调试会话是否属于另一条会话：是则面板不能把它当成自己的。 */
/** 模块加载时刻：用来判断运行中的进程是不是本次构建后的实例。 */
const PLUGIN_STARTED_AT = Date.now();
/**
 * 插件自检：版本、lib 构建时间、路由数。
 *
 * 面板拿到这三个值就能回答「页面功能是不是已经生效」——路由数是本次注册的数量，
 * 旧进程加载的是旧 lib，路由数与构建时间都会停在重启之前。
 */
function pluginSelfCheck() {
    let version = "";
    let libMtimeMs = 0;
    try {
        const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
        version = String(JSON.parse(text).version ?? "");
    }
    catch {
        version = "";
    }
    try {
        libMtimeMs = statSync(fileURLToPath(import.meta.url)).mtimeMs;
    }
    catch {
        libMtimeMs = 0;
    }
    return { version, libMtimeMs, startedAt: PLUGIN_STARTED_AT, routeCount: WEB_API_PATHS.length };
}
export const WEB_API_PATHS = [
    WEB_API_PREFIX + "/config",
    WEB_API_PREFIX + "/config/save",
    WEB_API_PREFIX + "/events",
    WEB_API_PREFIX + "/status",
    WEB_API_PREFIX + "/toolchain",
    WEB_API_PREFIX + "/faults",
    WEB_API_PREFIX + "/artifacts",
    WEB_API_PREFIX + "/evidence",
    WEB_API_PREFIX + "/replay",
    WEB_API_PREFIX + "/evidence/prune",
    WEB_API_PREFIX + "/channels/start",
    WEB_API_PREFIX + "/watch-recording/start",
    WEB_API_PREFIX + "/projects",
    WEB_API_PREFIX + "/schematic",
    WEB_API_PREFIX + "/schematic/review",
    WEB_API_PREFIX + "/ecad",
    // 板图要单独登记：host 只给 WEB_API_PATHS 里的路径注册 handler，没登记就是 404。
    WEB_API_PREFIX + "/ecad/pcb",
    WEB_API_PREFIX + "/ecad/bom",
    WEB_API_PREFIX + "/ecad/stackup",
    WEB_API_PREFIX + "/ecad/emc",
    WEB_API_PREFIX + "/ecad/links",
    WEB_API_PREFIX + "/ecad/gerber",
    WEB_API_PREFIX + "/ecad/render3d",
    WEB_API_PREFIX + "/ecad/swap",
    WEB_API_PREFIX + "/ecad/power",
    WEB_API_PREFIX + "/ecad/brief",
    WEB_API_PREFIX + "/ecad/impedance",
    WEB_API_PREFIX + "/ecad/netgate",
    WEB_API_PREFIX + "/schematic/edit",
    WEB_API_PREFIX + "/schematic/sync",
    WEB_API_PREFIX + "/ecad/mech",
    // 器件搜索也要单独登记（S163）：GET /ecad/parts?q=… 直接查立创，不依赖工程。
    WEB_API_PREFIX + "/ecad/parts",
    WEB_API_PREFIX + "/ecad/ipc",
    WEB_API_PREFIX + "/ecad/action",
    WEB_API_PREFIX + "/layout",
];
/** 面板要看的库清单：封装按 .pretty 目录数封装，符号按 .kicad_sym 里的符号数。 */
async function scanEcadLibs(libsDir) {
    const footprints = [];
    const symbols = [];
    try {
        for (const name of await readdir(join(libsDir, "footprints"))) {
            if (!name.endsWith(".pretty"))
                continue;
            const files = await readdir(join(libsDir, "footprints", name));
            footprints.push({ lib: name.slice(0, -".pretty".length), count: files.filter((file) => file.endsWith(".kicad_mod")).length });
        }
    }
    catch {
        // 还没导出过库：空列表即正确状态。
    }
    try {
        for (const name of await readdir(join(libsDir, "symbols"))) {
            if (!name.endsWith(".kicad_sym"))
                continue;
            const text = await readFile(join(libsDir, "symbols", name), "utf8");
            const count = (text.match(/\(symbol\s+"/gu) ?? []).length;
            symbols.push({ lib: name.slice(0, -".kicad_sym".length), count: count });
        }
    }
    catch {
        // 同上。
    }
    return { footprints: footprints, symbols: symbols };
}
/** 面板要看的导出产物：out 根目录下的文件 + gerbers 目录里的文件数。 */
async function scanEcadArtifacts(outDir) {
    const artifacts = [];
    try {
        for (const name of await readdir(outDir)) {
            const info = await stat(join(outDir, name));
            if (!info.isFile())
                continue;
            artifacts.push({ name: name, bytes: info.size });
        }
    }
    catch {
        // 还没导出过：空列表即正确状态。
    }
    try {
        const gerbers = await readdir(join(outDir, "gerbers"));
        artifacts.push({ name: "gerbers/（" + String(gerbers.length) + " 个文件）", bytes: 0 });
    }
    catch {
        // 没有 gerbers 目录时不列。
    }
    return artifacts;
}
/** 证据文件最多列这么多条，面板只用来挑一个回放。 */
const EVIDENCE_FILE_LIMIT = 200;
/** 单个证据文件的读取上限：超出说明这个文件不该在面板里打开。 */
const REPLAY_MAX_BYTES = 8 * 1024 * 1024;
/** 一次回放最多载入多少条事件，与环形缓冲同量级。 */
const REPLAY_MAX_EVENTS = 5000;
/** 列证据目录下的 .jsonl，按修改时间倒序；最深到「日期 / 会话 / 文件」这一层。 */
/** 证据文件的分组键：`<日期>/<会话键>/events-….jsonl` 里的会话键。 */
export function evidenceSessionKey(filePath) {
    const parts = filePath.split("/");
    return parts.length >= 3 ? parts[1] ?? "" : "";
}
/**
 * 按会话把证据文件分组（S48）。
 *
 * 目录结构已经是「日期/会话/文件」，列表却把 200 个文件平铺出来，找某个会话
 * 要自己筛。分组只做展示，文件路径仍是唯一标识。
 */
export function groupEvidenceFiles(files) {
    const groups = new Map();
    for (const file of files) {
        const key = evidenceSessionKey(file.path);
        const found = groups.get(key);
        if (found === undefined) {
            groups.set(key, { key, bytes: file.size, latestMs: file.mtimeMs, files: [file] });
            continue;
        }
        found.bytes += file.size;
        found.latestMs = Math.max(found.latestMs, file.mtimeMs);
        found.files.push(file);
    }
    return Array.from(groups.values()).sort((left, right) => right.latestMs - left.latestMs || left.key.localeCompare(right.key));
}
async function listEvidenceFiles(root) {
    const found = [];
    const walk = async (dir, prefix, depth) => {
        if (found.length >= EVIDENCE_FILE_LIMIT || depth > 3)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (found.length >= EVIDENCE_FILE_LIMIT)
                return;
            const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
            if (entry.isDirectory()) {
                await walk(join(dir, entry.name), relative, depth + 1);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".jsonl"))
                continue;
            try {
                const info = await stat(join(dir, entry.name));
                found.push({ path: relative, size: info.size, mtimeMs: info.mtimeMs });
            }
            catch {
                // 单个文件读不到就跳过，不影响其余条目。
            }
        }
    };
    await walk(resolve(root), "", 1);
    found.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return found.slice(0, EVIDENCE_FILE_LIMIT);
}
/** 把相对路径钉在证据目录内：绝对路径、`..` 与非 .jsonl 一律拒绝。 */
function evidenceTarget(root, relative) {
    const trimmed = relative.trim();
    if (trimmed === "" || !trimmed.endsWith(".jsonl"))
        return null;
    const base = resolve(root);
    const target = resolve(base, trimmed);
    if (target === base || !target.startsWith(base + sep))
        return null;
    return target;
}
/** 逐行解析 jsonl，只收形状完整的事件；坏行计入 skipped 不抛。 */
function parseEvidence(text) {
    const events = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed === "")
            continue;
        if (events.length >= REPLAY_MAX_EVENTS) {
            skipped += 1;
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed === null || typeof parsed !== "object") {
                skipped += 1;
                continue;
            }
            const item = parsed;
            if (typeof item["seq"] !== "number" ||
                typeof item["time"] !== "string" ||
                typeof item["kind"] !== "string" ||
                typeof item["status"] !== "string" ||
                typeof item["summary"] !== "string") {
                skipped += 1;
                continue;
            }
            events.push(item);
        }
        catch {
            skipped += 1;
        }
    }
    events.sort((left, right) => left.seq - right.seq);
    return { events, skipped };
}
function ok(body) {
    return { status: 200, body: { ok: true, ...body } };
}
function fail(status, error) {
    return { status, body: { ok: false, error } };
}
function parseJsonBody(text) {
    if (text.trim() === "")
        return { ok: true, value: {}, error: "" };
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { ok: false, value: {}, error: "请求体必须是 JSON 对象" };
        }
        return { ok: true, value: parsed, error: "" };
    }
    catch (error) {
        return { ok: false, value: {}, error: "请求体不是合法 JSON：" + describeError(error) };
    }
}
/**
 * 按路径分发。input.body 是原始文本（适配层读好的），input.query 已解析成普通对象。
 * 未知路径 404、方法不对 405：面板出错时能立刻看出是哪一层的问题。
 */
export async function handleWebApi(input) {
    const method = input.method.toUpperCase();
    const path = input.path.replace(/\/+$/u, "");
    // 请求里的会话 id 决定用哪条会话的工作目录（S91）。缺省或查不到时解析为空串，
    // 由路由回 400 说明缺什么——不回落到「最近一个 agent」或进程工作目录，
    // 否则在别的工作区打开调试台会看到本工作区的工程。
    const requestSession = typeof (input.query ?? {})["session"] === "string"
        ? (input.query ?? {})["session"].trim()
        : "";
    let sessionDir = "";
    if (sessionWorkspaceResolver !== null && requestSession !== "") {
        try {
            sessionDir = (await sessionWorkspaceResolver(requestSession)).trim();
        }
        catch {
            sessionDir = "";
        }
    }
    // 兜底顺序（S91）：显式 projectDir → 本会话工作目录 → 空（由路由回 400）。
    const withProject = (raw) => {
        const trimmed = raw.trim();
        if (trimmed !== "")
            return trimmed;
        return sessionDir;
    };
    /**
     * 程序目录（S95）：工程根可能把程序放在 `program/` 或 `firmware/` 下。
     *
     * 读 `.ioc`、跑构建、烧录都应以程序目录为准；工程根仍用于「选工程」与原理图。
     */
    const firmwareProject = (raw) => {
        const root = withProject(raw);
        if (root === "")
            return "";
        return resolveProjectLayout(root).firmwareDir;
    };
    const query = input.query ?? {};
    const needsBody = path !== WEB_API_PREFIX + "/config" &&
        path !== WEB_API_PREFIX + "/install/state" &&
        path !== WEB_API_PREFIX + "/status" &&
        path !== WEB_API_PREFIX + "/toolchain" &&
        path !== WEB_API_PREFIX + "/debug" &&
        path !== WEB_API_PREFIX + "/channels" &&
        path !== WEB_API_PREFIX + "/pinout" &&
        path !== WEB_API_PREFIX + "/clocks" &&
        path !== WEB_API_PREFIX + "/faults" &&
        path !== WEB_API_PREFIX + "/artifacts" &&
        path !== WEB_API_PREFIX + "/evidence" &&
        path !== WEB_API_PREFIX + "/replay" &&
        path !== WEB_API_PREFIX + "/ioc-diff" &&
        path !== WEB_API_PREFIX + "/ioc-keys" &&
        path !== WEB_API_PREFIX + "/watch-recording" &&
        path !== WEB_API_PREFIX + "/interrupts" &&
        path !== WEB_API_PREFIX + "/ioc-sync" &&
        path !== WEB_API_PREFIX + "/source" &&
        path !== WEB_API_PREFIX + "/probe-info" &&
        path !== WEB_API_PREFIX + "/serial" &&
        path !== WEB_API_PREFIX + "/serial/ports" &&
        path !== WEB_API_PREFIX + "/schematic" &&
        path !== WEB_API_PREFIX + "/ecad" &&
        path !== WEB_API_PREFIX + "/ecad/pcb" &&
        path !== WEB_API_PREFIX + "/ecad/bom" &&
        path !== WEB_API_PREFIX + "/ecad/stackup" &&
        path !== WEB_API_PREFIX + "/ecad/emc" &&
        path !== WEB_API_PREFIX + "/ecad/links" &&
        path !== WEB_API_PREFIX + "/ecad/gerber" &&
        path !== WEB_API_PREFIX + "/ecad/render3d" &&
        path !== WEB_API_PREFIX + "/ecad/swap" &&
        path !== WEB_API_PREFIX + "/ecad/power" &&
        path !== WEB_API_PREFIX + "/ecad/brief" &&
        path !== WEB_API_PREFIX + "/ecad/impedance" &&
        path !== WEB_API_PREFIX + "/ecad/netgate" &&
        path !== WEB_API_PREFIX + "/ecad/mech" &&
        path !== WEB_API_PREFIX + "/ecad/parts" &&
        path !== WEB_API_PREFIX + "/ecad/ipc" &&
        path !== WEB_API_PREFIX + "/projects";
    // /watch 与 /ecad/brief 一个路径两种动词：GET 读、POST 写（改登记表 / 生成文档）。
    if (path === WEB_API_PREFIX + "/watch" || path === WEB_API_PREFIX + "/ecad/brief" || path === WEB_API_PREFIX + "/ecad/mech" || path === WEB_API_PREFIX + "/ecad/impedance" || path === WEB_API_PREFIX + "/schematic/edit" || path === WEB_API_PREFIX + "/schematic/sync") {
        if (method !== "GET" && method !== "POST")
            return fail(405, "这个接口只接受 GET 或 POST");
    }
    else if (needsBody && method !== "POST") {
        return fail(405, "这个接口只接受 POST");
    }
    else if (!needsBody && method !== "GET") {
        return fail(405, "这个接口只接受 GET");
    }
    const twoVerb = (path === WEB_API_PREFIX + "/watch" || path === WEB_API_PREFIX + "/ecad/brief" || path === WEB_API_PREFIX + "/ecad/mech" || path === WEB_API_PREFIX + "/ecad/impedance" || path === WEB_API_PREFIX + "/schematic/edit" || path === WEB_API_PREFIX + "/schematic/sync" || path === WEB_API_PREFIX + "/ecad/swap") && method === "POST";
    const parsed = needsBody || twoVerb ? parseJsonBody(input.body ?? "") : { ok: true, value: {}, error: "" };
    if (!parsed.ok)
        return fail(400, parsed.error);
    const env = envOf(input.deps);
    if (path === WEB_API_PREFIX + "/config") {
        return ok({ snapshot: configSnapshot(env) });
    }
    if (path === WEB_API_PREFIX + "/config/save") {
        const saved = saveConfig(parsed.value, env);
        if (!saved.ok)
            return fail(400, saved.error);
        return ok({ path: saved.path, config: saved.config, snapshot: configSnapshot(env) });
    }
    if (path === WEB_API_PREFIX + "/projects") {
        // 工程选择器（S82）：工作区索引 + 现场扫描合并，附当前工程描述。
        const rootParam = typeof query["root"] === "string" ? query["root"].trim() : "";
        const projectParam = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const workspaceRoot = rootParam !== ""
            ? rootParam
            : (projectParam !== "" ? dirname(resolve(projectParam)) : sessionDir);
        if (workspaceRoot === "") {
            // 没有会话工作目录就没有可列的工作区：宁可空列表，也不猜一个别的工作区（S91）。
            return ok({
                projects: {
                    workspaceRoot: "",
                    confPath: "",
                    hasConf: false,
                    entries: [],
                    current: null,
                    note: "没有可用的会话工作目录：先在这条会话里调用一次 STM32 工具，或从工具栏「工程」下拉里选一个工程",
                },
            });
        }
        const index = readWorkspaceIndex(workspaceRoot);
        const scanned = scanWorkspaceProjects(workspaceRoot);
        const seen = new Set(index.projects.map((item) => item.dir));
        const merged = [...index.projects];
        for (const item of scanned) {
            if (seen.has(item.dir))
                continue;
            seen.add(item.dir);
            merged.push(item);
        }
        const current = projectParam !== "" ? readProjectConf(projectParam) : null;
        return ok({
            projects: {
                workspaceRoot: index.workspaceRoot,
                confPath: index.confPath,
                hasConf: index.exists,
                entries: merged.slice(0, 50),
                current,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/schematic/review") {
        // 原理图一键评审：读图 → 规则检查 → 配置草案，只读不写盘（S135）。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const rootFile = typeof query["rootFile"] === "string" ? query["rootFile"].trim() : "";
        return ok({ review: runSchematicReview({ projectDir, ...(rootFile === "" ? {} : { rootFile }) }) });
    }
    if (path === WEB_API_PREFIX + "/schematic") {
        // 原理图页：读 KiCad 工程，给模块框图与检查结果；只读文件，不碰探针。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const hardwareDir = layout.hardwareDir;
        if (hardwareDir === "") {
            return fail(404, "工程里没有 KiCad 原理图：把 KiCad 工程放到 hardware/ 下，或在 dsh-stm32.conf 里写 hardware=目录名");
        }
        const rootFile = findRootSchematic(hardwareDir);
        if (rootFile === null || rootFile === "")
            return fail(404, `硬件目录里没有 .kicad_sch：${hardwareDir}`);
        let schematic;
        try {
            schematic = readSchematic(rootFile);
        }
        catch (error) {
            return fail(409, `原理图解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const report = schematic.report;
        // PCB 对账跟着工程走：目录里有 .kicad_pcb 就一起对，没有就只查原理图本身。
        const pcbName = (await readdir(hardwareDir)).find((name) => name.endsWith(".kicad_pcb")) ?? "";
        const iocFile = findIocFile(layout.firmwareDir);
        const check = checkSchematic(report, {
            ...(pcbName === "" ? {} : { pcbFile: join(hardwareDir, pcbName) }),
            ...(iocFile === null ? {} : { iocFile }),
        });
        return ok({
            schematic: {
                rootFile: report.rootFile,
                version: report.version,
                generator: report.generator,
                sheets: report.sheets,
                components: report.components.length,
                nets: report.nets.length,
                mcu: report.mcu === null ? null : { ref: report.mcu.ref, value: report.mcu.value, pins: report.mcu.pins },
                pinIndex: report.components.flatMap((component) => component.pins.map((pin) => ({ ref: component.ref, pin: pin.number, name: pin.name, net: pin.net }))),
                diagram: report.diagram,
                warnings: report.warnings,
                findings: check.findings,
                summary: check.summary,
                pcb: check.pcb,
                layout: { projectDir: layout.projectDir, firmwareDir: layout.firmwareDir, hardwareDir: layout.hardwareDir, notes: layout.notes },
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad") {
        // 电路设计页：只报工作区状态（有没有初始化、依赖装没装、最近一次构建、导出的 STEP）。
        // 构建与检查要跑子进程，留在工具里由模型显式触发，面板不替用户做决定。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const installed = existsSync(join(workspace.circuitDir, "node_modules", "tscircuit"));
        const latest = findLatestKicadBuild(workspace);
        const steps = [];
        try {
            const names = await readdir(workspace.outDir);
            for (const name of names) {
                if (!name.toLowerCase().endsWith(".step"))
                    continue;
                const info = await stat(join(workspace.outDir, name));
                steps.push({ name, bytes: info.size, mtimeMs: info.mtimeMs });
            }
        }
        catch {
            // 还没导出过 STEP：空列表就是正确状态。
        }
        steps.sort((left, right) => right.mtimeMs - left.mtimeMs);
        return ok({
            ecad: {
                workspace: {
                    projectDir: workspace.projectDir,
                    root: workspace.root,
                    circuitDir: workspace.circuitDir,
                    kicadDir: workspace.kicadDir,
                    libsDir: workspace.libsDir,
                    outDir: workspace.outDir,
                },
                initialized: existsSync(join(workspace.circuitDir, "package.json")),
                installed,
                entries: listCircuitEntries(workspace.circuitDir),
                latest: latest.ok
                    ? { ok: true, error: "", kicadDir: latest.kicadDir, pcbFile: latest.pcbFile, schematicFile: latest.schematicFile }
                    : { ok: false, error: latest.error, kicadDir: "", pcbFile: "", schematicFile: "" },
                steps: steps.slice(0, 20),
                libs: await scanEcadLibs(workspace.libsDir),
                datasheets: { ...datasheetStatus(projectDir), bytes: cacheBytes(datasheetCacheDir()) },
                // 两个层次分开报：共享运行时是机器级的一份（装一次所有工程共用），
                // installed 只表示"这个工程把它挂上了"，不能用它给共享运行时下结论。
                runtime: (() => {
                    const dir = ecadRuntimeDir(env);
                    const ready = runtimeReady(dir);
                    return { ready, linked: installed, dir, mode: runtimeInstallMode(), bytes: ready ? runtimeBytes(dir) : 0 };
                })(),
                autoBuild: readAutoState(projectDir),
                autoroute: (() => {
                    const root = krtRoot();
                    const status = krtStatus(root);
                    return { ready: status.ok, error: status.ok ? "" : status.error, version: status.ok ? krtVersion(root) : "", root };
                })(),
                artifacts: await scanEcadArtifacts(workspace.outDir),
                layout: { projectDir: layout.projectDir, firmwareDir: layout.firmwareDir, hardwareDir: layout.hardwareDir, notes: layout.notes },
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/ipc") {
        // 面板上的「检查 KiCad」：只报能不能连上编辑器里的板子。真改板子走工具，面板不替用户动手。
        const located = locateEcadToolchain();
        if (located.toolchain === null) {
            return ok({ ipc: { ok: false, kind: "FAILED_PRECONDITION", error: located.error, version: "", boardName: "", footprints: 0, tracks: 0, vias: 0, zones: 0, nets: 0 } });
        }
        // open=1：连不上就替用户把最近一次构建的板子交给 pcbnew 打开，等 IPC 就绪（S154）。
        const autoOpen = query["open"] === "1" || query["open"] === "true";
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        let boardFile = "";
        if (autoOpen && projectDir !== "") {
            const layout = resolveProjectLayout(projectDir);
            const latest = findLatestKicadBuild(planEcadWorkspace(projectDir, layout.hardwareDir));
            if (latest.ok)
                boardFile = latest.pcbFile;
        }
        const connected = await connectPcbIpc({
            subprocess: input.deps.subprocess,
            python: located.toolchain.python,
            kicadRoot: located.toolchain.root,
            env,
            autoOpen,
            boardFile,
        });
        const result = connected.status;
        if (!result.ok) {
            return ok({ ipc: { ok: false, kind: result.kind, error: result.error, version: "", boardName: "", footprints: 0, tracks: 0, vias: 0, zones: 0, nets: 0, opened: connected.opened, notes: connected.notes } });
        }
        const data = result.data;
        const counts = data.board?.counts ?? {};
        return ok({ ipc: {
                ok: true,
                kind: "",
                error: "",
                version: data.version ?? "",
                boardName: data.board?.name ?? "",
                footprints: counts["footprints"] ?? 0,
                tracks: counts["tracks"] ?? 0,
                vias: counts["vias"] ?? 0,
                zones: counts["zones"] ?? 0,
                nets: counts["nets"] ?? 0,
                opened: connected.opened,
                notes: connected.notes,
            } });
    }
    if (path === WEB_API_PREFIX + "/ecad/bom") {
        // BOM 与元件成本（S156）：读 circuit.json 分组，价格只从缓存里取；`prices=1` 才联网补价。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyBom = {
            ok: false,
            error: latest.ok
                ? "还没有 circuit.json：先构建一次电路，再回来看 BOM。"
                : latest.error,
            circuitFile: "",
            lines: [],
            componentCount: 0,
            priced: 0,
            pricedComponents: 0,
            partsUsd: 0,
            missingLcsc: 0,
            notes: [],
        };
        if (!latest.ok || latest.kicadDir === "")
            return ok({ bom: emptyBom });
        const circuitFile = join(dirname(latest.kicadDir), "circuit.json");
        const base = readBom(circuitFile);
        if (!base.ok)
            return ok({ bom: { ...emptyBom, circuitFile, error: base.error } });
        let report = applyQuotes(base, readPriceCache(priceCachePath(envOf(input.deps))).quotes);
        const fetched = [];
        const failed = [];
        if (query["prices"] === "1") {
            const lookup = await ensurePrices(report.lines.map((line) => line.lcsc).filter((code) => code !== ""), { env: envOf(input.deps), signal: input.deps.signal });
            fetched.push(...lookup.fetched);
            failed.push(...lookup.failed);
            report = applyQuotes(base, lookup.quotes);
        }
        return ok({
            bom: {
                ok: true,
                error: "",
                circuitFile,
                lines: report.lines,
                componentCount: report.componentCount,
                priced: report.priced,
                pricedComponents: report.pricedComponents,
                partsUsd: report.partsUsd,
                missingLcsc: report.missingLcsc,
                notes: report.notes.concat(fetched.length > 0 ? ["这次联网取到 " + String(fetched.length) + " 个编号的报价"] : [], failed.length > 0 ? ["有 " + String(failed.length) + " 个编号没取到报价：" + failed.slice(0, 6).join("、")] : []),
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/parts") {
        // 器件搜索（S163）：只读、不依赖工程；结果按查询缓存 24 小时。
        const q = typeof query["q"] === "string" ? query["q"].trim() : "";
        if (q === "")
            return fail(400, "q 不能为空：给型号、参数或立创编号，例如 C8734、0603 100nF");
        const limitRaw = Number(query["limit"] ?? "10");
        const pageRaw = Number(query["page"] ?? "1");
        const packageName = typeof query["package"] === "string" ? query["package"].trim() : "";
        const result = await searchParts(q, {
            ...(packageName === "" ? {} : { package: packageName }),
            limit: Number.isFinite(limitRaw) ? limitRaw : 10,
            page: Number.isFinite(pageRaw) ? pageRaw : 1,
            ...(query["refresh"] === "1" ? { noCache: true } : {}),
            cacheFile: searchCachePath(env),
            ...(input.deps.signal !== undefined ? { signal: input.deps.signal } : {}),
        });
        const notes = [...result.notes];
        if (result.ok && result.hits.length > 0 && result.hits.every((hit) => hit.packageName === "")) {
            notes.push("接口没给封装字段：封装要去商品页或手册确认，别按型号猜。");
        }
        return ok({
            parts: {
                ok: result.ok,
                error: result.error,
                query: result.query,
                keyword: result.keyword,
                packageName: result.packageName,
                total: result.total,
                matched: result.matched,
                unknownPackage: result.unknownPackage,
                mismatched: result.mismatched,
                cached: result.cached,
                hits: result.hits,
                notes,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/mech") {
        // 外壳与机械约束（S162）：GET 出报告；POST {export:true} 才写 DXF。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const workspace = planEcadWorkspace(projectDir, resolveProjectLayout(projectDir).hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyMech = {
            ok: false,
            error: latest.ok ? "还没有构建产物：先跑一次 stm32_ecad_build" : latest.error,
            boardFile: "",
            savedTo: "",
            bytes: 0,
            widthMm: 0,
            heightMm: 0,
            thicknessMm: 0,
            areaCm2: 0,
            outlinePoints: 0,
            holes: [],
            mountingHoles: 0,
            minHoleEdgeMm: 0,
            findings: [],
            notes: [],
        };
        if (!latest.ok || latest.pcbFile === "")
            return ok({ mech: emptyMech });
        const report = readMech(latest.pcbFile, (file) => readFileSync(file, "utf8"));
        if (!report.ok)
            return ok({ mech: { ...emptyMech, boardFile: latest.pcbFile, error: report.error } });
        let savedTo = "";
        let bytes = 0;
        if (method === "POST" && parsed.value.export === true) {
            const target = typeof parsed.value.saveAs === "string" && parsed.value.saveAs !== ""
                ? resolve(projectDir, parsed.value.saveAs)
                : join(projectDir, "mech", "board.dxf");
            bytes = writeMechDxf(target, report);
            savedTo = target;
        }
        return ok({
            mech: {
                ok: true,
                error: "",
                boardFile: report.boardFile,
                savedTo,
                bytes,
                widthMm: report.widthMm,
                heightMm: report.heightMm,
                thicknessMm: report.thicknessMm,
                areaCm2: report.areaCm2,
                outlinePoints: report.outlinePoints,
                holes: report.holes.map((hole) => ({ ...hole })),
                mountingHoles: report.mountingHoles,
                minHoleEdgeMm: report.minHoleEdgeMm,
                findings: report.findings.map((finding) => ({ ...finding })),
                notes: [...report.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/schematic/edit") {
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const store = editStorePath(workspace.circuitDir);
        if (method === "GET") {
            const edits = readSchEdits(store);
            return ok({ snippet: { store, edits } });
        }
        const body = parseJsonBody(input.body ?? "");
        if (!body.ok)
            return fail(400, body.error);
        const mode = typeof body.value["mode"] === "string" ? String(body.value["mode"]) : "add";
        const existing = readSchEdits(store);
        if (mode === "clear") {
            writeSchEdits(store, []);
            return ok({ snippet: { store, edits: [], cleared: true } });
        }
        const a = body.value["a"];
        const b = body.value["b"];
        const textValue = typeof body.value["text"] === "string" ? body.value["text"].trim() : "";
        const aRef = typeof a?.ref === "string" ? a.ref.trim() : "";
        const aPin = typeof a?.pin === "string" ? a.pin.trim() : "";
        if (aRef === "" || aPin === "")
            return fail(400, "a.ref 与 a.pin 都要给");
        const next = [...existing];
        if (textValue !== "") {
            next.push({ op: "label", at: { ref: aRef, pin: aPin }, text: textValue });
        }
        else {
            const bRef = typeof b?.ref === "string" ? b.ref.trim() : "";
            const bPin = typeof b?.pin === "string" ? b.pin.trim() : "";
            if (bRef === "" || bPin === "")
                return fail(400, "connect 需要 a 与 b 两端；只给一端就带 text");
            if (bRef === aRef && bPin === aPin)
                return fail(400, "两端是同一个引脚");
            next.push({ op: "connect", a: { ref: aRef, pin: aPin }, b: { ref: bRef, pin: bPin } });
        }
        writeSchEdits(store, next);
        // 面板上点「连起来」要立刻看见线：重放和工具走同一份实现。
        const latest = findLatestKicadBuild(workspace);
        const replay = replaySchEditsTo(latest.ok ? latest.kicadDir : "", next);
        return ok({
            snippet: {
                store,
                edits: next,
                replay: {
                    applied: replay.applied,
                    skipped: replay.skipped,
                    failed: [...replay.failed],
                    notes: [...replay.notes],
                },
            },
        });
    }
    if (path === WEB_API_PREFIX + "/schematic/sync") {
        // 手绘层新放的器件补到板子（S177）：GET 出计划，POST { apply: true } 才写。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const apply = method === "POST";
        const plan = planHandSync(projectDir, {
            boardFile: typeof query["boardFile"] === "string" ? query["boardFile"] : undefined,
            schematicFile: typeof query["schematicFile"] === "string" ? query["schematicFile"] : undefined,
        });
        if (!plan.ok)
            return ok({ sync: { ok: false, error: plan.error, schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [] } });
        if (!apply) {
            return ok({
                sync: {
                    ok: true,
                    error: "",
                    schematicFile: plan.schematicFile,
                    boardFile: plan.boardFile,
                    parts: plan.parts.map((part) => ({ ref: part.ref, footprint: part.footprint, nets: part.nets.length })),
                    added: 0,
                    skipped: [...plan.alreadyOnBoard],
                    missingLib: [],
                    unassigned: plan.noNet,
                    notes: [...plan.notes],
                },
            });
        }
        const located = locateEcadToolchain(envOf(input.deps));
        if (!located.ok || located.toolchain === null) {
            return ok({ sync: { ok: false, error: "没有找到 KiCad 工具链：补封装要用 KiCad 自带的 python", schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [...plan.notes] } });
        }
        if (plan.parts.length === 0) {
            return ok({ sync: { ok: true, error: "", schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [...plan.alreadyOnBoard], missingLib: [], unassigned: plan.noNet, notes: [...plan.notes, "板上已经有这些位号：没有要补的"] } });
        }
        backupBoardFile(plan.boardFile);
        const stamp = String(Date.now());
        const scriptFile = join(tmpdir(), "dsh-ecad-handsync-" + stamp + ".py");
        const resultFile = join(tmpdir(), "dsh-ecad-handsync-" + stamp + ".json");
        writeFileSync(scriptFile, buildHandSyncScript(plan), "utf8");
        const payload = JSON.stringify({
            boardFile: plan.boardFile,
            libraryDirs: [...plan.libraryDirs, located.toolchain.footprintDir],
            parts: plan.parts.map((part) => ({
                ref: part.ref,
                value: part.value,
                library: part.library,
                footprintName: part.footprintName,
                x: part.x,
                y: part.y,
                nets: part.nets.map((net) => ({ number: net.number, net: net.net })),
            })),
        });
        const run = await runCapture(input.deps.subprocess, {
            argv: [located.toolchain.python, scriptFile, payload, resultFile],
            cwd: dirname(plan.boardFile),
            env: located.toolchain.env,
            timeoutMs: 120_000,
            maxBytes: 256_000,
        });
        if (run.exitCode !== 0) {
            return ok({ sync: { ok: false, error: "KiCad python 执行失败：" + (run.stderr === "" ? run.stdout : run.stderr).slice(-400), schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [] } });
        }
        const parsed = existsSync(resultFile) ? parseHandSyncOutput(readFileSync(resultFile, "utf8")) : null;
        if (parsed === null || !parsed.ok) {
            return ok({ sync: { ok: false, error: "没读到补封装结果：脚本没有写出结果文件", schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [] } });
        }
        return ok({
            sync: {
                ok: true,
                error: "",
                schematicFile: plan.schematicFile,
                boardFile: plan.boardFile,
                parts: plan.parts.map((part) => ({ ref: part.ref, footprint: part.footprint, nets: part.nets.length })),
                added: parsed.added,
                skipped: parsed.skipped,
                missingLib: parsed.missingLib,
                unassigned: parsed.unassigned,
                notes: [...plan.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/netgate") {
        // 网表与板子的一致性门禁（S169）：只读，结论 + 修法一起给。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const report = checkNetGate(projectDir);
        return ok({
            netgate: {
                ok: report.ok,
                error: report.error,
                state: report.state,
                summary: netGateSummary(report),
                staleSeconds: report.staleSeconds,
                schematicFile: report.schematicFile,
                pcbFile: report.pcbFile,
                schematicComponents: report.schematicComponents,
                pcbFootprints: report.pcbFootprints,
                compared: report.compared,
                matched: report.matched,
                split: report.split,
                nameMismatches: report.nameMismatches,
                missingPads: report.missingPads,
                hand: {
                    file: report.hand.file,
                    exists: report.hand.exists,
                    partsOnlyInHand: [...report.hand.partsOnlyInHand],
                    partsOnlyInBuild: [...report.hand.partsOnlyInBuild],
                    pinsChanged: [...report.hand.pinsChanged],
                },
                findings: report.findings.map((finding) => ({ ...finding })),
                notes: [...report.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/impedance") {
        // 阻抗规则写回（S168）：GET 只回规则文本，POST { write: true } 才写进 <工程>.kicad_dru。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyPlan = {
            ok: false,
            error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
            boardFile: "",
            rulesFile: "",
            copperLayers: 0,
            preset: "",
            written: false,
            rules: [],
            suggestions: [],
            notes: [],
        };
        if (!latest.ok || latest.pcbFile === "")
            return ok({ impedance: emptyPlan });
        const singles = typeof query["nets"] === "string" && query["nets"].trim() !== ""
            ? query["nets"].split(",").map((name) => name.trim()).filter((name) => name !== "")
            : [];
        const plan = readImpedancePlan(dirname(latest.pcbFile), latest.pcbFile, {
            singles,
            spacingMm: typeof query["spacing"] === "string" && Number(query["spacing"]) > 0 ? Number(query["spacing"]) : undefined,
            write: method === "POST" && parsed.value.write === true,
        });
        if (!plan.ok)
            return ok({ impedance: { ...emptyPlan, boardFile: plan.boardFile, rulesFile: plan.rulesFile, error: plan.error } });
        return ok({
            impedance: {
                ok: true,
                error: "",
                boardFile: plan.boardFile,
                rulesFile: plan.rulesFile,
                copperLayers: plan.copperLayers,
                preset: plan.presetLabel,
                written: plan.written,
                rules: [...plan.rules],
                suggestions: plan.suggestions.map((item) => ({ ...item, nets: [...item.nets] })),
                notes: [...plan.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/brief") {
        // 需求文档（S161）：GET 看三份文档在不在、多大；POST 才生成骨架（默认不覆盖）。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const docsDir = join(projectDir, "docs");
        const files = ["01-MRD.md", "02-hardware-PRD.md", "03-design-brief.md"].map((name) => {
            const file = join(docsDir, name);
            let bytes = 0;
            let updatedMs = 0;
            try {
                const info = statSync(file);
                bytes = info.size;
                updatedMs = info.mtimeMs;
            }
            catch {
                // 文件不存在：bytes 0 即正确状态。
            }
            return { name, exists: bytes > 0, bytes, updatedMs };
        });
        const facts = collectBriefFacts(projectDir);
        const emptyBrief = {
            ok: false,
            error: facts.ok ? "" : facts.error,
            projectDir,
            docsDir,
            files,
            mcu: "",
            clocks: "",
            peripherals: [],
            notes: [],
            written: [],
            skipped: [],
        };
        if (!facts.ok)
            return ok({ brief: emptyBrief });
        if (method === "POST" && parsed.value.write === true) {
            const force = parsed.value.force === true;
            const result = writeBriefs(projectDir, facts, force);
            if (!result.ok)
                return ok({ brief: { ...emptyBrief, error: result.error } });
            return ok({
                brief: {
                    ok: true,
                    error: "",
                    projectDir,
                    docsDir,
                    files: files.map((file) => {
                        let bytes = file.bytes;
                        try {
                            bytes = statSync(join(docsDir, file.name)).size;
                        }
                        catch {
                            bytes = 0;
                        }
                        return { ...file, exists: bytes > 0, bytes };
                    }),
                    mcu: facts.mcu.cpn,
                    clocks: facts.clocks.sysclkHz === null ? "" : String(Math.round((facts.clocks.sysclkHz / 1_000_000) * 10) / 10) + " MHz",
                    peripherals: [...facts.peripherals],
                    notes: [...facts.notes],
                    written: [...result.written],
                    skipped: [...result.skipped],
                },
            });
        }
        return ok({
            brief: {
                ...emptyBrief,
                ok: true,
                mcu: facts.mcu.cpn,
                clocks: facts.clocks.sysclkHz === null ? "" : String(Math.round((facts.clocks.sysclkHz / 1_000_000) * 10) / 10) + " MHz",
                peripherals: [...facts.peripherals],
                notes: [...facts.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/power") {
        // 功耗与电源树（S160）：只合计用户填的电流，按名字估的另计；线宽判据复用 EMC 的 IPC-2221。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyPower = {
            ok: false,
            error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
            boardFile: "",
            rails: [],
            totalA: 0,
            totalW: 0,
            estimatedA: 0,
            estimatedW: 0,
            inputA: 0,
            inputV: 0,
            efficiency: 0,
            unfilled: 0,
            notes: [],
        };
        if (!latest.ok || latest.pcbFile === "")
            return ok({ power: emptyPower });
        let netlist = null;
        const circuitFile = join(dirname(latest.kicadDir), "circuit.json");
        if (existsSync(circuitFile)) {
            try {
                netlist = readCircuitNetlist(readFileSync(circuitFile, "utf8"));
            }
            catch {
                netlist = null;
            }
        }
        const budget = analyzePowerBudget(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile, netlist);
        if (!budget.ok)
            return ok({ power: { ...emptyPower, boardFile: latest.pcbFile, error: budget.error } });
        return ok({
            power: {
                ok: true,
                error: "",
                boardFile: budget.boardFile,
                rails: budget.rails.map((rail) => ({ ...rail, voltageV: rail.voltageV ?? 0, currentA: rail.currentA ?? 0, known: rail.currentA !== null, ok: rail.ok === true })),
                totalA: budget.totalA,
                totalW: budget.totalW,
                estimatedA: budget.estimatedA,
                estimatedW: budget.estimatedW,
                inputA: budget.inputA,
                inputV: budget.inputV,
                efficiency: budget.efficiency,
                unfilled: budget.unfilled,
                notes: budget.notes,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/links") {
        // 布线进阶体检（S165）：差分对长度差、平面层被信号割裂、去耦电容到负载引脚的距离。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyLinks = {
            ok: false,
            error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
            boardFile: "",
            copperLayers: 0,
            pairs: [],
            decaps: [],
            planes: [],
            findings: [],
            notes: [],
        };
        if (!latest.ok || latest.pcbFile === "")
            return ok({ links: emptyLinks });
        const report = readLinks(latest.pcbFile);
        if (!report.ok)
            return ok({ links: { ...emptyLinks, boardFile: latest.pcbFile, error: report.error } });
        return ok({
            links: {
                ok: true,
                error: "",
                boardFile: report.boardFile,
                copperLayers: report.copperLayers,
                pairs: report.pairs.map((item) => ({ ...item, notes: [...item.notes] })),
                decaps: report.decaps.map((item) => ({ ...item })),
                planes: report.planes.map((item) => ({ ...item, planeNets: [...item.planeNets], signalNets: [...item.signalNets] })),
                findings: report.findings.map((item) => ({ ...item })),
                notes: [...report.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/swap") {
        // 换封装（S182）：GET 预演，POST { ref, footprint } 才写进板子（写前留 .bak）。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const ref = typeof query["ref"] === "string" && query["ref"].trim() !== "" ? query["ref"].trim() : (typeof parsed.value.ref === "string" ? parsed.value.ref.trim() : "");
        const footprint = typeof query["footprint"] === "string" && query["footprint"].trim() !== "" ? query["footprint"].trim() : (typeof parsed.value.footprint === "string" ? parsed.value.footprint.trim() : "");
        if (ref === "")
            return fail(400, "ref 不能为空：给要换的位号，例如 U1");
        if (footprint === "")
            return fail(400, "footprint 不能为空：写成 Lib:Name，例如 Package_QFP:LQFP-48_7x7mm_P0.5mm");
        const located = locateEcadToolchain(envOf(input.deps));
        if (!located.ok || located.toolchain === null)
            return ok({ swap: { ...EMPTY_SWAP, ref, to: footprint, error: "找不到 KiCad 工具链：" + located.error } });
        const latest = findLatestKicadBuild(planEcadWorkspace(projectDir, resolveProjectLayout(projectDir).hardwareDir));
        if (!latest.ok || latest.pcbFile === "") {
            return ok({ swap: { ...EMPTY_SWAP, ref, to: footprint, error: "还没有可用的 .kicad_pcb：先跑一次 stm32_ecad_build" } });
        }
        if (located.toolchain.footprintDir === "") {
            return ok({ swap: { ...EMPTY_SWAP, ref, to: footprint, error: "没有找到 KiCad 封装库目录：检查 KiCad 安装" } });
        }
        const apply = method === "POST" && (parsed.value.apply === true || parsed.value.apply === undefined);
        if (apply)
            copyFileSync(latest.pcbFile, latest.pcbFile + ".bak");
        const result = await runSwap({ python: located.toolchain.python, subprocess: input.deps.subprocess, timeoutMs: 150_000 }, { boardFile: latest.pcbFile, ref, footprint, footprintDir: located.toolchain.footprintDir, apply });
        return ok({ swap: { ...result, lost: [...result.lost], notes: [...result.notes] } });
    }
    if (path === WEB_API_PREFIX + "/ecad/render3d") {
        // 3D 预览（S180）：交给 KiCad 的 `pcb render`，顺手报出哪些封装的 3D 模型缺文件。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const base = { ...EMPTY_RENDER3D, dataUrl: "" };
        const located = locateEcadToolchain(envOf(input.deps));
        if (!located.ok || located.toolchain === null) {
            return ok({ render3d: { ...base, error: "找不到 KiCad 工具链：" + located.error, models: [], missing: [], notes: [] } });
        }
        const latest = findLatestKicadBuild(planEcadWorkspace(projectDir, resolveProjectLayout(projectDir).hardwareDir));
        if (latest === null || latest.pcbFile === "") {
            return ok({ render3d: { ...base, error: "还没有可用的 .kicad_pcb：先跑一次 stm32_ecad_build，或在 KiCad 里存一次板子", models: [], missing: [], notes: [] } });
        }
        const formatParam = query["format"] === "glb" || query["format"] === "step" ? query["format"] : "";
        if (formatParam !== "") {
            const exported = await exportBoard3d({
                kicadCli: located.toolchain.kicadCli,
                model3dDir: located.toolchain.model3dDir,
                run: async (argv, timeoutMs) => {
                    const outcome = await runCapture(input.deps.subprocess, { argv: [...argv], cwd: dirname(latest.pcbFile), timeoutMs });
                    return { exitCode: outcome.exitCode ?? 1, stdout: outcome.stdout, stderr: outcome.stderr };
                },
            }, latest.pcbFile, {
                format: formatParam,
                output: join(projectDir, "hardware", "out", "board." + formatParam),
                ...(query["substModels"] === "1" ? { substModels: true } : {}),
                ...(query["boardOnly"] === "1" ? { boardOnly: true } : {}),
                ...(query["includeTracks"] === "1" ? { includeTracks: true } : {}),
                ...(query["includePads"] === "1" ? { includePads: true } : {}),
            });
            return ok({
                render3d: {
                    ...EMPTY_RENDER3D,
                    ...EMPTY_EXPORT3D,
                    ok: exported.ok,
                    error: exported.error,
                    file: exported.file,
                    bytes: exported.bytes,
                    side: formatParam,
                    dataUrl: "",
                    models: [],
                    missing: [...exported.missing],
                    fixes: [],
                    notes: [...exported.notes],
                },
            });
        }
        const sideParam = typeof query["side"] === "string" && query["side"].trim() !== "" ? query["side"].trim() : "top";
        const side = ["top", "bottom", "left", "right", "front", "back"].includes(sideParam) ? sideParam : "top";
        const rotateParam = typeof query["rotate"] === "string" && query["rotate"].trim() !== "" ? query["rotate"].trim() : "";
        const result = await renderBoard3d({
            kicadCli: located.toolchain.kicadCli,
            model3dDir: located.toolchain.model3dDir,
            run: async (argv, timeoutMs) => {
                const outcome = await runCapture(input.deps.subprocess, { argv: [...argv], cwd: dirname(latest.pcbFile), timeoutMs });
                return { exitCode: outcome.exitCode ?? 1, stdout: outcome.stdout, stderr: outcome.stderr };
            },
        }, latest.pcbFile, {
            side: side,
            ...(rotateParam === "" ? {} : { rotate: rotateParam }),
            ...(query["perspective"] === "1" ? { perspective: true } : {}),
            width: 1200,
            height: 900,
            output: join(projectDir, "hardware", "out", "board-3d-" + side + ".png"),
        });
        const fixes = result.missing.length > 0 && located.toolchain.footprintDir !== ""
            ? suggestModelFixes(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile, { model3dDir: located.toolchain.model3dDir, footprintDir: located.toolchain.footprintDir })
            : [];
        let dataUrl = "";
        const notes = [...result.notes];
        if (result.ok && result.bytes > 0 && result.bytes <= 1_500_000) {
            dataUrl = "data:image/png;base64," + readFileSync(result.file).toString("base64");
        }
        else if (result.ok && result.bytes > 1_500_000) {
            notes.push("图片 " + String(Math.round(result.bytes / 1024)) + " KB，超过 1.5 MB 没有内嵌；直接打开文件看。");
        }
        return ok({
            render3d: {
                ok: result.ok,
                error: result.error,
                file: result.file,
                bytes: result.bytes,
                side: result.side,
                width: result.width,
                height: result.height,
                dataUrl,
                models: result.models.map((model) => ({ ...model })),
                missing: [...result.missing],
                fixes: fixes.map((fix) => ({ ...fix, candidates: fix.candidates.map((candidate) => ({ ...candidate })) })),
                notes,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/gerber") {
        // 制造文件回看（S166）：把导出的 Gerber 与钻孔读回来画成一张图，交付前核对板框、铜、丝印与孔位。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layersParam = typeof query["layers"] === "string" && query["layers"].trim() !== "" ? query["layers"].split(",").map((item) => item.trim()).filter((item) => item !== "") : [];
        const dir = join(projectDir, "hardware", "out", "gerbers");
        const view = readGerberSet(dir, { ...(layersParam.length > 0 ? { layers: layersParam } : {}) });
        if (!view.ok) {
            return ok({
                gerber: {
                    ok: false,
                    error: view.error,
                    dir,
                    svg: "",
                    widthMm: 0,
                    heightMm: 0,
                    drillHoles: 0,
                    layers: [],
                    notes: [],
                },
            });
        }
        return ok({
            gerber: {
                ok: true,
                error: "",
                dir: view.dir,
                svg: view.svg,
                widthMm: view.widthMm,
                heightMm: view.heightMm,
                drillHoles: view.drillHoles,
                layers: view.layers.map((item) => ({ ...item })),
                notes: [...view.notes],
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/emc") {
        // EMC 与热（S158）：电源线载流、铺铜与参考平面、换层过孔回流；不做磁场仿真。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyEmc = {
            ok: false,
            error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
            boardFile: "",
            copperLayers: 0,
            nets: 0,
            zonesByLayer: {},
            powerTraces: [],
            findings: [],
            notes: [],
            deep: { pairs: [], returnPaths: [], crosstalk: [], findings: [], notes: [] },
        };
        if (!latest.ok || latest.pcbFile === "")
            return ok({ emc: emptyEmc });
        const report = analyzeEmc(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile);
        if (!report.ok)
            return ok({ emc: { ...emptyEmc, boardFile: latest.pcbFile, error: report.error } });
        // 深度体检（S167）：差分对间距、回流路径覆盖、并行串扰——数不出来就说数不出来，不编。
        const deepReport = readEmcDeep(latest.pcbFile, (file) => readFileSync(file, "utf8"));
        return ok({
            emc: {
                ok: true,
                error: "",
                boardFile: report.boardFile,
                copperLayers: report.copperLayers,
                nets: report.nets,
                zonesByLayer: report.zonesByLayer,
                powerTraces: report.powerTraces,
                findings: [...report.findings, ...deepReport.findings],
                notes: [...report.notes, ...deepReport.notes],
                deep: {
                    pairs: deepReport.pairs,
                    returnPaths: deepReport.returnPaths,
                    crosstalk: deepReport.crosstalk,
                    findings: deepReport.findings,
                    notes: deepReport.notes,
                },
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/stackup") {
        // 叠层与阻抗（S157）：板子里没有 stackup 段就按层数取嘉立创常规叠层，再给 50/90/100 Ω 的线宽。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const emptyStackup = {
            ok: false,
            error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
            boardFile: "",
            copperLayers: 0,
            preset: "",
            traceWidths: [],
            suggestions: [],
            notes: [],
        };
        if (!latest.ok || latest.pcbFile === "")
            return ok({ stackup: emptyStackup });
        const spacing = Number(query["spacing"]);
        const spacingMm = Number.isFinite(spacing) && spacing > 0 ? spacing : 0.2;
        const analysis = analyzeStackup(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile, spacingMm, DEFAULT_TARGETS);
        if (!analysis.ok)
            return ok({ stackup: { ...emptyStackup, boardFile: latest.pcbFile, error: analysis.error } });
        return ok({
            stackup: {
                ok: true,
                error: "",
                boardFile: analysis.boardFile,
                copperLayers: analysis.copperLayers,
                preset: analysis.preset.label,
                traceWidths: analysis.traceWidths,
                suggestions: analysis.suggestions,
                notes: analysis.notes,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/ecad/pcb") {
        // 板图预览（S151）：只读 .kicad_pcb 出 SVG。不改板、不跑子进程，板子打不开时回可读错误。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const latest = findLatestKicadBuild(workspace);
        const board = latest.ok ? latest.pcbFile : "";
        const emptyPcbView = {
            ok: false,
            error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
            file: "",
            copperLayers: 0,
            svg: "",
            width: 0,
            height: 0,
            widthMm: 0,
            heightMm: 0,
            pads: 0,
            tracks: 0,
            innerTracks: 0,
            vias: 0,
            elements: 0,
            notes: [],
        };
        if (board === "")
            return ok({ pcbView: emptyPcbView });
        const scene = readPcbScene(board);
        if (!scene.ok)
            return ok({ pcbView: { ...emptyPcbView, error: scene.error } });
        // 查询参数按“关掉哪一层”读：默认全开，传 0 才隐藏；位号默认关（排布密集时压线）。
        const flagOf = (name) => query[name] !== "0";
        const rendered = renderPcbSvg(scene, {
            show: {
                top: flagOf("top"),
                bottom: flagOf("bottom"),
                pads: flagOf("pads"),
                vias: flagOf("vias"),
                silk: flagOf("silk"),
                edge: flagOf("edge"),
                zones: flagOf("zones"),
                refs: query["refs"] === "1",
            },
        });
        return ok({
            pcbView: {
                ok: rendered.ok,
                error: rendered.error,
                file: board,
                copperLayers: scene.copperLayers,
                svg: rendered.svg,
                width: rendered.width,
                height: rendered.height,
                widthMm: rendered.widthMm,
                heightMm: rendered.heightMm,
                pads: rendered.pads,
                tracks: rendered.tracks,
                innerTracks: scene.innerTracks,
                vias: rendered.vias,
                elements: rendered.elements,
                notes: scene.notes,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/layout") {
        // 工程结构与配置文件归位（S128）：GET 只规划，POST 才动文件。
        const requested = typeof parsed.value.workspaceRoot === "string" ? parsed.value.workspaceRoot.trim() : "";
        const workspaceRoot = requested === "" ? withProject("") : resolve(requested);
        if (workspaceRoot === "")
            return ok({ layoutFix: { ok: false, error: PROJECT_DIR_REQUIRED, workspaceRoot: "", actions: [], notes: [] } });
        if (input.method !== "POST") {
            const plan = planLayoutFix(workspaceRoot);
            return ok({ layoutFix: { ok: plan.ok, error: plan.error, workspaceRoot: plan.workspaceRoot, actions: plan.actions, notes: plan.notes } });
        }
        const fixed = applyLayoutFix(workspaceRoot);
        return ok({ layoutFix: { ok: fixed.ok, error: fixed.error, workspaceRoot: fixed.workspaceRoot, actions: fixed.actions, notes: fixed.notes } });
    }
    if (path === WEB_API_PREFIX + "/ecad/action") {
        // 面板上的八个动作：都对应一个工具在做的事，只是不必让用户去对话里敲一遍。
        // 面板上的六个动作：都对应一个工具在做的事，只是不必让用户去对话里敲一遍。
        // 构建与检查要几十秒，面板在请求返回前只显示「执行中」，不做乐观更新。
        const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
        const projectDir = withProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const action = typeof parsed.value.action === "string" ? parsed.value.action : "";
        if (!["build", "check", "libs", "step", "export", "package", "datasheets", "design", "route-own"].includes(action)) {
            return fail(400, "action 只能是 build / check / libs / step / export / package / datasheets / design / route-own");
        }
        const layout = resolveProjectLayout(projectDir);
        const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
        const started = Date.now();
        // 自有规则布线（S195）：不走 autoroute.py 的 floor 路线，显式给线宽/间距/电源网。
        if (action === "route-own") {
            const located = locateEcadToolchain();
            if (located.toolchain === null)
                return fail(409, located.error);
            const routeRoot = krtRoot();
            const status = krtStatus(routeRoot);
            if (!status.ok)
                return fail(409, status.error + "（可用 DSH_ECAD_KRT_ROOT 指定目录）");
            const latest = findLatestKicadBuild(workspace);
            const board = latest.ok ? latest.pcbFile : "";
            if (board === "" || !existsSync(board))
                return fail(409, "还没有可用的 .kicad_pcb：先构建一次");
            const preset = routingPreset(copperLayersOf(readFileSync(board, "utf8")));
            const nets = Array.isArray(parsed.value.nets) ? parsed.value.nets.filter((item) => typeof item === "string") : [];
            let routeInput = board;
            const planeNotes = [];
            if (preset.layers >= 4) {
                // 内层分配按焊盘数决定：地固定 In1，电源取焊盘最多的那个（S199）。
                const assignment = planeAssignment(readFileSync(board, "utf8"), preset.layers);
                const planes = await runOwnRulePlanes({
                    subprocess: input.deps.subprocess,
                    runtime: { root: routeRoot, python: located.toolchain.python },
                    inputPcb: board,
                    outputPcb: board.replace(/\.kicad_pcb$/u, ".own-plane.kicad_pcb"),
                    options: {
                        trackWidthMm: preset.signalWidthMm,
                        clearanceMm: preset.signalClearanceMm,
                        powerNets: ["*GND*", "*VCC*", "*VDD*", "*3V3*", "*5V*", "*VBUS*", "*VBAT*"],
                        powerWidthMm: preset.powerWidthMm,
                        viaSizeMm: preset.viaDiameterMm,
                        viaDrillMm: preset.viaDrillMm,
                    },
                    planeNets: assignment.nets.length > 0 ? assignment.nets : ["GND"],
                    planeLayers: assignment.layers.length > 0 ? assignment.layers : ["In1.Cu"],
                    signal: input.deps.signal,
                });
                if (planes.ok) {
                    routeInput = planes.output;
                    planeNotes.push("平面：" + planes.zones.map((zone) => zone.net + "→" + zone.layer).join("、"));
                }
                else {
                    planeNotes.push("平面没铺成，退回全外层布线：" + planes.error);
                }
            }
            const own = await runOwnRuleRouteWithRetry({
                subprocess: input.deps.subprocess,
                runtime: { root: routeRoot, python: located.toolchain.python },
                inputPcb: routeInput,
                outputPcb: board.replace(/\.kicad_pcb$/u, ".own.kicad_pcb"),
                options: {
                    trackWidthMm: preset.signalWidthMm,
                    clearanceMm: preset.signalClearanceMm,
                    powerNets: ["*GND*", "*VCC*", "*VDD*", "*3V3*", "*5V*", "*VBUS*", "*VBAT*"],
                    powerWidthMm: preset.powerWidthMm,
                    layers: ["F.Cu", "B.Cu"],
                    ordering: "mps",
                    viaSizeMm: preset.viaDiameterMm,
                    viaDrillMm: preset.viaDrillMm,
                    maxRipup: 5,
                    boardEdgeClearanceMm: 0.3,
                    neckdownMm: 0.8,
                    nets,
                },
                signal: input.deps.signal,
            });
            const summary = own.summary;
            return ok({
                ecadAction: {
                    action,
                    ok: own.ok,
                    error: own.error,
                    durationMs: Date.now() - started,
                    steps: [
                        { tag: "route.py", what: "自有规则布线：" + String(preset.signalWidthMm) + " mm 线宽 / " + String(preset.signalClearanceMm) + " mm 间距", why: own.ok ? "完成" : own.error, optional: false },
                    ],
                    notes: [
                        ...planeNotes,
                        "布通 " + String((summary.routed_single ?? []).length) + " 个网络，未布通 " + String((summary.failed_single ?? []).length) + " 个",
                        own.ok ? "输出：" + own.output : "未产出板子",
                        typeof summary.min_clearance_used === "number" && summary.min_clearance_used < preset.signalClearanceMm
                            ? "引擎有一次降档：实际最小间距 " + String(summary.min_clearance_used) + " mm（局部挤不下时按工艺下限走）"
                            : "",
                        Object.keys(own.widths).length > 0
                            ? "线宽分布：" + Object.entries(own.widths).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 4).map(([width, count]) => width + " × " + String(count)).join("、")
                            : "",
                        own.thinRatio > 0 ? "细段（焊盘出口 tap）占 " + String(Math.round(own.thinRatio * 100)) + "%，共 " + String(own.segments) + " 段" : "",
                        own.retried.length > 0 ? "第一轮没布通 " + String(own.retried.length) + " 个网，已补第二轮：" + own.retried.join("、") : "",
                        "要写回原板：stm32_pcb_autoroute 传 strategy=own + apply=true（面板这里只产出 <板名>.own.kicad_pcb）",
                    ].filter((item) => item !== ""),
                    file: own.output,
                    bytes: 0,
                    files: (summary.routed_single ?? []).length,
                    skipped: (summary.failed_single ?? []).length,
                },
            });
        }
        // 一键设计：构建 → 合并焊盘 → 导库 → ERC/DRC → 可制造性 → 制造文件（S134）。
        if (action === "design") {
            const located = locateEcadToolchain();
            if (located.toolchain === null)
                return fail(409, located.error);
            const result = await runEcadDesign({
                subprocess: input.deps.subprocess,
                toolchain: located.toolchain,
                workspace,
                mergePads: parsed.value.mergePads !== false,
                pcb: parsed.value.pcb === true,
                artifacts: parsed.value.artifacts !== false,
            });
            return ok({
                ecadAction: {
                    action,
                    ok: result.ok,
                    error: result.error,
                    durationMs: Date.now() - started,
                    steps: [...result.steps],
                    notes: [...result.notes],
                    file: "",
                    bytes: 0,
                    files: 0,
                    skipped: 0,
                },
            });
        }
        // 补手册只读 circuit 源码与网络，不需要 KiCad：放在工具链探测之前（S120）。
        if (action === "datasheets") {
            const ds = await ensureProjectDatasheets(projectDir, {
                offline: (envOf(input.deps)["DSH_ECAD_OFFLINE"] ?? "").trim() === "1",
            });
            const notes = [
                "本工程 " + String(ds.codes.length) + " 个立创器件",
                "缓存命中 " + String(ds.cached) + " 个，新抓 " + String(ds.fetched.length) + " 个，失败 " + String(ds.failed.length) + " 个",
                ...ds.failed.map((item) => item.code + "：" + item.error),
            ];
            return ok({
                ecadAction: {
                    action: action,
                    ok: ds.failed.length === 0,
                    error: ds.failed.length === 0 ? "" : "有 " + String(ds.failed.length) + " 个器件未完成",
                    durationMs: Date.now() - started,
                    file: "",
                    bytes: 0,
                    files: ds.fetched.length,
                    skipped: ds.cached,
                    notes,
                },
            });
        }
        // 打包只读 hardware/ 目录，不需要 KiCad 与 tscircuit：先处理，免得没装工具链的机器连包都打不了。
        if (action === "package") {
            const packed = packageHardware(workspace.root, basename(projectDir));
            const check = packed.ok ? verifyPackage(packed.file) : { ok: false, error: packed.error, files: 0 };
            return ok({
                ecadAction: {
                    action: action,
                    ok: packed.ok && check.ok,
                    error: packed.ok ? check.error : packed.error,
                    durationMs: Date.now() - started,
                    file: packed.file,
                    bytes: packed.bytes,
                    files: packed.files,
                    skipped: packed.skipped,
                    notes: packed.notes,
                },
            });
        }
        const located = locateEcadToolchain(envOf(input.deps));
        if (located.toolchain === null)
            return fail(409, located.error);
        const latestForCheck = () => findLatestKicadBuild(workspace);
        const runLibs = async (pcbFile, schFile) => {
            const libs = exportEmbeddedLibraries(workspace, pcbFile, schFile);
            return {
                ok: libs.ok,
                error: libs.error,
                footprints: libs.footprintLibs.map((item) => ({ lib: item.lib, count: item.count })),
                symbols: libs.symbolLibs.map((item) => ({ lib: item.lib, count: item.count })),
            };
        };
        if (action === "build") {
            const build = await runTsciBuild({ subprocess: input.deps.subprocess, toolchain: located.toolchain, workspace, svgs: true });
            const latest = latestForCheck();
            return ok({
                ecadAction: {
                    action: action,
                    ok: build.ok,
                    error: build.error,
                    durationMs: Date.now() - started,
                    kicadDir: latest.ok ? latest.kicadDir : "",
                    notes: build.notes,
                },
            });
        }
        const latest = latestForCheck();
        if (!latest.ok)
            return fail(409, latest.error);
        if (action === "libs") {
            const libs = await runLibs(latest.pcbFile, latest.schematicFile);
            return ok({ ecadAction: { action: action, ok: libs.ok, error: libs.error, durationMs: Date.now() - started, libs: libs, notes: [] } });
        }
        if (action === "check") {
            const libs = await runLibs(latest.pcbFile, latest.schematicFile);
            const [erc, drc] = await Promise.all([
                runErc(input.deps.subprocess, located.toolchain, latest.schematicFile),
                runDrc(input.deps.subprocess, located.toolchain, latest.pcbFile),
            ]);
            const findings = [...(erc.summary.findings ?? []), ...(drc.summary.findings ?? [])];
            const dru = writeDru(latest.kicadDir);
            const dfm = checkDfm(readFileSync(latest.pcbFile, "utf8"));
            return ok({
                ecadAction: {
                    action: action,
                    ok: erc.ok && drc.ok && dfm.ok,
                    error: erc.ok ? drc.error : erc.error,
                    durationMs: Date.now() - started,
                    summary: { errors: erc.summary.errors + drc.summary.errors, warnings: erc.summary.warnings + drc.summary.warnings },
                    findings: findings.slice(0, 40),
                    libs: libs,
                    dfm: {
                        ok: dfm.ok,
                        widthMm: dfm.facts.widthMm,
                        heightMm: dfm.facts.heightMm,
                        layers: dfm.facts.layers,
                        minTrackMm: dfm.facts.minTrackMm,
                        minDrillMm: dfm.facts.minDrillMm,
                        approxCny: dfm.cost.approxCny,
                        basis: [...dfm.cost.basis],
                        surcharges: [...dfm.cost.surcharges],
                        findings: dfm.findings.slice(0, 20).map((finding) => ({ ...finding })),
                        druFile: dru.file,
                    },
                    notes: dru.ok ? [] : [`设计规则没写进工程：${dru.error}`],
                },
            });
        }
        if (action === "step") {
            const out = join(workspace.outDir, "board.step");
            const step = await exportStep(input.deps.subprocess, located.toolchain, latest.pcbFile, out, undefined, { libsDir: workspace.libsDir });
            return ok({
                ecadAction: {
                    action: action,
                    ok: step.ok,
                    error: step.error,
                    durationMs: Date.now() - started,
                    artifacts: step.ok ? [{ name: "board.step", bytes: step.bytes }] : [],
                    notes: step.missingModels.length > 0 ? ["缺 3D 模型：" + step.missingModels.slice(0, 4).join("、")] : [],
                },
            });
        }
        const fabricated = await exportFabrication(input.deps.subprocess, located.toolchain, latest.pcbFile, workspace.outDir, input.deps.signal, {
            bundle: parsed.value.bundle === true,
        });
        // 导出成功即清掉「待导出」标记：面板不再提示，避免重复追问（S137）。
        if (fabricated.ok) {
            const previous = readAutoState(projectDir);
            if (previous !== null && previous.pendingExport) {
                writeAutoState(projectDir, { ...previous, pendingExport: false });
            }
        }
        const artifacts = [
            ...fabricated.gerbers.map((item) => ({ name: "gerbers/" + item.name, bytes: item.bytes })),
            ...fabricated.drillFiles.map((item) => ({ name: "drill/" + item.name, bytes: item.bytes })),
        ];
        if (fabricated.stepBytes > 0)
            artifacts.push({ name: "board.step", bytes: fabricated.stepBytes });
        if (fabricated.bundleFile !== "") {
            artifacts.push({ name: fabricated.bundleFile.split(/[\\/]/u).pop() ?? "fabrication.zip", bytes: fabricated.bundleBytes });
        }
        return ok({
            ecadAction: {
                action: action,
                ok: fabricated.ok,
                error: fabricated.error,
                durationMs: Date.now() - started,
                artifacts: artifacts.slice(0, 40),
                notes: fabricated.notes,
            },
        });
    }
    if (path === WEB_API_PREFIX + "/faults") {
        // 故障页：把本会话最近的失败事件按规则翻成「先看哪里」。只读事件流，不碰探针。
        const wanted = (query["session"] ?? "").trim();
        const since = Number(query["since"] ?? "0");
        const limitRaw = Number(query["limit"] ?? "50");
        const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.trunc(limitRaw))) : 50;
        const failures = eventSnapshot(Number.isFinite(since) ? since : 0, wanted).filter((item) => item.status === "fail");
        const faults = failures.slice(-limit).map((item) => {
            const decoded = decodeFault(item.summary);
            return {
                seq: item.seq,
                time: item.time,
                kind: item.kind,
                summary: item.summary,
                category: decoded.category,
                hint: decoded.hint,
                rule: decoded.rule,
            };
        });
        return ok({ faults, total: failures.length, groups: groupFaults(faults) });
    }
    if (path === WEB_API_PREFIX + "/evidence") {
        // 回放：列出证据目录里可载入的 jsonl 文件。只读目录，不读内容。
        const root = evidenceRoot(env);
        const files = await listEvidenceFiles(root);
        const bytes = files.reduce((sum, file) => sum + file.size, 0);
        return ok({
            evidence: { root, files, groups: groupEvidenceFiles(files), usage: { count: files.length, bytes }, policy: evidencePolicy(env) },
        });
    }
    if (path === WEB_API_PREFIX + "/evidence/prune") {
        // 保留策略：按配置的天数与会话数清最旧的；面板也给一个手动入口。
        const policy = evidencePolicy(env);
        const pruned = await pruneEvidence({ env, keepDays: policy.keepDays, keepSessions: policy.keepSessions });
        return ok({ pruned });
    }
    if (path === WEB_API_PREFIX + "/replay") {
        // 回放：把一份证据文件读成事件数组，面板把它铺到时间线上。路径必须落在证据目录内。
        const root = evidenceRoot(env);
        const requested = typeof query["path"] === "string" ? query["path"] : "";
        const target = evidenceTarget(root, requested);
        if (target === null)
            return fail(400, "path 必须是证据目录下的 .jsonl 相对路径");
        try {
            const info = await stat(target);
            if (info.size > REPLAY_MAX_BYTES) {
                return fail(413, "证据文件过大（" + String(Math.round(info.size / 1024)) + " KB），不在面板里打开");
            }
            const text = await readFile(target, "utf8");
            const replay = parseEvidence(text);
            return ok({ replay: { file: requested.trim(), events: replay.events, skipped: replay.skipped } });
        }
        catch (error) {
            return fail(409, "读取证据失败：" + describeError(error));
        }
    }
    if (path === WEB_API_PREFIX + "/artifacts") {
        // 产物页：elf / hex / bin 的文件信息与芯片容量。只读文件属性，不起子进程。
        const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
        const projectDir = firmwareProject(requested);
        if (projectDir === "")
            return fail(400, PROJECT_DIR_REQUIRED);
        const read = readArtifacts(projectDir, env);
        if (!read.ok)
            return fail(409, read.error);
        return ok({ artifacts: read.report });
    }
    if (path === WEB_API_PREFIX + "/status") {
        // 面板状态条用：事件计数、当前会话键、证据目录。都是只读的诊断信息。
        const wanted = (query["session"] ?? "").trim();
        const ring = eventSnapshot(0, wanted);
        return ok({
            status: {
                eventCount: ring.length,
                latestSeq: ring.length === 0 ? 0 : (ring[ring.length - 1]?.seq ?? 0),
                sessionKey: wanted === "" ? eventSessionKey() : wanted,
                evidenceRoot: evidenceRoot(env),
                ringLimit: EVENT_RING_LIMIT,
                evidenceOverride: (envValue(env, "EVIDENCE") ?? "").trim() !== "",
                running: listRunning(wanted),
                self: pluginSelfCheck(),
            },
        });
    }
    if (path === WEB_API_PREFIX + "/toolchain") {
        // 设置页「电路设计工具链」（S187）：把五处外部依赖的现状一次查完，只读。
        const located = locateEcadToolchain(envOf(input.deps));
        const toolchain = located.toolchain;
        const runtimeDir = ecadRuntimeDir(envOf(input.deps));
        const routeRoot = krtRoot(envOf(input.deps));
        const krt = krtStatus(routeRoot);
        const poppler = locatePoppler(popplerDirs());
        const ipc = toolchain === null
            ? { python: "", kipy: false }
            : { python: toolchain.python, kipy: existsSync(join(dirname(toolchain.python), "Lib", "site-packages", "kipy")) };
        return ok({
            toolchain: {
                ok: located.ok,
                error: located.ok ? "" : located.error,
                kicad: toolchain === null
                    ? { ok: false, error: located.error, root: "", kicadCli: "", bun: "", python: "", footprintDir: "", symbolDir: "", model3dDir: "", notes: [] }
                    : {
                        ok: true,
                        error: "",
                        root: toolchain.root,
                        kicadCli: toolchain.kicadCli,
                        bun: toolchain.bun,
                        python: toolchain.python,
                        footprintDir: toolchain.footprintDir,
                        symbolDir: toolchain.symbolDir,
                        model3dDir: toolchain.model3dDir,
                        notes: [...toolchain.notes],
                    },
                runtime: {
                    ready: runtimeReady(runtimeDir),
                    dir: runtimeDir,
                    bytes: runtimeReady(runtimeDir) ? runtimeBytes(runtimeDir) : 0,
                    mode: runtimeInstallMode(),
                },
                autoroute: {
                    ready: krt.ok,
                    error: krt.error,
                    hasModule: krt.hasModule,
                    version: krt.ok ? krtVersion(routeRoot) : "",
                    root: routeRoot,
                },
                poppler: {
                    ok: poppler.tools !== null,
                    error: poppler.error,
                    binDir: poppler.tools === null ? "" : poppler.tools.binDir,
                },
                ipc,
            },
        });
    }
    return fail(404, "没有这个接口：" + path);
}
/* ------------------------------ 事件流 ------------------------------ */
/** 事件流的路径（SSE，长连接，不用 JSON 分发器）。 */
export const EVENT_STREAM_PATH = WEB_API_PREFIX + "/events";
/** 心跳间隔：反代与浏览器都会掐掉长时间无数据的连接。 */
const EVENT_HEARTBEAT_MS = 15_000;
function writeEvent(response, event) {
    if (typeof response.write !== "function")
        return;
    response.write("id: " + String(event.seq) + "\n");
    response.write("data: " + JSON.stringify(event) + "\n\n");
}
/**
 * 打开一条事件流：先补发 since 之后的存量事件，再持续推送新事件。
 *
 * 返回停止函数；请求方断开时自动停止，调用方也可显式停止。
 * 这里直接写原始 response，交给 registerWebRoutes 注册，不走 handleWebApi 的 JSON 分发。
 */
export function openEventStream(request, response, options = {}) {
    let closed = false;
    let unsubscribe = () => { };
    let heartbeat;
    const stop = () => {
        if (closed)
            return;
        closed = true;
        unsubscribe();
        if (heartbeat !== undefined)
            clearInterval(heartbeat);
        if (typeof response.end === "function") {
            try {
                response.end();
            }
            catch {
                // 对端已断开，忽略。
            }
        }
    };
    if (typeof response.writeHead === "function") {
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        });
    }
    if (typeof response.write === "function")
        response.write(": connected\n\n");
    const since = typeof options.since === "number" && Number.isFinite(options.since) ? options.since : 0;
    const wanted = (options.session ?? "").trim();
    for (const event of eventSnapshot(since, wanted))
        writeEvent(response, event);
    unsubscribe = subscribeEvents((event) => {
        if (closed)
            return;
        // 带 session 的订阅只推本会话事件：多标签页同时开着时各看各的。
        if (wanted !== "" && event.session !== wanted)
            return;
        writeEvent(response, event);
    });
    heartbeat = setInterval(() => {
        if (closed)
            return;
        if (typeof response.write === "function")
            response.write(": ping\n\n");
    }, options.heartbeatMs ?? EVENT_HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function")
        heartbeat.unref();
    if (typeof request?.on === "function") {
        request.on("close", stop);
        request.on("error", stop);
    }
    return stop;
}
