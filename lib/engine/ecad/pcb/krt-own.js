/**
 * 用「我们自己的规则」调 KiCadRoutingTools 的 route.py（S195）。
 *
 * autoroute.py 的路线是「按工艺下限布一遍」，net class 只当上限提示；
 * 想把线画整齐，必须显式给 route.py 传宽度、间距、电源网与排序策略，
 * 并打开它自带的 45° smoothing。这里只负责拼参数、跑、把汇总拿回来。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runCapture } from "../../subprocess-runner.js";
/** 引擎以自身目录为 cwd 运行，相对路径会落到引擎目录里；这里统一按输入板所在目录解析。 */
function absFrom(inputPcb, target) {
    if (isAbsolute(target))
        return target;
    return resolve(inputPcb !== "" ? dirname(inputPcb) : process.cwd(), target);
}
const ROUTE_REL = join("py_router", "route.py");
const PLANES_REL = join("py_router", "route_planes.py");
/** 按括号配平从 `(layers` 处取整块（KiCad 的层表是跨行的，不能按 `[^)]*` 截）。 */
function layersBlock(pcbText) {
    const start = pcbText.indexOf("(layers");
    if (start < 0)
        return "";
    let depth = 0;
    for (let i = start; i < pcbText.length; i += 1) {
        const ch = pcbText[i];
        if (ch === "(")
            depth += 1;
        else if (ch === ")") {
            depth -= 1;
            if (depth === 0)
                return pcbText.slice(start, i + 1);
        }
    }
    return "";
}
/** 板上铜层数：从层表里数 F/B/In*.Cu（去重），读不到按 2 层。 */
export function copperLayersOf(pcbText) {
    const block = layersBlock(pcbText);
    if (block === "")
        return 2;
    const names = new Set();
    for (const match of block.matchAll(/"(F|B|In\d+)\.Cu"/gu))
        names.add(match[0]);
    return names.size === 0 ? 2 : names.size;
}
/**
 * 内层分配：In1 给地，In2 给「焊盘最多」的那个电源网（S199）。
 *
 * 一块板通常有 3V3 和 5V 两个电源，内层只有两片可用；把焊盘最多的那个
 * 铺成平面收益最大，其余电源网继续走外层铜皮。
 */
