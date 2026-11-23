/**
 * 双向参考面复核（S231）。
 *
 * 外部技能文档 §7.4 的两问：新走线是不是跨过了参考面的缺口（回流路径断在半路），
 * 新增的铜/孔是不是把邻层的参考面割开了。这两件事 DRC 都不管——DRC 只问「铜到铜的
 * 间距够不够」，不问「这条线的回流有没有地方走」。
 *
 * 判据只有两种，都必须有真实几何才成立：
 *   1. 一条信号走线的两端与中点，投影到相邻平面层上，至少有一个平面层把三点全盖住；
 *      一个都盖不住 = 跨缺口。
 *   2. 过孔或走线离平面铺铜的边界太近（0.2–0.6 mm 之间）= 回流被这条通道挤窄。
 *
 * 内层几何直接从板子文本里读：`scene.ts` 只解析外层，平面层恰恰全在内层。
 */
import { readFileSync } from "node:fs";
import { coverageOf } from "./coverage.js";
export const EMPTY_REFERENCE = {
    ok: false,
    error: "",
    boardFile: "",
    planes: [],
    stats: { segments: 0, checked: 0, gaps: 0, viaNearEdges: 0, trackNearEdges: 0 },
    findings: [],
    notes: [],
};
const POWER = /(?:GND|AGND|DGND|PGND|VCC|VDD|VBUS|VIN|VBAT|VSYS|V3V3|3V3|3\.3V|5V|12V|AVDD|DVDD)/iu;
function numbers(text, tag) {
    const hit = new RegExp("\\(" + tag + "\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)", "u").exec(text);
    if (hit === null || hit[1] === undefined || hit[2] === undefined)
        return [];
    return [Number(hit[1]), Number(hit[2])];
}
function quoted(text, tag) {
    const hit = new RegExp("\\(" + tag + '\\s+"([^"]*)"', "u").exec(text);
    return hit === null || hit[1] === undefined ? "" : hit[1];
}
function idOf(text) {
    const hit = /\(net\s+(?:(\d+)(?:\s+"([^"]*)")?|"([^"]*)")\)/u.exec(text);
    return hit === null ? "" : (hit[3] ?? hit[2] ?? hit[1] ?? "");
}
/** 取 `(tag` 开头的整块（\b 边界，避免 zone 命中 zone_connect）。 */
function blocks(text, tag) {
    const out = [];
    const opener = new RegExp("\\(" + tag + "\\b", "gu");
    let hit = opener.exec(text);
    while (hit !== null) {
        let depth = 0;
        let quote = false;
        let end = -1;
        for (let i = hit.index; i < text.length; i += 1) {
            const ch = text[i];
            if (ch === '"') {
                quote = !quote;
                continue;
            }
            if (quote)
                continue;
            if (ch === "(")
                depth += 1;
            else if (ch === ")") {
                depth -= 1;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end < 0)
            break;
        out.push(text.slice(hit.index, end + 1));
        opener.lastIndex = end + 1;
        hit = opener.exec(text);
    }
    return out;
}
function pointsOf(text) {
    const points = [];
    const re = /\(xy\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/gu;
    let hit = re.exec(text);
    while (hit !== null) {
        points.push({ x: Number(hit[1]), y: Number(hit[2]) });
        hit = re.exec(text);
    }
    return points;
}
function parseBoard(text) {
    const copper = coverageOf(text).layers.map((layer) => layer.name);
    const netNames = new Map();
    for (const block of blocks(text, "net")) {
        const hit = /\(net\s+(\d+)\s+"([^"]*)"\)/u.exec(block);
        if (hit !== null && hit[1] !== undefined && hit[2] !== undefined)
            netNames.set(hit[1], hit[2]);
    }
    const netOf = (block) => {
        const raw = idOf(block);
        return /^\d+$/u.test(raw) ? netNames.get(raw) ?? raw : raw;
    };
    const planes = [];
    for (const zone of blocks(text, "zone")) {
        const layer = quoted(zone, "layer");
        if (!layer.endsWith(".Cu"))
            continue;
        const net = netOf(zone);
        // 只认铺铜；keepout 与规则区不是参考面。
        const polygons = [];
        for (const filled of blocks(zone, "filled_polygon")) {
            const points = pointsOf(filled);
            if (points.length >= 3)
                polygons.push(points);
        }
        if (polygons.length === 0)
            continue;
        planes.push({ layer, net, polygons });
    }
    const segments = [];
    for (const segment of blocks(text, "segment")) {
        const layer = quoted(segment, "layer");
        if (!layer.endsWith(".Cu"))
            continue;
        const start = numbers(segment, "start");
        const end = numbers(segment, "end");
        const sx = start[0];
        const sy = start[1];
        const ex = end[0];
        const ey = end[1];
        if (sx === undefined || sy === undefined || ex === undefined || ey === undefined)
            continue;
        segments.push({ x1: sx, y1: sy, x2: ex, y2: ey, layer, net: netOf(segment) });
    }
    const vias = [];
    for (const via of blocks(text, "via")) {
        const at = numbers(via, "at");
        const vx = at[0];
        const vy = at[1];
        if (vx === undefined || vy === undefined)
            continue;
        vias.push({ x: vx, y: vy, net: netOf(via) });
    }
    return { copper, planes, segments, vias };
}
/** 点在多边形内（射线法；边界上算在内，这样「贴着边」不会被当成缺口）。 */
export function inside(polygon, point) {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i];
        const b = polygon[j];
        if (a === undefined || b === undefined)
            continue;
        if (onEdge(a, b, point))
            return true;
        const crosses = a.y > point.y !== b.y > point.y;
        if (!crosses)
            continue;
        const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (point.x < x)
            result = !result;
    }
    return result;
}
function onEdge(a, b, point) {
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) > 1e-6)
        return false;
    const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
    if (dot < 0)
        return false;
    const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    return dot <= length;
}
/** 点到多边形边界的最近距离（不在多边形内时是「离最近的铜边多远」，在内时同理）。 */
export function distanceToPolygon(polygon, point) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[j];
        const b = polygon[i];
        if (a === undefined || b === undefined)
            continue;
        best = Math.min(best, distanceToSegment(a, b, point));
    }
    return best;
}
function distanceToSegment(a, b, point) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    if (length === 0)
        return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
