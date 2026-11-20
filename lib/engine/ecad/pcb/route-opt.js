const EPS = 1e-6;
function len(segment) {
    return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}
function angleDeg(segment) {
    const degrees = (Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1) * 180) / Math.PI;
    return degrees < 0 ? degrees + 360 : degrees;
}
function distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
}
/** 最近的 45° 整数倍与偏离量。 */
function nearestLegal(degrees) {
    const target = Math.round(degrees / 45) * 45;
    let delta = Math.abs(degrees - target);
    if (delta > 180)
        delta = 360 - delta;
    return { target: target % 360, delta };
}
function withEnd(segment, x, y) {
    return { ...segment, x2: x, y2: y };
}
/**
 * 把一段任意角度的线拆成「正交段 + 45° 段」，两端点不动。
 * 角度落在第一/三象限时先走水平，第二/四象限先走垂直——这样拐点更少。
 */
function splitTo45(segment) {
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    if (Math.abs(dx) < EPS || Math.abs(dy) < EPS)
        return null;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const corner = horizontal
        ? { x: segment.x2 - Math.sign(dx) * Math.abs(dy), y: segment.y1 }
        : { x: segment.x1, y: segment.y2 - Math.sign(dy) * Math.abs(dx) };
    if (distance(corner.x, corner.y, segment.x1, segment.y1) < EPS)
        return null;
    if (distance(corner.x, corner.y, segment.x2, segment.y2) < EPS)
        return null;
    return [withEnd(segment, corner.x, corner.y), { ...segment, x1: corner.x, y1: corner.y }];
}
/** 吸附到最近的 45° 方向，长度不变（起点不动）。 */
function snapTo45(segment, target) {
    const radians = (target * Math.PI) / 180;
    const length = len(segment);
    return withEnd(segment, segment.x1 + Math.cos(radians) * length, segment.y1 + Math.sin(radians) * length);
}
function legalize(segments, tolerance) {
    const out = [];
    let split = 0;
    let snapped = 0;
    for (const segment of segments) {
        const { target, delta } = nearestLegal(angleDeg(segment));
        if (delta <= tolerance) {
            out.push(delta < EPS ? segment : snapTo45(segment, target));
            if (delta >= EPS)
                snapped += 1;
            continue;
        }
        const halves = splitTo45(segment);
        if (halves === null) {
            out.push(segment);
            continue;
        }
        split += 1;
        out.push(halves[0], halves[1]);
    }
    return { segments: out, split, snapped };
}
function sameDirection(a, b) {
    const ax = a.x2 - a.x1;
    const ay = a.y2 - a.y1;
    const bx = b.x2 - b.x1;
    const by = b.y2 - b.y1;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    return Math.abs(cross) < 1e-4 * (Math.hypot(ax, ay) * Math.hypot(bx, by) + EPS) && dot > 0;
}
/** 同网络同层同宽度、首尾相接且方向一致 → 合并。 */
function merge(segments, snap) {
    const groups = new Map();
    for (const segment of segments) {
        const key = segment.net + "|" + segment.layer + "|" + segment.widthMm.toFixed(4);
        const list = groups.get(key);
        if (list === undefined)
            groups.set(key, [segment]);
        else
            list.push(segment);
    }
    const out = [];
    let merged = 0;
    for (const list of groups.values()) {
        const remaining = list.slice();
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < remaining.length; i += 1) {
                if (remaining[i] === null)
                    continue;
                const a = remaining[i];
                for (let j = i + 1; j < remaining.length; j += 1) {
                    if (remaining[j] === null)
                        continue;
                    const b = remaining[j];
                    const joinA = distance(a.x2, a.y2, b.x1, b.y1) <= snap;
                    const joinB = distance(b.x2, b.y2, a.x1, a.y1) <= snap;
                    if ((!joinA && !joinB) || !sameDirection(a, b))
                        continue;
                    const first = joinA ? a : b;
                    const second = joinA ? b : a;
                    const union = { ...first, x2: second.x2, y2: second.y2 };
                    remaining[i] = union;
                    remaining[j] = null;
                    merged += 1;
                    changed = true;
                    break;
                }
                if (changed)
                    break;
            }
        }
        for (const segment of remaining)
            if (segment !== null)
                out.push(segment);
    }
    return { segments: out, merged };
}
function cleanVias(segments, vias, snap) {
    const keep = [];
    let dropped = 0;
    for (const via of vias) {
        const touched = segments.some((segment) => segment.net === via.net &&
            (distance(segment.x1, segment.y1, via.x, via.y) <= snap || distance(segment.x2, segment.y2, via.x, via.y) <= snap));
        if (touched)
            keep.push(via);
        else
            dropped += 1;
    }
    return { vias: keep, dropped };
}
export function optimizeRoutes(segments, vias, options = {}) {
    const tolerance = options.angleToleranceDeg ?? 2.5;
    const minSegment = options.minSegmentMm ?? 0.05;
    const snap = options.snapMm ?? 0.01;
    const notes = [];
    const solid = segments.filter((segment) => len(segment) >= minSegment);
    const dropped = segments.length - solid.length;
    if (dropped > 0)
        notes.push("丢掉 " + String(dropped) + " 段过短的线（< " + String(minSegment) + " mm）");
    const legal = legalize(solid, tolerance);
    if (legal.split > 0)
        notes.push("把 " + String(legal.split) + " 段斜线拆成正交段 + 45° 段");
    if (legal.snapped > 0)
        notes.push("把 " + String(legal.snapped) + " 段吸附到 45° 方向");
    const mergedResult = merge(legal.segments, snap);
    if (mergedResult.merged > 0)
        notes.push("合并了 " + String(mergedResult.merged) + " 段共线走线");
    const viaResult = cleanVias(mergedResult.segments, vias, snap);
    if (viaResult.dropped > 0)
        notes.push("删掉 " + String(viaResult.dropped) + " 个两端都不接线的过孔");
    let total = 0;
    let diagonal = 0;
    for (const segment of mergedResult.segments) {
        const weight = len(segment);
        total += weight;
        if (Math.abs((angleDeg(segment) % 90) - 45) <= 1)
            diagonal += weight;
    }
    const diagonalRatio = total < EPS ? 0 : diagonal / total;
    return {
        segments: mergedResult.segments,
        vias: viaResult.vias,
        split: legal.split,
        snapped: legal.snapped,
        merged: mergedResult.merged,
        dropped,
        viasDropped: viaResult.dropped,
        diagonalRatio,
        notes,
    };
}