export function planeAssignment(pcbText, copperLayers) {
    // 焊盘块是跨行的（(pad "" smd rect \n (size …) \n (net "GND") …），
    // 按「下一个 (pad 之前」切片取网络名，比按括号配平简单且不会漏。
    const padCounts = new Map();
    const starts = [];
    for (let index = pcbText.indexOf("(pad "); index >= 0; index = pcbText.indexOf("(pad ", index + 5)) {
        starts.push(index);
    }
    for (let cursor = 0; cursor < starts.length; cursor += 1) {
        const end = cursor + 1 < starts.length ? starts[cursor + 1] : pcbText.length;
        const net = /\(net\s+"([^"]+)"\)/u.exec(pcbText.slice(starts[cursor], end));
        if (net === null)
            continue;
        const name = net[1] ?? "";
        if (name === "")
            continue;
        padCounts.set(name, (padCounts.get(name) ?? 0) + 1);
    }
    const nets = [];
    const layers = [];
    // 网络名可能带图纸路径前缀（KiCad 写作 /ADS1256/AVDD_5V），取最后一段再判。
    const leaf = (name) => name.split("/").pop() ?? name;
    const ground = [...padCounts.keys()].find((name) => /^(?:GND|VSS|AGND|PGND|DGND|GNDA|GNDD)$/iu.test(leaf(name)));
    if (ground !== undefined) {
        nets.push(ground);
        layers.push("In1.Cu");
    }
    if (copperLayers >= 4) {
        const power = [...padCounts.entries()]
            .filter(([name]) => /^\+?(?:3V3|V3V3|VCC|VDD|5V|VBUS|VBAT|VIN|AVDD|DVDD|AVCC|DVCC)(?:_?5V|_?3V3)?$/iu.test(leaf(name)))
            .sort((a, b) => b[1] - a[1])[0];
        if (power !== undefined) {
            nets.push(power[0]);
            layers.push("In2.Cu");
        }
    }
    return { nets, layers };
}
export function effectiveRouteSpec(boardFile, preset) {
    const notes = [];
    let boardRules = null;
    const pro = boardFile.replace(/\.kicad_pcb$/u, ".kicad_pro");
    if (existsSync(pro)) {
        try {
            const parsed = JSON.parse(readFileSync(pro, "utf8"));
            const fallback = (parsed.net_settings?.classes ?? []).find((item) => item.name === "Default") ?? (parsed.net_settings?.classes ?? [])[0];
            if (fallback !== undefined) {
                boardRules = {
                    clearanceMm: typeof fallback.clearance === "number" ? fallback.clearance : null,
                    viaDiameterMm: typeof fallback.via_diameter === "number" ? fallback.via_diameter : null,
                    viaDrillMm: typeof fallback.via_drill === "number" ? fallback.via_drill : null,
                    trackWidthMm: typeof fallback.track_width === "number" ? fallback.track_width : null,
                };
            }
        }
        catch {
            notes.push("读不懂板子的 .kicad_pro：按预设布线，DRC 可能报规则不符");
        }
    }
    else {
        notes.push("板子旁边没有 .kicad_pro：按预设布线，DRC 可能报规则不符");
    }
    const pick = (presetValue, boardValue) => boardValue !== null && boardValue !== undefined && Number.isFinite(boardValue) && boardValue > presetValue ? boardValue : presetValue;
    const spec = {
        trackWidthMm: pick(preset.signalWidthMm, boardRules?.trackWidthMm),
        clearanceMm: pick(preset.signalClearanceMm, boardRules?.clearanceMm),
        viaDiameterMm: pick(preset.viaDiameterMm, boardRules?.viaDiameterMm),
        viaDrillMm: pick(preset.viaDrillMm, boardRules?.viaDrillMm),
        boardRules,
        notes,
    };
    if (boardRules !== null && spec.clearanceMm > preset.signalClearanceMm) {
        notes.push("按板子自己的规则布：间距 " + spec.clearanceMm.toFixed(4) + " mm（预设 " + preset.signalClearanceMm.toFixed(3) + " mm 更松）");
    }
    if (boardRules !== null && spec.viaDiameterMm > preset.viaDiameterMm) {
        notes.push("过孔取板子规则：" + spec.viaDiameterMm.toFixed(3) + "/" + spec.viaDrillMm.toFixed(3) + " mm");
    }
    return spec;
}
/** 拼 route_planes.py 参数。 */
export function ownPlaneArgv(runtimeRoot, request) {
    const options = request.options;
    return [
        join(runtimeRoot, PLANES_REL), absFrom(request.inputPcb, request.inputPcb), "--output", absFrom(request.inputPcb, request.outputPcb), "--overwrite",
        "--nets", ...request.planeNets,
        "--plane-layers", ...request.planeLayers,
        "--track-width", (options.powerWidthMm ?? options.trackWidthMm).toFixed(3),
        "--clearance", options.clearanceMm.toFixed(3),
        "--via-size", (options.viaSizeMm ?? 0.45).toFixed(3),
        "--via-drill", (options.viaDrillMm ?? 0.25).toFixed(3),
        "--zone-clearance", options.clearanceMm.toFixed(3),
        // 铺铜只铺铜皮，不负责把 SMD 焊盘接上去；不开 stitching 的话，
        // GND 的 SMD 焊盘在 DRC 里全算「未连接」（实测 70 条）。
        "--stitch-vias",
    ];
}
/** 跑平面铺铜，取回 zones 与几何核对结果。 */
export async function runOwnRulePlanes(request) {
    const argv = ownPlaneArgv(request.runtime.root, request);
    const started = Date.now();
    const result = await runCapture(request.subprocess, {
        argv: [request.runtime.python, ...argv],
        cwd: request.runtime.root,
        env: { PYTHONPATH: [request.runtime.root, process.env["PYTHONPATH"] ?? ""].filter((item) => item !== "").join(";") },
        timeoutMs: request.timeoutMs ?? 900_000,
        maxBytes: 4 * 1024 * 1024,
        signal: request.signal,
    });
    const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
    const produced = existsSync(absFrom(request.inputPcb, request.outputPcb));
    const summaryLine = result.stdout.split(/\r?\n/u).reverse().find((line) => line.startsWith("JSON_SUMMARY:"));
    let zones = [];
    let padCoverage = "";
    if (summaryLine !== undefined) {
        try {
            const parsed = JSON.parse(summaryLine.slice("JSON_SUMMARY:".length));
            if (Array.isArray(parsed.plane_zones)) {
                zones = parsed.plane_zones.map((item) => {
                    const zone = item;
                    return { layer: String(zone.layer ?? ""), net: String(zone.net ?? "") };
                });
            }
            const pads = parsed.pads;
            if (pads !== undefined && typeof pads.geometric_failed === "number")
                padCoverage = parsed.pads_scope ?? "";
        }
        catch {
            zones = [];
        }
    }
    const tail = result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-1)[0] ?? "";
    const error = result.timedOut
        ? "平面铺铜超时（" + String(Math.round(seconds)) + " 秒）"
        : result.exitCode === 0 && produced
            ? ""
            : "平面铺铜没有产出板子：" + (tail === "" ? "引擎没有给出原因" : tail);
    const output = absFrom(request.inputPcb, request.outputPcb);
    return { ok: error === "", error, output: produced ? output : "", seconds, zones, padCoverage, log: result.stdout.slice(-2000) };
}
/** 从汇总里取这一轮没布通的网络名（不重复、保持原顺序）。 */
export function failedNetsOf(summary) {
    const raw = [summary["failed_single"], summary["open_single"], summary["failed"]];
    const names = [];
    for (const item of raw) {
        if (!Array.isArray(item))
            continue;
        for (const name of item) {
            const text = String(name);
            if (text !== "" && !names.includes(text))
                names.push(text);
        }
    }
    return names;
}
/**
 * 两轮布线：第一轮按我们的规则布全部网络；没布通的，带着更大的 rip-up
 * 预算在已布好的板子上补第二轮（而不是从头再来，那样会把第一轮的好线拆掉）。
 */
