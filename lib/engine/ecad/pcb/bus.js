/**
 * 成组几何：总线是否等距、电源主干是否同宽顺直（S236，外部技能文档 §7.0.1）。
 *
 * 两条口径：
 * 1. 总线判据只看「同网、同层、同角度、彼此相邻」的一组线：先把同角度的线按垂直方向投影排序，
 *    距离在 3 mm 内的连成一束，束里至少 3 根才谈等距——两根线谈不上「成组」。
 * 2. 电源主干看宽度分布：该网络的主宽度取出现最多的宽度，细于它 80% 的段算瓶颈段。
 *    有整块铺铜的网络不判主干（电流走铜皮），只记一条提示。
 */
import { readFileSync } from "node:fs";
export const EMPTY_BUS = {
    ok: false,
    error: "",
    boardFile: "",
    groups: [],
    trunks: [],
    findings: [],
    notes: [],
};
const ANGLE_BUCKETS = [0, 45, 90, 135];
const SNAP = 0.01;
function blocks(text, tag) {
    const out = [];
    const pattern = new RegExp("\\(" + tag + "\\b", "gu");
    for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
        let depth = 0;
        let index = hit.index;
        let inString = false;
        for (; index < text.length; index += 1) {
            const ch = text[index];
            if (ch === '"')
                inString = !inString;
            if (!inString && ch === "(")
                depth += 1;
            if (!inString && ch === ")") {
                depth -= 1;
                if (depth === 0)
                    break;
            }
        }
        out.push(text.slice(hit.index, index + 1));
        pattern.lastIndex = index + 1;
    }
    return out;
}
function netName(block, names) {
    const hit = /\(net (?:"([^"]*)"|(\d+))/u.exec(block);
    if (hit === null)
        return "";
    if (hit[1] !== undefined)
        return hit[1];
    return names.get(hit[2] ?? "") ?? "";
}
function readNetNames(text) {
    const names = new Map();
    for (const match of text.matchAll(/\(net (\d+) "([^"]*)"\)/gu)) {
        const id = match[1] ?? "";
        if (id !== "")
            names.set(id, (match[2] ?? "").trim());
    }
    return names;
}
function angleOf(dx, dy) {
    const raw = (Math.atan2(dy, dx) * 180) / Math.PI;
    const folded = raw < 0 ? raw + 180 : raw;
    return Math.round(folded);
}
function readSegments(text) {
    const names = readNetNames(text);
    const segments = [];
    for (const block of blocks(text, "segment")) {
        const start = /\(start (-?[\d.]+) (-?[\d.]+)\)/u.exec(block);
        const end = /\(end (-?[\d.]+) (-?[\d.]+)\)/u.exec(block);
        const width = /\(width ([\d.]+)\)/u.exec(block);
        const layer = /\(layer "?([\w.]+)"?\)/u.exec(block);
        if (start === null || end === null || width === null)
            continue;
        const x1 = Number(start[1]);
        const y1 = Number(start[2]);
        const x2 = Number(end[1]);
        const y2 = Number(end[2]);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthMm = Math.hypot(dx, dy);
        if (lengthMm < 0.05)
            continue;
        segments.push({
            net: netName(block, names),
            layer: layer?.[1] ?? "",
            width: Number(width[1]),
            x1,
            y1,
            x2,
            y2,
            angle: angleOf(dx, dy),
            mx: (x1 + x2) / 2,
            my: (y1 + y2) / 2,
            lengthMm,
        });
    }
    return segments;
}
const POWER = /(?:GND|AGND|DGND|PGND|VSS|VCC|VDD|VBUS|VIN|VBAT|VSYS|V3V3|3V3|3\.3V|5V|12V|AVDD|DVDD)/iu;
function pouredNets(text) {
    const names = readNetNames(text);
    const poured = new Set();
    for (const block of blocks(text, "zone")) {
        if (!block.includes("(filled_polygon"))
            continue;
        const net = netName(block, names);
        if (net !== "")
            poured.add(net);
    }
    return poured;
}
export function analyzeBuses(text, options = {}) {
    if (text.trim() === "")
        return { ...EMPTY_BUS, error: "板子文件是空的" };
    const minSpacing = options.minSpacingMm ?? 0.1;
    const maxSpacing = options.maxSpacingMm ?? 1.27;
    const minLines = Math.max(2, options.minLines ?? 3);
    const tolerance = options.toleranceMm ?? 0.15;
    const trunkRatio = options.trunkRatio ?? 0.6;
    const segments = readSegments(text);
    const poured = pouredNets(text);
    const groups = [];
    const findings = [];
    // 总线：同层同角度、沿自身方向有重叠、垂直间距在 0.1–3 mm 的相邻线，至少 3 根且网络不全相同。
    const byLayerAngle = new Map();
    for (const segment of segments) {
        if (segment.net === "" || segment.layer === "" || segment.lengthMm < 2)
            continue;
        const bucket = ANGLE_BUCKETS.find((candidate) => Math.abs(candidate - segment.angle) <= 1);
        if (bucket === undefined)
            continue;
        const key = segment.layer + "|" + String(bucket);
        const list = byLayerAngle.get(key);
        if (list === undefined)
            byLayerAngle.set(key, [{ ...segment, angle: bucket }]);
        else
            list.push({ ...segment, angle: bucket });
    }
    for (const [, list] of byLayerAngle) {
        if (list.length < minLines)
            continue;
        const angle = list[0].angle;
        const rad = (angle * Math.PI) / 180;
        const ux = Math.cos(rad);
        const uy = Math.sin(rad);
        // 垂直方向偏移（用于排序成束）与沿方向投影（用于判重叠）
        const project = (segment) => {
            const a1 = segment.x1 * ux + segment.y1 * uy;
            const a2 = segment.x2 * ux + segment.y2 * uy;
            const across = -segment.x1 * uy + segment.y1 * ux;
            return { across, along1: Math.min(a1, a2), along2: Math.max(a1, a2) };
        };
        const decorated = list.map((segment) => ({ segment, ...project(segment) }));
        decorated.sort((a, b) => a.across - b.across);
        let cluster = [];
        const flush = () => {
            const nets = new Set(cluster.map((item) => item.segment.net));
            // 三根互不相干的线恰好平行且挨得近，不是总线：长度也要接近（±40% 中位数）。
            const spans = cluster.map((item) => item.along2 - item.along1).sort((a, b) => a - b);
            const median = spans[Math.floor(spans.length / 2)] ?? 0;
            const similar = spans.every((span) => median === 0 || Math.abs(span - median) <= median * 0.4);
            if (cluster.length >= minLines && nets.size >= 2 && similar) {
                const spacings = [];
                for (let index = 1; index < cluster.length; index += 1) {
                    const a = cluster[index - 1];
                    const b = cluster[index];
                    spacings.push(Math.round(Math.abs(b.across - a.across) * 1000) / 1000);
                }
                const min = Math.min(...spacings);
                const max = Math.max(...spacings);
                const uneven = Math.round((max - min) * 1000) / 1000;
                const layer = cluster[0].segment.layer;
                groups.push({
                    net: [...nets].slice(0, 4).join(" / ") + (nets.size > 4 ? " 等" : ""),
                    layer,
                    angleDeg: angle,
                    lines: cluster.length,
                    spacingMm: spacings,
                    unevenMm: uneven,
                });
                if (uneven > tolerance) {
                    findings.push({
                        id: "bus.uneven-spacing",
                        severity: "warning",
                        message: layer + " 上有 " + String(cluster.length) + " 根 " + String(angle) + "° 平行线（" + String(nets.size) +
                            " 个网络），相邻间距 " + String(min) + "–" + String(max) + " mm（差 " + String(uneven) + " mm）",
                        fix: "把这一束的间距调成同一个值（常见 2× 线宽或 0.2 mm），整组线看起来才是一条总线。",
                    });
                }
            }
            cluster = [];
        };
        for (const item of decorated) {
            if (cluster.length === 0) {
                cluster.push(item);
                continue;
            }
            const last = cluster[cluster.length - 1];
            const gap = Math.abs(item.across - last.across);
            const overlap = Math.min(item.along2, last.along2) - Math.max(item.along1, last.along1);
            const fits = gap >= minSpacing && gap <= maxSpacing && overlap >= 0.5 * Math.min(item.along2 - item.along1, last.along2 - last.along1);
            if (fits)
                cluster.push(item);
            else {
                flush();
                cluster.push(item);
            }
        }
        flush();
    }
    // 电源主干：按网络 + 层看宽度分布，主宽度取出现最多的一档；只数长于 1 mm 的瓶颈段。
    const trunks = [];
    const byNetLayer = new Map();
    for (const segment of segments) {
        if (segment.net === "" || segment.layer === "" || !POWER.test(segment.net))
            continue;
        if (poured.has(segment.net))
            continue;
        const key = segment.net + "|" + segment.layer;
        const list = byNetLayer.get(key);
        if (list === undefined)
            byNetLayer.set(key, [segment]);
        else
            list.push(segment);
    }
    for (const [key, list] of byNetLayer) {
        const counts = new Map();
        for (const segment of list) {
            const bucket = Math.round(segment.width / 0.05) * 0.05;
            counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
        }
        const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (dominant === undefined)
            continue;
        const dominantMm = Math.round(dominant[0] * 1000) / 1000;
        const narrow = list.filter((segment) => segment.width < dominantMm * trunkRatio && segment.lengthMm >= 1).length;
        const parts = key.split("|");
        trunks.push({ net: parts[0] ?? "", layer: parts[1] ?? "", dominantMm, narrow, total: list.length, ok: narrow === 0 });
        if (narrow > 0) {
            findings.push({
                id: "bus.trunk-narrower",
                severity: "info",
                message: (parts[0] ?? "") + " 在 " + (parts[1] ?? "") + " 上主宽度 " + String(dominantMm) + " mm，有 " + String(narrow) +
                    " 段长于 1 mm 的线细于它的 " + String(Math.round(trunkRatio * 100)) + "%",
                fix: "主干按主宽度走到底；要分出去就在分叉点之后过渡，别在主干中间夹细段。",
            });
        }
    }
    if (segments.length === 0) {
        findings.push({ id: "bus.no-tracks", severity: "info", message: "板子上没有走线：先布线再看总线。", fix: "先跑一次布线（stm32_pcb_autoroute）。" });
    }
    else if (groups.length === 0) {
        findings.push({ id: "bus.no-groups", severity: "info", message: "没有认出成组的平行线（至少 3 根、间距 0.1–3 mm、沿方向有重叠）。", fix: "" });
    }
    if (poured.size > 0)
        findings.push({ id: "bus.poured-nets", severity: "info", message: "有 " + String(poured.size) + " 个网络靠铺铜载流，主干宽度不判。", fix: "" });
    return { ok: true, error: "", boardFile: "", groups, trunks, findings, notes: [] };
}
export function readBuses(boardFile, options = {}) {
    try {
        const report = analyzeBuses(readFileSync(boardFile, "utf8"), options);
        return { ...report, boardFile };
    }
    catch (error) {
        return { ...EMPTY_BUS, boardFile, error: "读不到板子：" + (error instanceof Error ? error.message : String(error)) };
    }
}