function covered(plane, point) {
    return plane.polygons.some((polygon) => inside(polygon, point));
}
function adjacentPlanes(parsed, layer) {
    const index = parsed.copper.indexOf(layer);
    if (index < 0)
        return [];
    const planes = parsed.planes.filter((plane) => plane.layer !== layer);
    // 只看相邻的两层：跨两层的参考面在常规叠层里不存在（板厚远大于回流扩散半径）。
    return planes.filter((plane) => Math.abs(parsed.copper.indexOf(plane.layer) - index) === 1);
}
/** 走线两端与中点在相邻平面层上是否都被铜盖住；一个平面层盖住三点就算有回流路径。 */
export function analyzeReference(text, options = {}) {
    const parsed = parseBoard(text);
    if (parsed.copper.length === 0) {
        return { ...EMPTY_REFERENCE, error: "没有读到铜层表：先确认 .kicad_pcb 完整" };
    }
    const findings = [];
    const notes = [];
    const trackNearMm = options.trackNearMm ?? 0.3;
    const viaNearMinMm = options.viaNearMinMm ?? 0.2;
    const viaNearMaxMm = options.viaNearMaxMm ?? 0.6;
    if (parsed.planes.length === 0) {
        notes.push("没有已填充的铺铜平面层：这块板只靠走线回流，双向参考面无从判起。");
    }
    let checked = 0;
    let gaps = 0;
    let trackNearEdges = 0;
    for (const segment of parsed.segments) {
        if (POWER.test(segment.net))
            continue;
        const planes = adjacentPlanes(parsed, segment.layer);
        if (planes.length === 0)
            continue;
        checked += 1;
        const mid = { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 };
        // 沿线取五个点：只看两端会漏掉中段穿洞，只看中点会漏掉端点出界。
        const probes = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
            x: segment.x1 + (segment.x2 - segment.x1) * ratio,
            y: segment.y1 + (segment.y2 - segment.y1) * ratio,
        }));
        const coverage = planes.reduce((best, plane) => Math.max(best, probes.filter((point) => covered(plane, point)).length / probes.length), 0);
        const hasPath = coverage === 1;
        if (!hasPath && coverage >= 0.6) {
            // 大半在平面上、只擦过缺口：回流还能绕，记 info，不当告警。
            findings.push({
                id: "reference.partial-gap",
                severity: "info",
                message: "走线 " + (segment.net === "" ? "（未命名网络）" : "[" + segment.net + "]") + " 在 " + segment.layer
                    + " 上擦过参考面缺口（沿线 " + String(Math.round(coverage * 100)) + "% 有平面覆盖）",
                fix: "缺口处补铺铜或缝合过孔；这条线的回流还能绕，但余量变少。",
                net: segment.net,
                at: mid,
            });
            continue;
        }
        if (!hasPath) {
            gaps += 1;
            findings.push({
                id: "reference.gap",
                severity: "warning",
                message: "走线 " + (segment.net === "" ? "（未命名网络）" : "[" + segment.net + "]") + " 在 " + segment.layer + " 上跨出参考面："
                    + "相邻平面层盖不住这条线的两端与中点，回流只能绕远",
                fix: "要么把这条线移回平面覆盖范围内，要么在缺口处补一小片铺铜/缝合过孔，或把这条线换到有完整参考面的层。",
                net: segment.net,
                at: mid,
            });
            continue;
        }
        // 贴着平面边界走：回流通道被挤窄，但不一定断——记 info。
        const nearest = Math.min(...planes.flatMap((plane) => plane.polygons.map((polygon) => distanceToPolygon(polygon, mid))));
        if (Number.isFinite(nearest) && nearest < trackNearMm) {
            trackNearEdges += 1;
            findings.push({
                id: "reference.track-near-edge",
                severity: "info",
                message: "走线 " + (segment.net === "" ? "（未命名网络）" : "[" + segment.net + "]") + " 离平面铺铜边界只有 "
                    + nearest.toFixed(2) + " mm：回流路径在这里变窄",
                fix: "把线往平面中心挪一点，或在边界外侧补缝合过孔。",
                net: segment.net,
                at: mid,
            });
        }
    }
    let viaNearEdges = 0;
    for (const via of parsed.vias) {
        if (POWER.test(via.net))
            continue;
        for (const plane of parsed.planes) {
            for (const polygon of plane.polygons) {
                if (!inside(polygon, via))
                    continue;
                const distance = distanceToPolygon(polygon, via);
                if (distance >= viaNearMinMm && distance <= viaNearMaxMm) {
                    viaNearEdges += 1;
                    findings.push({
                        id: "reference.via-near-edge",
                        severity: "info",
                        message: "过孔 " + (via.net === "" ? "（未命名网络）" : "[" + via.net + "]") + " 离 " + plane.layer
                            + " 的铺铜边界 " + distance.toFixed(2) + " mm：孔环与平面之间只剩一条窄缝",
                        fix: "把过孔往平面中心挪，或在该处补缝合过孔把窄缝填上。",
                        net: via.net,
                        at: { x: via.x, y: via.y },
                    });
                }
            }
        }
    }
    if (checked === 0 && parsed.planes.length > 0) {
        notes.push("没有需要复核的信号走线：要么只有电源网，要么外层没有走线。");
    }
    if (gaps >= 20)
        notes.push("缺口 " + String(gaps) + " 处：多数是铺铜没铺满整板造成的局部缺口，逐条列在下面，按告警处理。");
    notes.push("只按相邻铜层判参考面；跨两层的回流路径在常规叠层里不存在。");
    notes.push("贴边与过孔近边都记 info：它们影响回流余量，但本身不构成断路。");
    return {
        // 判定口径：跨出参考面的走线（warning）就是 0 条才算过；贴边类只记 info，不影响 ok。
        ok: gaps === 0,
        error: "",
        boardFile: "",
        planes: parsed.planes.map((plane) => ({ layer: plane.layer, net: plane.net, polygons: plane.polygons.length })),
        stats: {
            segments: parsed.segments.length,
            checked,
            gaps,
            viaNearEdges,
            trackNearEdges,
        },
        findings,
        notes,
    };
}
/** 读板子再复核；文件读不到时给出原因而不是空报告。 */
export function readReference(boardFile, options = {}) {
    let text = "";
    try {
        text = readFileSync(boardFile, "utf8");
    }
    catch (error) {
        return { ...EMPTY_REFERENCE, boardFile, error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)) };
    }
    const report = analyzeReference(text, options);
    return { ...report, boardFile: report.ok ? boardFile : "" };
}