export async function runOwnRuleRouteWithRetry(request, options = {}) {
    const first = await runOwnRuleRoute(request);
    const failed = first.ok ? failedNetsOf(first.summary) : [];
    const limit = options.retryMaxNets ?? 12;
    const retried = failed.slice(0, limit);
    if (!first.ok || retried.length === 0)
        return { ...first, retried: [] };
    const second = await runOwnRuleRoute({
        ...request,
        inputPcb: first.output === "" ? request.inputPcb : first.output,
        outputPcb: request.outputPcb,
        options: {
            ...request.options,
            nets: retried,
            maxRipup: options.retryRipup ?? Math.max(6, (request.options.maxRipup ?? 2) * 3),
        },
    });
    if (!second.ok)
        return { ...first, retried: [] };
    return {
        ...second,
        seconds: Math.round((first.seconds + second.seconds) * 10) / 10,
        log: first.log + "\n--- 第二轮补布 ---\n" + second.log,
        summary: { ...second.summary, retried_nets: retried, first_pass_failed: failed },
        retried,
    };
}
/** 统计产出板子里各宽度（mm，4 位）的走线段数。 */
export function widthHistogram(pcbText) {
    const counts = {};
    for (const hit of pcbText.matchAll(/\(segment\s/gu)) {
        const start = hit.index ?? 0;
        // 段块里第一个 ")" 只是 start 点的括号，宽度在后面，取 400 字符窗口再匹配
        const window = pcbText.slice(start, start + 400);
        const width = /\(width\s+([\d.]+)\)/u.exec(window);
        if (width !== null) {
            const key = Number(width[1]).toFixed(4);
            counts[key] = (counts[key] ?? 0) + 1;
        }
    }
    return counts;
}
/** 拼 route.py 参数。单独导出是为了能单测（不跑子进程也能断言参数）。 */
export function ownRuleArgv(runtimeRoot, request) {
    const options = request.options;
    const args = [join(runtimeRoot, ROUTE_REL), absFrom(request.inputPcb, request.inputPcb), "--output", absFrom(request.inputPcb, request.outputPcb)];
    args.push("--track-width", options.trackWidthMm.toFixed(3));
    args.push("--clearance", options.clearanceMm.toFixed(3));
    // 每个 net class 都按我们的间距上限走，别让某些 class 偷偷放宽
    args.push("--clearance-ceiling", options.clearanceMm.toFixed(3));
    // 这些参数在 route.py 里都是 nargs="+"：一个空格分隔的列表，不能拼成逗号串
    args.push("--layers", ...(options.layers ?? ["F.Cu", "B.Cu"]));
    // 焊盘出口的收窄段（neckdown）默认 2.5 mm，会把大半条走线压成 0.127；
    // 我们自己的规则里默认收到 0.8 mm，只留刚够出焊盘的一小段。
    args.push("--neckdown-length", (options.neckdownMm ?? 0.8).toFixed(2));
    args.push("--ordering", options.ordering ?? "mps");
    const powerNets = options.powerNets ?? [];
    if (powerNets.length > 0) {
        args.push("--power-nets", ...powerNets);
        if (options.powerWidthMm !== undefined) {
            // 宽度按电源网逐个给，长度必须与 --power-nets 一致
            args.push("--power-nets-widths", ...powerNets.map(() => options.powerWidthMm?.toFixed(3) ?? ""));
        }
    }
    if (options.viaSizeMm !== undefined)
        args.push("--via-size", options.viaSizeMm.toFixed(3));
    if (options.viaDrillMm !== undefined)
        args.push("--via-drill", options.viaDrillMm.toFixed(3));
    if (options.maxRipup !== undefined)
        args.push("--max-ripup", String(options.maxRipup));
    if (options.gridStepMm !== undefined)
        args.push("--grid-step", options.gridStepMm.toFixed(3));
    if (options.boardEdgeClearanceMm !== undefined)
        args.push("--board-edge-clearance", options.boardEdgeClearanceMm.toFixed(3));
    if (options.nets !== undefined && options.nets.length > 0)
        args.push("--nets", ...options.nets);
    if (options.smoothing !== false)
        args.push("--smoothing");
    return args;
}
/** 跑一次自有规则布线。失败时把 stderr 末行拼进 error，便于面板直接显示。 */
export async function runOwnRuleRoute(request) {
    const summaryFile = request.outputPcb + ".summary.json";
    const argv = ownRuleArgv(request.runtime.root, {
        inputPcb: request.inputPcb,
        outputPcb: request.outputPcb,
        options: request.options,
    });
    argv.push("--json-out", summaryFile);
    const started = Date.now();
    const result = await runCapture(request.subprocess, {
        argv: [request.runtime.python, ...argv],
        cwd: request.runtime.root,
        env: { PYTHONPATH: [request.runtime.root, process.env["PYTHONPATH"] ?? ""].filter((item) => item !== "").join(";") },
        timeoutMs: request.timeoutMs ?? 1_800_000,
        maxBytes: 8 * 1024 * 1024,
        signal: request.signal,
    });
    const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
    let summary = {};
    if (existsSync(summaryFile)) {
        try {
            const parsed = JSON.parse(readFileSync(summaryFile, "utf8"));
            if (parsed !== null && typeof parsed === "object")
                summary = parsed;
        }
        catch {
            summary = {};
        }
    }
    const exitOk = result.exitCode === 0 && result.spawnError === null;
    const produced = existsSync(absFrom(request.inputPcb, request.outputPcb));
    const tail = result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-1)[0] ?? "";
    const error = result.timedOut
        ? "布线超时（" + String(Math.round(seconds)) + " 秒）"
        : exitOk && produced
            ? ""
            : "布线没有产出板子：" + (tail === "" ? "引擎没有给出原因" : tail);
    const widths = produced ? widthHistogram(readFileSync(request.outputPcb, "utf8")) : {};
    const segments = Object.values(widths).reduce((sum, count) => sum + count, 0);
    const requested = request.options.trackWidthMm;
    const thin = Object.entries(widths)
        .filter(([width]) => Number(width) < requested - 1e-6)
        .reduce((sum, [, count]) => sum + count, 0);
    return {
        ok: error === "",
        error,
        output: produced ? request.outputPcb : "",
        seconds,
        summary,
        widths,
        thinRatio: segments === 0 ? 0 : thin / segments,
        segments,
        log: result.stdout.slice(-4000),
    };
}
