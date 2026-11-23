import { readFileSync, writeFileSync } from "node:fs";
function readText(file) {
    return readFileSync(file, "utf8");
}
export const EMPTY_DIFF = {
    ok: false,
    error: "",
    beforeFile: "",
    afterFile: "",
    layers: [],
    stats: { beforeSegments: 0, afterSegments: 0, added: 0, removed: 0, addedMm: 0, removedMm: 0, addedVias: 0, removedVias: 0 },
    findings: [],
    notes: [],
};
export const EMPTY_DIFF_SVG = { ok: false, error: "", file: "", layers: [], widthMm: 0, heightMm: 0, notes: [] };
const SNAP = 0.01;
const KEY = 2;
function snap(value) {
    return Math.round(value / SNAP) * SNAP;
}
function key(x, y) {
    return snap(x).toFixed(KEY) + "," + snap(y).toFixed(KEY);
}
/** 走线按「两端点排序 + 层 + 宽度」认身份：同一条线方向写反也算同一条。 */
function segmentKey(segment) {
    const a = key(segment.x1, segment.y1);
    const b = key(segment.x2, segment.y2);
    return (a < b ? a + "|" + b : b + "|" + a) + "@" + segment.layer + "#" + segment.width.toFixed(3);
}
function blocks(text, tag) {
    const out = [];
    const pattern = new RegExp("\\(" + tag + "\\b", "gu");
    let hit = pattern.exec(text);
    while (hit !== null) {
        let depth = 0;
        let quoted = false;
        let end = -1;
        for (let i = hit.index; i < text.length; i += 1) {
            const char = text[i];
            if (char === '"') {
                quoted = !quoted;
                continue;
            }
            if (quoted)
                continue;
            if (char === "(")
                depth += 1;
            else if (char === ")") {
                depth -= 1;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end < 0)
            break;
        out.push({ start: hit.index, end, text: text.slice(hit.index, end + 1) });
        pattern.lastIndex = end + 1;
        hit = pattern.exec(text);
    }
    return out;
}
function numbers(text, field) {
    const hit = new RegExp("\\(" + field + "\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)(?:\\s+-?\\d+(?:\\.\\d+)?)?", "u").exec(text);
    if (hit === null)
        return [];
    return [Number(hit[1]), Number(hit[2])];
}
function quoted(text, field) {
    const hit = new RegExp("\\(" + field + "\\s+\"([^\"]*)\"", "u").exec(text);
    return hit === null || hit[1] === undefined ? "" : hit[1];
}
function scalar(text, field) {
    const hit = new RegExp("\\(" + field + "\\s+(-?\\d+(?:\\.\\d+)?)", "u").exec(text);
    return hit === null ? 0 : Number(hit[1]);
}
function numberNet(text) {
    const hit = /\(net\s+(\d+)/u.exec(text);
    return hit === null ? -1 : Number(hit[1]);
}
function parseBoard(text) {
    const netNames = new Map();
    for (const block of blocks(text, "net")) {
        const id = numberNet(block.text);
        const name = quoted(block.text, "net");
        if (name === "") {
            const nameHit = /\(net\s+\d+\s+"([^"]*)"/u.exec(block.text);
            const resolved = nameHit === null ? undefined : nameHit[1];
            if (resolved !== undefined)
                netNames.set(String(id), resolved);
        }
        else
            netNames.set(String(id), name);
    }
    const segments = [];
    for (const block of blocks(text, "segment")) {
        const layer = quoted(block.text, "layer");
        if (!layer.endsWith(".Cu"))
            continue;
        const start = numbers(block.text, "start");
        const end = numbers(block.text, "end");
        const sx = start[0];
        const sy = start[1];
        const ex = end[0];
        const ey = end[1];
        if (sx === undefined || sy === undefined || ex === undefined || ey === undefined)
            continue;
        const id = numberNet(block.text);
        segments.push({
            x1: sx, y1: sy, x2: ex, y2: ey,
            width: scalar(block.text, "width"),
            layer,
            net: netNames.get(String(id)) ?? "",
        });
    }
    const vias = [];
    for (const block of blocks(text, "via")) {
        const at = numbers(block.text, "at");
        const vx = at[0];
        const vy = at[1];
        if (vx === undefined || vy === undefined)
            continue;
        const id = numberNet(block.text);
        vias.push({ x: vx, y: vy, drill: scalar(block.text, "drill"), net: netNames.get(String(id)) ?? "" });
    }
    return { segments, vias, netNames };
}
function lengthOf(segment) {
    return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}
function keyOfVia(via) {
    return key(via.x, via.y) + "D" + via.drill.toFixed(2);
}
/** 逐层对比两块板的铜：新增/删除的段数与长度、新增/删除的过孔。 */
export function analyzeDiff(beforeText, afterText) {
    const before = parseBoard(beforeText);
    const after = parseBoard(afterText);
    const beforeKeys = new Map(before.segments.map((segment) => [segmentKey(segment), segment]));
    const afterKeys = new Map(after.segments.map((segment) => [segmentKey(segment), segment]));
    const layers = new Set();
    for (const segment of before.segments)
        layers.add(segment.layer);
    for (const segment of after.segments)
        layers.add(segment.layer);
    const layerDiffs = [];
    const findings = [];
    let added = 0;
    let removed = 0;
    let addedMm = 0;
    let removedMm = 0;
    for (const layer of [...layers].sort()) {
        let addCount = 0;
        let removeCount = 0;
        let addMm = 0;
        let removeMm = 0;
        for (const [k, segment] of afterKeys) {
            if (segment.layer !== layer)
                continue;
            if (!beforeKeys.has(k)) {
                addCount += 1;
                addMm += lengthOf(segment);
            }
        }
        for (const [k, segment] of beforeKeys) {
            if (segment.layer !== layer)
                continue;
            if (!afterKeys.has(k)) {
                removeCount += 1;
                removeMm += lengthOf(segment);
            }
        }
        layerDiffs.push({
            layer,
            before: [...beforeKeys.values()].filter((segment) => segment.layer === layer).length,
            after: [...afterKeys.values()].filter((segment) => segment.layer === layer).length,
            added: addCount,
            removed: removeCount,
            addedMm: addMm,
            removedMm: removeMm,
        });
        added += addCount;
        removed += removeCount;
        addedMm += addMm;
        removedMm += removeMm;
        if (layer !== "F.Cu" && layer !== "B.Cu" && addCount + removeCount > 0) {
            findings.push({
                id: "diff.inner-layer-change",
                severity: "info",
                message: "内层 " + layer + " 有改动：新增 " + String(addCount) + " 段、删除 " + String(removeCount) + " 段",
                fix: "内层改动最容易漏看：用 stm32_pcb_layers 对照同一层的图确认，别只看外层。",
            });
        }
    }
    const beforeVias = new Set(before.vias.map(keyOfVia));
    const afterVias = new Set(after.vias.map(keyOfVia));
    let addedVias = 0;
    let removedVias = 0;
    for (const k of afterVias)
        if (!beforeVias.has(k))
            addedVias += 1;
    for (const k of beforeVias)
        if (!afterVias.has(k))
            removedVias += 1;
    const notes = [];
    if (added === 0 && removed === 0 && addedVias === 0 && removedVias === 0) {
        notes.push("两块板的铜完全一致：没有新增或删除的走线与过孔。");
    }
    notes.push("对比口径：走线按「两端点 + 层 + 宽度」认身份，方向写反不算改；两端各吸附 0.01 mm。");
    notes.push("这条只比几何，不比网络：同一位置换了网络名也看不出来，需要 stm32_netgate 兜。");
    if (added + removed > 0) {
        findings.unshift({
            id: "diff.summary",
            severity: "warning",
            message: "铜有改动：新增 " + String(added) + " 段（" + addedMm.toFixed(1) + " mm）、删除 "
                + String(removed) + " 段（" + removedMm.toFixed(1) + " mm）、过孔 +" + String(addedVias) + "/-" + String(removedVias),
            fix: "逐层看图确认改动是否符合预期；只靠 DRC 通过不能说明改对了地方。",
        });
    }
    return {
        ok: true,
        error: "",
        beforeFile: "",
        afterFile: "",
        layers: layerDiffs,
        stats: {
            beforeSegments: before.segments.length,
            afterSegments: after.segments.length,
            added, removed, addedMm, removedMm, addedVias, removedVias,
        },
        findings,
        notes,
    };
}
export function readDiff(beforeFile, afterFile) {
    try {
        const report = analyzeDiff(readText(beforeFile), readText(afterFile));
        return { ...report, beforeFile, afterFile };
    }
    catch (error) {
        return { ...EMPTY_DIFF, error: "读板子失败：" + (error instanceof Error ? error.message : String(error)), beforeFile, afterFile };
    }
}
function boxOf(segments) {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const segment of segments) {
        x0 = Math.min(x0, segment.x1, segment.x2);
        y0 = Math.min(y0, segment.y1, segment.y2);
        x1 = Math.max(x1, segment.x1, segment.x2);
        y1 = Math.max(y1, segment.y1, segment.y2);
    }
    if (!Number.isFinite(x0))
        return { x0: 0, y0: 0, x1: 1, y1: 1 };
    return { x0, y0, x1, y1 };
}
/** 把「删除的线」与「新增的线」画在同一张图上：同原点、同比例，红灰=旧、绿=新。 */
export function renderDiffSvg(beforeText, afterText, options = {}) {
    const before = parseBoard(beforeText);
    const after = parseBoard(afterText);
    const onlyChanges = options.onlyChanges !== false;
    const beforeKeys = new Set(before.segments.map(segmentKey));
    const afterKeys = new Set(after.segments.map(segmentKey));
    const layers = options.layers === undefined || options.layers.length === 0
        ? [...new Set([...before.segments, ...after.segments].map((segment) => segment.layer))].sort()
        : [...options.layers];
    const layerSet = new Set(layers);
    const removed = before.segments.filter((segment) => layerSet.has(segment.layer) && !afterKeys.has(segmentKey(segment)));
    const added = after.segments.filter((segment) => layerSet.has(segment.layer) && !beforeKeys.has(segmentKey(segment)));
    const unchangedBefore = before.segments.filter((segment) => layerSet.has(segment.layer) && afterKeys.has(segmentKey(segment)));
    const drawable = onlyChanges ? [...removed, ...added] : [...unchangedBefore, ...removed, ...added];
    const box = boxOf(drawable.length > 0 ? drawable : before.segments);
    const pad = 2;
    const widthMm = Math.max(1, box.x1 - box.x0 + pad * 2);
    const heightMm = Math.max(1, box.y1 - box.y0 + pad * 2);
    const scale = 8;
    const px = (value) => Math.round((value - box.x0 + pad) * scale * 100) / 100;
    const py = (value) => Math.round((value - box.y0 + pad) * scale * 100) / 100;
    const strokes = [];
    if (!onlyChanges) {
        for (const segment of unchangedBefore) {
            strokes.push('<line x1="' + px(segment.x1) + '" y1="' + py(segment.y1) + '" x2="' + px(segment.x2) + '" y2="' + py(segment.y2)
                + '" stroke="#b9bec6" stroke-width="' + Math.max(0.6, segment.width * scale).toFixed(2) + '" stroke-linecap="round" />');
        }
    }
    for (const segment of removed) {
        strokes.push('<line x1="' + px(segment.x1) + '" y1="' + py(segment.y1) + '" x2="' + px(segment.x2) + '" y2="' + py(segment.y2)
            + '" stroke="#c03a2b" stroke-width="' + Math.max(0.8, segment.width * scale).toFixed(2) + '" stroke-linecap="round" />');
    }
    for (const segment of added) {
        strokes.push('<line x1="' + px(segment.x1) + '" y1="' + py(segment.y1) + '" x2="' + px(segment.x2) + '" y2="' + py(segment.y2)
            + '" stroke="#1f7a3f" stroke-width="' + Math.max(0.8, segment.width * scale).toFixed(2) + '" stroke-linecap="round" />');
    }
    const svg = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(widthMm * scale) + '" height="' + Math.round(heightMm * scale)
            + '" viewBox="0 0 ' + Math.round(widthMm * scale) + ' ' + Math.round(heightMm * scale) + '">',
        '<rect x="0" y="0" width="100%" height="100%" fill="#ffffff" />',
        '<g fill="none">',
        ...strokes,
        "</g>",
        "</svg>",
    ].join("\n");
    return { svg, layers, box };
}
/** 把逐层差异图写到 <outDir>/<层名点换下划线>.svg。 */
export function writeDiffSvgs(beforeFile, afterFile, outDir, mkdir) {
    try {
        const beforeText = readText(beforeFile);
        const afterText = readText(afterFile);
        mkdir(outDir);
        const result = renderDiffSvg(beforeText, afterText);
        const written = [];
        for (const layer of result.layers) {
            const one = renderDiffSvg(beforeText, afterText, { layers: [layer] });
            const name = layer.replace(/\./gu, "_") + ".svg";
            writeFileSync(outDir + "/" + name, one.svg.replace(/\n/gu, "\r\n"), "utf8");
            written.push(name);
        }
        const all = renderDiffSvg(beforeText, afterText);
        writeFileSync(outDir + "/all.svg", all.svg.replace(/\n/gu, "\r\n"), "utf8");
        written.push("all.svg");
        return {
            ok: true,
            error: "",
            file: outDir,
            layers: written,
            widthMm: Math.round(all.box.x1 - all.box.x0),
            heightMm: Math.round(all.box.y1 - all.box.y0),
            notes: ["红=删除、绿=新增；每层一张，另有一张 all.svg 把各层叠在一起。", "同原点同比例：两张图按坐标直接对比即可。"],
        };
    }
    catch (error) {
        return { ...EMPTY_DIFF_SVG, error: "写差异图失败：" + (error instanceof Error ? error.message : String(error)) };
    }
}
