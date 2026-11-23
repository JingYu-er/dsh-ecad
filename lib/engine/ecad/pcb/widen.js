import { readFileSync } from "node:fs";
import { distanceToPolygon, inside } from "./reference.js";
import { parsePcbScene } from "./scene.js";
export const EMPTY_WIDEN = {
    ok: false,
    error: "",
    boardFile: "",
    targetMm: 0.2,
    clearanceMm: 0.2,
    thin: 0,
    widened: [],
    blocked: [],
    notes: [],
};
const EPS = 0.001;
/** 两条线段之间的最短距离：不采样，算精确值（采样会在最近点落在两次采样之间时误判）。 */
function segmentDistance(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    if (segmentsCross(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2))
        return 0;
    return Math.min(pointToSegment(ax1, ay1, bx1, by1, bx2, by2), pointToSegment(ax2, ay2, bx1, by1, bx2, by2), pointToSegment(bx1, by1, ax1, ay1, ax2, ay2), pointToSegment(bx2, by2, ax1, ay1, ax2, ay2));
}
function pointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length2 = dx * dx + dy * dy;
    if (length2 === 0)
        return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / length2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function segmentsCross(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const orientation = (px, py, qx, qy, rx, ry) => {
        const value = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
        if (Math.abs(value) < 1e-9)
            return 0;
        return value > 0 ? 1 : 2;
    };
    const o1 = orientation(ax1, ay1, ax2, ay2, bx1, by1);
    const o2 = orientation(ax1, ay1, ax2, ay2, bx2, by2);
    const o3 = orientation(bx1, by1, bx2, by2, ax1, ay1);
    const o4 = orientation(bx1, by1, bx2, by2, ax2, ay2);
    return o1 !== o2 && o3 !== o4;
}
function padRect(pad) {
    // 旋转只影响非 90° 整数倍的封装；这类焊盘按外接矩形保守判（宁可不加宽）。
    const halfWidth = pad.width / 2;
    const halfHeight = pad.height / 2;
    const angle = ((pad.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const spanX = halfWidth * cos + halfHeight * sin;
    const spanY = halfWidth * sin + halfHeight * cos;
    return { x0: pad.x - spanX, y0: pad.y - spanY, x1: pad.x + spanX, y1: pad.y + spanY };
}
function padDistance(track, pad) {
    const rect = padRect(pad);
    if (
    // 线段整段落在焊盘内部
    track.x1 >= rect.x0 && track.x1 <= rect.x1 && track.y1 >= rect.y0 && track.y1 <= rect.y1
        && track.x2 >= rect.x0 && track.x2 <= rect.x1 && track.y2 >= rect.y0 && track.y2 <= rect.y1) {
        return 0;
    }
    const corners = [
        [rect.x0, rect.y0],
        [rect.x1, rect.y0],
        [rect.x1, rect.y1],
        [rect.x0, rect.y1],
    ];
    let best = Math.min(pointToSegment(rect.x0, rect.y0, track.x1, track.y1, track.x2, track.y2), pointToSegment(rect.x1, rect.y0, track.x1, track.y1, track.x2, track.y2), pointToSegment(rect.x1, rect.y1, track.x1, track.y1, track.x2, track.y2), pointToSegment(rect.x0, rect.y1, track.x1, track.y1, track.x2, track.y2), pointToSegment(track.x1, track.y1, rect.x0, rect.y0, rect.x1, rect.y0));
    best = Math.min(best, pointToSegment(track.x1, track.y1, rect.x1, rect.y0, rect.x1, rect.y1), pointToSegment(track.x1, track.y1, rect.x1, rect.y1, rect.x0, rect.y1), pointToSegment(track.x1, track.y1, rect.x0, rect.y1, rect.x0, rect.y0), pointToSegment(track.x2, track.y2, rect.x0, rect.y0, rect.x1, rect.y0), pointToSegment(track.x2, track.y2, rect.x1, rect.y0, rect.x1, rect.y1), pointToSegment(track.x2, track.y2, rect.x1, rect.y1, rect.x0, rect.y1), pointToSegment(track.x2, track.y2, rect.x0, rect.y1, rect.x0, rect.y0));
    // 焊盘边与线段相交
    for (let index = 0; index < corners.length; index += 1) {
        const a = corners[index];
        const b = corners[(index + 1) % corners.length];
        if (segmentsCross(track.x1, track.y1, track.x2, track.y2, a[0], a[1], b[0], b[1]))
            return 0;
    }
    return best;
}
/** 把已填充的铺铜当障碍：加宽后的走线要离铺铜边界还有间距（DRC 的 clearance 会算这一条）。 */
function readZones(text) {
    const zones = [];
    const pattern = /\(zone\b/gu;
    let match = pattern.exec(text);
    while (match !== null) {
        const start = match.index;
        let depth = 0;
        let index = start;
        let closed = -1;
        while (index < text.length) {
            const char = text[index];
            if (char === '"') {
                index += 1;
                while (index < text.length && text[index] !== '"')
                    index += 1;
            }
            else if (char === "(")
                depth += 1;
            else if (char === ")") {
                depth -= 1;
                if (depth === 0) {
                    closed = index;
                    break;
                }
            }
            index += 1;
        }
        if (closed < 0)
            break;
        const block = text.slice(start, closed + 1);
        const layer = /\(layer\s+"?([^")]+)"?\)/u.exec(block);
        const net = /\(net\s+(?:(\d+)(?:\s+"([^"]*)")?|"([^"]*)")\)/u.exec(block);
        const netName = net === null ? "" : (net[4] ?? net[3] ?? "");
        const filled = block.indexOf("(filled_polygon");
        if (layer !== null && filled >= 0) {
            const tail = block.slice(filled);
            const points = [];
            const xy = /\(xy\s+([-\d.]+)\s+([-\d.]+)\)/gu;
            let point = xy.exec(tail);
            while (point !== null) {
                points.push({ x: Number(point[1]), y: Number(point[2]) });
                point = xy.exec(tail);
            }
            if (points.length >= 3)
                zones.push({ layer: layer[1] ?? "", net: netName, polygon: points });
        }
        pattern.lastIndex = closed + 1;
        match = pattern.exec(text);
    }
    return zones;
}
function zoneBlocking(track, half, zones, clearanceMm) {
    const layer = track.side === "bottom" ? "B.Cu" : "F.Cu";
    for (const zone of zones) {
        if (zone.layer !== layer)
            continue;
        if (zone.net !== "" && zone.net === track.net)
            continue;
        const samples = [0, 0.25, 0.5, 0.75, 1];
        for (const ratio of samples) {
            const px = track.x1 + (track.x2 - track.x1) * ratio;
            const py = track.y1 + (track.y2 - track.y1) * ratio;
            const point = { x: px, y: py };
            // 线段落在铺铜里，或离边界不足
            if (inside(zone.polygon, point) || distanceToPolygon(zone.polygon, point) - half < clearanceMm)
                return true;
        }
    }
    return false;
}
function sameNet(a, b) {
    return a !== "" && a === b;
}
function blocking(track, half, tracks, pads, vias, zones, clearanceMm) {
    for (const other of tracks) {
        if (other === track || other.side !== track.side || sameNet(other.net, track.net))
            continue;
        const distance = segmentDistance(track.x1, track.y1, track.x2, track.y2, other.x1, other.y1, other.x2, other.y2);
        if (distance - half - other.width / 2 < clearanceMm)
            return "track";
    }
    for (const pad of pads) {
        if (pad.side !== track.side || sameNet(pad.net, track.net))
            continue;
        if (padDistance(track, pad) - half < clearanceMm)
            return "pad";
    }
    if (zoneBlocking(track, half, zones, clearanceMm))
        return "zone";
    for (const via of vias) {
        if (sameNet(via.net, track.net))
            continue;
        const distance = pointToSegment(via.x, via.y, track.x1, track.y1, track.x2, track.y2);
        if (distance - half - (via.drill ?? 0.3) / 2 < clearanceMm)
            return "via";
    }
    return "";
}
/**
 * 加宽计划：把细于目标宽度的走线尽量加宽，只加宽「几何上确实还有空间」的那些。
 *
 * 这不是让布线器按 0.2 mm 布线（引擎内部仍按工艺下限降档），而是事后把降档出来的
 * 细段补回来——补不回来的（多在焊盘出口）如实列成 blocked，不偷偷放宽判据。
 */
export function planWiden(text, options = {}) {
    const targetMm = options.targetMm ?? 0.2;
    const clearanceMm = options.clearanceMm ?? 0.2;
    if (text.trim() === "")
        return { ...EMPTY_WIDEN, error: "板子文件是空的", targetMm, clearanceMm };
    const scene = parsePcbScene(text, "widen");
    const tracks = scene.tracks;
    const pads = scene.pads;
    const vias = scene.vias;
    const zones = readZones(text);
    const widened = [];
    const blocked = [];
    let thin = 0;
    for (const track of tracks) {
        if (track.width >= targetMm - EPS)
            continue;
        thin += 1;
        const reason = blocking(track, targetMm / 2, tracks, pads, vias, zones, clearanceMm);
        if (reason === "") {
            widened.push({
                x1: track.x1,
                y1: track.y1,
                x2: track.x2,
                y2: track.y2,
                side: track.side,
                net: track.net,
                fromMm: track.width,
                toMm: targetMm,
            });
        }
        else {
            blocked.push({ x1: track.x1, y1: track.y1, side: track.side, net: track.net, widthMm: track.width, reason });
        }
    }
    const notes = [];
    if (thin === 0)
        notes.push("这条板子上没有细于 " + String(targetMm) + " mm 的走线：不需要加宽。");
    if (blocked.length > 0) {
        const byPad = blocked.filter((item) => item.reason === "pad").length;
        const byZone = blocked.filter((item) => item.reason === "zone").length;
        notes.push("有 " + String(blocked.length) + " 段加宽后会和别的东西挤在一起（" + String(byPad) + " 段卡在焊盘出口，" + String(byZone) + " 段离铺铜太近）：这些保持原宽，按工艺下限交付。");
    }
    notes.push("判据按「目标半宽 + " + String(clearanceMm) + " mm 间距」算，线段距离是精确值；旋转焊盘按外接矩形保守判；已填充铺铜也当障碍。");
    return {
        ok: true,
        error: "",
        boardFile: "",
        targetMm,
        clearanceMm,
        thin,
        widened,
        blocked,
        notes,
    };
}
/**
 * 把计划写回板子文本：按 `(segment …)` 出现顺序匹配坐标与旧宽度，
 * 只改 `(width …)` 这一个数值。对不上就跳过并计数，不猜。
 */
export function applyWiden(text, plan) {
    const wanted = new Map();
    for (const item of plan.widened) {
        wanted.set(keyOf(item.x1, item.y1, item.x2, item.y2, item.side, item.fromMm), item);
    }
    let applied = 0;
    let missed = 0;
    const pattern = /\(segment\b/gu;
    const out = [];
    let cursor = 0;
    let match = pattern.exec(text);
    while (match !== null) {
        const start = match.index;
        let depth = 0;
        let index = start;
        let closed = -1;
        while (index < text.length) {
            const char = text[index];
            if (char === '"') {
                index += 1;
                while (index < text.length && text[index] !== '"')
                    index += 1;
            }
            else if (char === "(")
                depth += 1;
            else if (char === ")") {
                depth -= 1;
                if (depth === 0) {
                    closed = index;
                    break;
                }
            }
            index += 1;
        }
        if (closed < 0)
            break;
        const block = text.slice(start, closed + 1);
        const startPoint = /\(start\s+([-\d.]+)\s+([-\d.]+)\)/u.exec(block);
        const endPoint = /\(end\s+([-\d.]+)\s+([-\d.]+)\)/u.exec(block);
        const width = /\(width\s+([-\d.]+)\)/u.exec(block);
        const layer = /\(layer\s+"?([^")]+)"?\)/u.exec(block);
        if (startPoint !== null && endPoint !== null && width !== null) {
            const side = (layer?.[1] ?? "F.Cu").startsWith("B") ? "bottom" : "top";
            const key = keyOf(Number(startPoint[1]), Number(startPoint[2]), Number(endPoint[1]), Number(endPoint[2]), side, Number(width[1]));
            const item = wanted.get(key);
            if (item !== undefined) {
                const replaced = block.replace(/\(width\s+[-\d.]+\)/u, "(width " + item.toMm.toFixed(3) + ")");
                out.push(text.slice(cursor, start), replaced);
                cursor = closed + 1;
                applied += 1;
            }
        }
        pattern.lastIndex = closed + 1;
        match = pattern.exec(text);
    }
    out.push(text.slice(cursor));
    return { text: out.join(""), applied, missed };
}
function keyOf(x1, y1, x2, y2, side, width) {
    const round = (value) => value.toFixed(3);
    // 端点写反不算另一条线：按字典序归一化。
    const forward = round(x1) + "," + round(y1) + ">" + round(x2) + "," + round(y2);
    const backward = round(x2) + "," + round(y2) + ">" + round(x1) + "," + round(y1);
    return (forward < backward ? forward : backward) + "|" + side + "|" + round(width);
}
export function readWiden(boardFile, options = {}) {
    let text = "";
    try {
        text = readFileSync(boardFile, "utf8");
    }
    catch (error) {
        return { ...EMPTY_WIDEN, boardFile, error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)) };
    }
    return { ...planWiden(text, options), boardFile };
}
