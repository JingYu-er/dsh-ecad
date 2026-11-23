import { readFileSync } from "node:fs";
import { parsePcbScene } from "./scene.js";
export const EMPTY_ESCAPE = {
    ok: false,
    error: "",
    boardFile: "",
    stubMm: 0,
    clearanceMm: 0,
    stubs: [],
    skipped: [],
    notes: [],
};
function numbersOf(options) {
    return {
        stubMm: options.stubMm ?? 0.8,
        widthMm: options.widthMm ?? 0.2,
        clearanceMm: options.clearanceMm ?? 0.2,
    };
}
/** 焊盘长轴方向：长边指向外，短边是宽度。跟着封装旋转走。 */
function longAxis(pad) {
    const angle = (pad.rotation * Math.PI) / 180;
    const alongX = pad.width >= pad.height;
    const long = alongX ? pad.width : pad.height;
    const short = alongX ? pad.height : pad.width;
    const baseX = alongX ? 1 : 0;
    const baseY = alongX ? 0 : 1;
    return {
        dx: baseX * Math.cos(angle) - baseY * Math.sin(angle),
        dy: baseX * Math.sin(angle) + baseY * Math.cos(angle),
        halfLong: long / 2,
        halfShort: short / 2,
    };
}
function distancePointSegment(point, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 1e-12)
        return Math.hypot(point.x - ax, point.y - ay);
    let t = ((point.x - ax) * dx + (point.y - ay) * dy) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy));
}
function insidePad(pad, point, slop) {
    const angle = (-pad.rotation * Math.PI) / 180;
    const dx = point.x - pad.x;
    const dy = point.y - pad.y;
    const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
    const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
    return Math.abs(localX) <= pad.width / 2 + slop && Math.abs(localY) <= pad.height / 2 + slop;
}
/** 与其它网络的对象是否靠得太近：短段两端与中点各查一次，够保守。 */
function blocked(scene, stub, from, to, clearanceMm) {
    const half = stub.widthMm / 2 + clearanceMm;
    const samples = [
        from,
        { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        to,
    ];
    for (const track of scene.tracks) {
        if (track.net === stub.net)
            continue;
        if (track.side !== stub.side)
            continue;
        for (const point of samples) {
            if (distancePointSegment(point, track.x1, track.y1, track.x2, track.y2) < half + track.width / 2) {
                return "走线（" + (track.net === "" ? "未命名" : track.net) + "）太近";
            }
        }
    }
    for (const via of scene.vias) {
        if (via.net === stub.net)
            continue;
        for (const point of samples) {
            if (Math.hypot(point.x - via.x, point.y - via.y) < half + via.size / 2) {
                return "过孔（" + (via.net === "" ? "未命名" : via.net) + "）太近";
            }
        }
    }
    for (const pad of scene.pads) {
        if (pad.net === stub.net)
            continue;
        if (pad.side !== stub.side)
            continue;
        if (insidePad(pad, to, half) || insidePad(pad, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, half)) {
            return "焊盘 " + pad.ref + "." + pad.number + " 太近";
        }
    }
    return "";
}
/** 沿长轴往外的逃逸短段。返回 null 表示这颗焊盘不适合铺。 */
function planOne(scene, pad, numbers) {
    const skip = (reason) => ({ ref: pad.ref, pad: pad.number, net: pad.net, reason });
    if (pad.net === "")
        return skip("没有网络");
    if (pad.shape === "circle" && pad.width !== pad.height)
        return skip("孔壁焊盘，先不铺");
    const axis = longAxis(pad);
    if (axis.halfLong < 0.15)
        return skip("焊盘太短，铺不下短段");
    const widthMm = Math.min(numbers.widthMm, axis.halfShort * 1.6);
    const from = {
        x: pad.x + axis.dx * axis.halfLong,
        y: pad.y + axis.dy * axis.halfLong,
    };
    const to = {
        x: pad.x + axis.dx * (axis.halfLong + numbers.stubMm),
        y: pad.y + axis.dy * (axis.halfLong + numbers.stubMm),
    };
    const why = blocked(scene, { net: pad.net, side: pad.side, widthMm }, from, to, numbers.clearanceMm);
    if (why !== "")
        return skip(why);
    return { ref: pad.ref, pad: pad.number, net: pad.net, side: pad.side, from, to, widthMm };
}
/** 板子顶层有没有 `(net <id> "NAME")` 声明表：有就写编号，没有就写内联名字。 */
function declaredNets(text) {
    const map = new Map();
    for (const hit of text.matchAll(/^[ \t]*\(net (\d+) "([^"]*)"\)[ \t]*$/gmu)) {
        map.set(hit[2], Number(hit[1]));
    }
    return map;
}
export function planEscapes(text, options = {}) {
    const numbers = numbersOf(options);
    const scene = parsePcbScene(text, "escape");
    if (scene.pads.length === 0) {
        return { ...EMPTY_ESCAPE, ok: false, error: "板子里没有读到一个焊盘", stubMm: numbers.stubMm, clearanceMm: numbers.clearanceMm };
    }
    const stubs = [];
    const skipped = [];
    const seen = new Set();
    for (const pad of scene.pads) {
        const key = pad.ref + "." + pad.number;
        if (seen.has(key))
            continue;
        seen.add(key);
        const planned = planOne(scene, pad, numbers);
        if ("reason" in planned)
            skipped.push(planned);
        else
            stubs.push(planned);
    }
    const notes = [
        "短段从焊盘长轴外侧 " + String(numbers.stubMm) + " mm 处铺出，宽度 " + String(numbers.widthMm) + " mm；只铺给有网络、且周围有空间的 SMD 焊盘。",
        "布线器会把同网铜当既有铜，从短段末端开始布——这是「先直出再转弯」落到几何上的办法。",
    ];
    if (skipped.length > 0) {
        notes.push("有 " + String(skipped.length) + " 颗焊盘没铺：" + skipped.slice(0, 3).map((item) => item.ref + "." + item.pad + " " + item.reason).join("；"));
    }
    return { ok: true, error: "", boardFile: "", stubMm: numbers.stubMm, clearanceMm: numbers.clearanceMm, stubs, skipped, notes };
}
export function applyEscapes(text, plan) {
    if (!plan.ok || plan.stubs.length === 0)
        return { text, added: 0 };
    const declared = declaredNets(text);
    const lines = plan.stubs.map((stub) => {
        const id = declared.get(stub.net);
        const net = id === undefined ? '(net "' + stub.net + '")' : "(net " + String(id) + ")";
        return ("  (segment (start " +
            String(Math.round(stub.from.x * 1000) / 1000) +
            " " +
            String(Math.round(stub.from.y * 1000) / 1000) +
            ") (end " +
            String(Math.round(stub.to.x * 1000) / 1000) +
            " " +
            String(Math.round(stub.to.y * 1000) / 1000) +
            ") (width " +
            String(stub.widthMm) +
            ') (layer "' +
            (stub.side === "top" ? "F.Cu" : "B.Cu") +
            '") ' +
            net +
            ")");
    });
    const index = text.lastIndexOf(")");
    if (index < 0)
        return { text, added: 0 };
    return { text: text.slice(0, index) + lines.join("\n") + "\n" + text.slice(index), added: lines.length };
}
export function readEscapes(boardFile, options = {}) {
    try {
        const text = readFileSync(boardFile, "utf8");
        const plan = planEscapes(text, options);
        return { ...plan, boardFile };
    }
    catch (error) {
        return { ...EMPTY_ESCAPE, ok: false, error: error instanceof Error ? error.message : String(error), boardFile };
    }
}
