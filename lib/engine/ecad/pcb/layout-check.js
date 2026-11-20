// 布线前布局体检：在让布线器开工之前，先把「摆错了」的器件找出来。
//
// 这里只做能算出来的距离与位置关系到的事情：去耦电容离 IC 电源脚多远、晶振离主控多远、
// 接口是不是贴在板边、主控离板边留了多少、电源入口到大电流器件的路径有多长。
// 走线质量、层数、阻抗这些属于布线参数（fab-tier / krt-own），不在这里判。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parenBlocks } from "./emc.js";
export const DEFAULT_LAYOUT_OPTIONS = {
    decapMm: 5,
    decapErrorMm: 10,
    crystalMm: 12,
    connectorEdgeMm: 8,
    mcuEdgeMm: 2,
    powerEntryMm: 20,
};
export const EMPTY_LAYOUT = {
    ok: false,
    error: "",
    boardFile: "",
    box: null,
    widthMm: 0,
    heightMm: 0,
    mcu: "",
    parts: [],
    findings: [],
    notes: [],
};
const CONNECTOR_REF = /^(?:J|CN|P|USB)\d/iu;
const CAP_REF = /^C\d/iu;
const CRYSTAL_REF = /^[YX]\d/iu;
const PASSIVE_REF = /^(?:R|C|L|D|FB|TP|F)\d/iu;
const POWER_IN_NET = /^(?:VBUS|VIN|VBAT|VIN_?\d+|DC_IN)/iu;
const POWER_CHAIN_REF = /^(?:L|U|D)\d/iu;
const GROUND_NET = /^(?:GND|VSS|AGND|PGND|DGND)/iu;
// 电源网按「叶子名里的关键字」认：KiCad 网络常带图纸路径（/ADS1256/DVDD_3.3V），
// 而且命名自由度很大（DVDD_3.3V、+3V3、VCC_IO…），用前缀白名单必然漏。
const POWER_NET = /(?:VCC|VDD|VBUS|VIN|VBAT|V3V3|3V3|3\.3V|5V|12V|AVDD|DVDD)/iu;
/** 网络名的叶子：`/ADS1256/DVDD_3.3V` → `DVDD_3.3V`。 */
function leafName(net) {
    const index = net.lastIndexOf("/");
    return index < 0 ? net : net.slice(index + 1);
}
function first(text, pattern) {
    const match = pattern.exec(text);
    return match === null ? null : match[1];
}
function rotate(dx, dy, deg) {
    if (deg === 0)
        return { x: dx, y: dy };
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}
function distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
function boardBoxOf(text) {
    const xs = [];
    const ys = [];
    for (const block of parenBlocks(text, "gr_line")) {
        if (!block.includes("Edge.Cuts"))
            continue;
        const start = /\(start ([-\d.]+) ([-\d.]+)\)/u.exec(block);
        const end = /\(end ([-\d.]+) ([-\d.]+)\)/u.exec(block);
        if (start === null || end === null)
            continue;
        xs.push(Number(start[1]), Number(end[1]));
        ys.push(Number(start[2]), Number(end[2]));
    }
    for (const block of parenBlocks(text, "gr_rect")) {
        if (!block.includes("Edge.Cuts"))
            continue;
        const start = /\(start ([-\d.]+) ([-\d.]+)\)/u.exec(block);
        const end = /\(end ([-\d.]+) ([-\d.]+)\)/u.exec(block);
        if (start === null || end === null)
            continue;
        xs.push(Number(start[1]), Number(end[1]));
        ys.push(Number(start[2]), Number(end[2]));
    }
    if (xs.length === 0 || ys.length === 0)
        return null;
    return {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
    };
}
function partsOf(text) {
    const nets = new Map();
    for (const block of parenBlocks(text, "net")) {
        const match = /^\(net (\d+) "([^"]*)"\)$/u.exec(block.trim());
        if (match !== null)
            nets.set(match[1], match[2]);
    }
    const nameOf = (raw) => nets.get(raw) ?? "#" + raw;
    const parts = [];
    for (const block of parenBlocks(text, "footprint")) {
        const ref = first(block, /\(property "Reference" "([^"]+)"/u) ??
            first(block, /\(fp_text reference "([^"]+)"/u) ??
            "";
        if (ref === "")
            continue;
        const value = first(block, /\(property "Value" "([^"]+)"/u) ?? first(block, /\(fp_text value "([^"]+)"/u) ?? "";
        const at = /^[\s\S]*?\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/u.exec(block);
        if (at === null)
            continue;
        const fx = Number(at[1]);
        const fy = Number(at[2]);
        const fr = Number(at[3] ?? "0");
        const pads = [];
        for (const padBlock of parenBlocks(block, "pad")) {
            const number = first(padBlock, /^\(pad "([^"]*)"/u);
            // 两种写法都有：tscircuit 出来的板子写 `(net "GND")`，KiCad 自己存的是 `(net 13)`。
            const netMatch = /\(net (?:"([^"]*)"|(\d+))\)/u.exec(padBlock);
            const netRaw = netMatch === null ? null : (netMatch[1] ?? nameOf(netMatch[2]));
            const padAt = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/u.exec(padBlock);
            if (number === null || netRaw === null || padAt === null)
                continue;
            const point = rotate(Number(padAt[1]), Number(padAt[2]), fr);
            pads.push({ number, net: netRaw, x: fx + point.x, y: fy + point.y });
        }
        if (pads.length === 0)
            continue;
        const xs = pads.map((pad) => pad.x);
        const ys = pads.map((pad) => pad.y);
        parts.push({
            ref,
            value,
            pads,
            x: (Math.min(...xs) + Math.max(...xs)) / 2,
            y: (Math.min(...ys) + Math.max(...ys)) / 2,
            widthMm: Math.max(...xs) - Math.min(...xs),
            heightMm: Math.max(...ys) - Math.min(...ys),
        });
    }
    return parts;
}
function mcuOf(parts) {
    const named = parts.find((part) => /^U\d/u.test(part.ref) && part.pads.length >= 24);
    if (named !== undefined)
        return named;
    let best = null;
    for (const part of parts) {
        if (best === null || part.pads.length > best.pads.length)
            best = part;
    }
    return best !== null && best.pads.length >= 8 ? best : null;
}
/** 去耦电容：位号 C、只两个焊盘、一脚电源一脚地。 */
function isDecap(part) {
    if (!CAP_REF.test(part.ref) || part.pads.length !== 2)
        return false;
    const power = part.pads.some((pad) => POWER_NET.test(leafName(pad.net)));
    const ground = part.pads.some((pad) => GROUND_NET.test(leafName(pad.net)));
    return power && ground;
}
function checkDecaps(parts, mcu, options) {
    const findings = [];
    const targets = parts.filter((part) => !PASSIVE_REF.test(part.ref));
    for (const cap of parts.filter((part) => isDecap(part))) {
        const powerPad = cap.pads.find((pad) => POWER_NET.test(leafName(pad.net)));
        if (powerPad === undefined)
            continue;
        let nearest = null;
        for (const target of targets) {
            for (const pad of target.pads) {
                if (pad.net !== powerPad.net)
                    continue;
                const d = distance(cap.x, cap.y, pad.x, pad.y);
                if (nearest === null || d < nearest.distance)
                    nearest = { ref: target.ref, distance: d, pin: pad.number };
            }
        }
        if (nearest === null)
            continue;
        if (nearest.distance <= options.decapMm)
            continue;
        const severity = nearest.distance > options.decapErrorMm ? "error" : "warning";
        findings.push({
            id: "layout.decap-far",
            severity,
            message: `${cap.ref} 是 ${powerPad.net} 的去耦电容，离 ${nearest.ref} 的 ${powerPad.net} 脚（pin ${nearest.pin}）${round2(nearest.distance)} mm（目标 ≤ ${options.decapMm} mm）`,
            fix: "把去耦电容挪到该电源脚旁边，回流路径也就跟着短了；同时确认另一脚就近下地。",
            refs: [cap.ref, nearest.ref],
        });
    }
    if (mcu !== null && !findings.some((finding) => finding.refs.includes(mcu.ref))) {
        const mcuCaps = parts.filter((part) => isDecap(part) && part.pads.some((pad) => mcu.pads.some((mpad) => mpad.net === pad.net)));
        if (mcuCaps.length === 0) {
            findings.push({
                id: "layout.mcu-no-decap",
                severity: "warning",
                message: `${mcu.ref}（${mcu.pads.length} 脚）周围没有识别到去耦电容`,
                fix: "每个电源脚配一颗 100 nF，主电源再加一颗 1–10 µF；位置贴着引脚，不要靠布线兜。",
                refs: [mcu.ref],
            });
        }
    }
    return findings;
}
function checkCrystal(parts, mcu, options) {
    if (mcu === null)
        return [];
    const crystals = parts.filter((part) => {
        // 负载电容（18pf 之类）不算晶振：它们是晶振的邻居，不是晶振。
        if (CAP_REF.test(part.ref))
            return false;
        if (CRYSTAL_REF.test(part.ref))
            return true;
        if (/(?:MHz|kHz|晶振|crystal|resonator)/iu.test(part.value))
            return true;
        return part.pads.some((pad) => /(?:XTAL|OSC)/iu.test(leafName(pad.net)));
    });
    return crystals
        .map((part) => ({ part, d: distance(part.x, part.y, mcu.x, mcu.y) }))
        .filter((item) => item.d > options.crystalMm)
        .map((item) => ({
        id: "layout.crystal-far",
        severity: "warning",
        message: `${item.part.ref}（${item.part.value || "晶振"}）离 ${mcu.ref} ${round2(item.d)} mm（目标 ≤ ${options.crystalMm} mm）`,
        fix: "晶振与负载电容贴近主控 XIN/XOUT，走线短且包地；离得远会同时带来起振余量与 EMI 问题。",
        refs: [item.part.ref, mcu.ref],
    }));
}
function checkConnectors(parts, box, options) {
    if (box === null)
        return [];
    const findings = [];
    for (const part of parts.filter((item) => CONNECTOR_REF.test(item.ref))) {
        const edge = Math.min(part.x - box.x0, box.x1 - part.x, part.y - box.y0, box.y1 - part.y);
        if (edge <= options.connectorEdgeMm)
            continue;
        findings.push({
            id: "layout.connector-inside",
            severity: "info",
            message: `${part.ref}（${part.value || "连接器"}）中心离最近的板边 ${round2(edge)} mm（接口通常 ≤ ${options.connectorEdgeMm} mm）`,
            fix: "确认外壳开窗位置；如果确实要放中间（比如板内跳线），这条可以忽略。",
            refs: [part.ref],
        });
    }
    return findings;
}
function checkMcuEdge(mcu, box, options) {
    if (mcu === null || box === null)
        return [];
    const edge = Math.min(mcu.x - mcu.widthMm / 2 - box.x0, box.x1 - (mcu.x + mcu.widthMm / 2), mcu.y - mcu.heightMm / 2 - box.y0, box.y1 - (mcu.y + mcu.heightMm / 2));
    if (edge >= options.mcuEdgeMm)
        return [];
    return [
        {
            id: "layout.mcu-edge",
            severity: "warning",
            message: `${mcu.ref} 的焊盘离板边只有 ${round2(Math.max(0, edge))} mm（目标 ≥ ${options.mcuEdgeMm} mm）`,
            fix: "主控往板内挪一点：贴边会让四周走线没有空间，铣边公差也可能碰到焊盘。",
            refs: [mcu.ref],
        },
    ];
}
function checkPowerEntry(parts, options) {
    const findings = [];
    for (const part of parts) {
        const entry = part.pads.find((pad) => POWER_IN_NET.test(leafName(pad.net)));
        if (entry === undefined)
            continue;
        let nearest = null;
        for (const target of parts) {
            if (target.ref === part.ref)
                continue;
            if (!POWER_CHAIN_REF.test(target.ref) && !isDecap(target))
                continue;
            if (!target.pads.some((pad) => pad.net === entry.net))
                continue;
            const d = distance(part.x, part.y, target.x, target.y);
            if (nearest === null || d < nearest.distance)
                nearest = { ref: target.ref, distance: d };
        }
        if (nearest === null || nearest.distance <= options.powerEntryMm)
            continue;
        findings.push({
            id: "layout.power-entry-far",
            severity: "info",
            message: `${entry.net} 入口（${part.ref}）到最近的载流器件（${nearest.ref}）${round2(nearest.distance)} mm（目标 ≤ ${options.powerEntryMm} mm）`,
            fix: "大电流路径越短越好：把入口、保护器件与 DCDC/LDO 摆到一起，走线也就能加宽。",
            refs: [part.ref, nearest.ref],
        });
    }
    return findings;
}
export function analyzeLayout(text, boardFile, options = {}) {
    if (!text.includes("(kicad_pcb") || parenBlocks(text, "kicad_pcb").length === 0) {
        return { ...EMPTY_LAYOUT, boardFile, error: "没有找到完整的 (kicad_pcb 块，文件可能被截断" };
    }
    const resolved = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const parts = partsOf(text);
    if (parts.length === 0) {
        return { ...EMPTY_LAYOUT, boardFile, error: "板子里没有带网络的封装：先确认走线与网络都在" };
    }
    const box = boardBoxOf(text);
    const mcu = mcuOf(parts);
    const findings = [
        ...checkDecaps(parts, mcu, resolved),
        ...checkCrystal(parts, mcu, resolved),
        ...checkConnectors(parts, box, resolved),
        ...checkMcuEdge(mcu, box, resolved),
        ...checkPowerEntry(parts, resolved),
    ];
    const notes = [];
    if (box === null)
        notes.push("读不到板框（Edge.Cuts），接口与主控的贴边检查已跳过。");
    if (mcu === null)
        notes.push("认不出主控（没有 ≥24 脚的 U 件），晶振与主控贴边检查已跳过。");
    if (!parts.some((part) => isDecap(part)))
        notes.push("没有识别到去耦电容（两脚 C，且一脚电源一脚地）：确认板上电容都带网络。");
    notes.push("只比距离与位置：走线宽度、层数与阻抗由 fab-tier / 布线参数负责。");
    const order = { error: 0, warning: 1, info: 2 };
    return {
        ok: true,
        error: "",
        boardFile,
        box,
        widthMm: box === null ? 0 : round2(box.x1 - box.x0),
        heightMm: box === null ? 0 : round2(box.y1 - box.y0),
        mcu: mcu?.ref ?? "",
        parts,
        findings: [...findings].sort((left, right) => order[left.severity] - order[right.severity]),
        notes,
    };
}
export function readLayout(boardFile, readText, options = {}) {
    try {
        const text = (readText ?? ((file) => readFileSync(file, "utf8")))(boardFile);
        return analyzeLayout(text, boardFile, options);
    }
    catch (error) {
        return { ...EMPTY_LAYOUT, boardFile, error: "读不到板子文件：" + error.message };
    }
}
/** 给脚本与旧代码留的占位符（与其它模块的随机 id 习惯一致）。 */
export function layoutRunId() {
    return "layout-" + randomUUID();
}
