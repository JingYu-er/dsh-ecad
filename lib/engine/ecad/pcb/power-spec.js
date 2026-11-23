/**
 * 粗供电专项（S234，外部技能文档 §7.1.2）：按实际电流核对电源网络的走线宽度与过孔数量。
 *
 * 三条口径：
 * 1. 宽度按 IPC-2221 算（外层 1 oz、温升 10 ℃），逐段检查而不是只看全网最窄——
 *    最窄的一段可能只有 0.3 mm 长，但真正卡住电流的是它。
 * 2. 网络有整块铺铜时不做「线宽不够」的结论：电流走铜皮，瓶颈在热焊盘与过孔，
 *    给出提示让人看图，而不是拿一段细线报警。
 * 3. 过孔按「桶壁截面」折算每孔载流（孔壁镀铜 25 µm），并联孔按几何数，
 *    不按连通性删——连通性只能证明「没断」，证明不了「够粗」。
 */
import { readFileSync } from "node:fs";
import { defaultCurrentForNet, readNetNames, requiredWidthMm } from "./emc.js";
export const EMPTY_POWER = {
    ok: false,
    error: "",
    boardFile: "",
    specs: [],
    thin: [],
    vias: [],
    findings: [],
    notes: [],
};
const COPPER = /(?:GND|AGND|DGND|PGND|VSS|VCC|VDD|VBUS|VIN|VBAT|VSYS|V3V3|3V3|3\.3V|5V|12V|AVDD|DVDD)/iu;
function netOfSegment(text, netNames) {
    const named = /\(net (?:"([^"]*)"|(\d+))/u.exec(text);
    if (named === null)
        return "";
    if (named[1] !== undefined)
        return named[1];
    return netNames.get(named[2] ?? "") ?? "";
}
/** 按 `(tag …)` 的括号配平切块：布线器写出来的 segment 一行一个字段，不能按行读。 */
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
function readSegments(text, netNames) {
    const segments = [];
    for (const block of blocks(text, "segment")) {
        const startHit = /\(start (-?[\d.]+) (-?[\d.]+)\)/u.exec(block);
        const endHit = /\(end (-?[\d.]+) (-?[\d.]+)\)/u.exec(block);
        const widthHit = /\(width ([\d.]+)\)/u.exec(block);
        const layerHit = /\(layer "?([\w.]+)"?\)/u.exec(block);
        if (startHit === null || endHit === null || widthHit === null)
            continue;
        segments.push({
            net: netOfSegment(block, netNames),
            width: Number(widthHit[1]),
            layer: layerHit?.[1] ?? "",
            x1: Number(startHit[1]),
            y1: Number(startHit[2]),
            x2: Number(endHit[1]),
            y2: Number(endHit[2]),
        });
    }
    return segments;
}
function readVias(text, netNames) {
    const vias = [];
    for (const block of blocks(text, "via")) {
        const drillHit = /\(drill ([\d.]+)\)/u.exec(block);
        vias.push({ net: netOfSegment(block, netNames), drill: drillHit === null ? 0.3 : Number(drillHit[1]) });
    }
    return vias;
}
/** 有已填充铺铜的网络：这些网络的载流靠铜皮，不做「线宽不够」的结论。 */
/** 板子里出现过的网络名：顶层声明 + 焊盘/走线/铺铜里的内联写法（tscircuit 板常常没有声明）。 */
function allNetNames(text, declared) {
    const names = new Set();
    for (const name of declared.values())
        if (name !== "")
            names.add(name);
    for (const match of text.matchAll(/\(net "([^"]*)"\)/gu)) {
        const name = (match[1] ?? "").trim();
        if (name !== "")
            names.add(name);
    }
    return [...names].sort();
}
function pouredNets(text, netNames) {
    const poured = new Set();
    for (const block of blocks(text, "zone")) {
        if (!block.includes("(filled_polygon"))
            continue;
        const net = netOfSegment(block, netNames);
        if (net !== "")
            poured.add(net);
    }
    return poured;
}
/** 过孔桶壁截面积（mm²）→ 载流（A），IPC-2221 同一条公式，截面按 π·d·t 算。 */
export function viaCurrentA(drillMm, platingUm, tempRiseC) {
    if (drillMm <= 0)
        return 0;
    const areaMm2 = Math.PI * drillMm * (platingUm / 1000);
    const areaMil2 = areaMm2 * 1550.0031;
    return 0.048 * Math.pow(tempRiseC, 0.44) * Math.pow(areaMil2, 0.725);
}
export function analyzePower(text, options = {}) {
    const boardFile = "";
    if (text.trim() === "")
        return { ...EMPTY_POWER, error: "板子文件是空的" };
    const tempRise = options.tempRiseC ?? 10;
    const copperOz = options.copperOz ?? 1;
    const plating = options.platingUm ?? 25;
    const netNames = readNetNames(text);
    const segments = readSegments(text, netNames);
    const vias = readVias(text, netNames);
    const poured = pouredNets(text, netNames);
    const given = new Map();
    for (const item of options.currents ?? []) {
        if (item.currentA > 0)
            given.set(item.net, item.currentA);
    }
    const specs = [];
    const thin = [];
    const viaCounts = [];
    const findings = [];
    const notes = [];
    const unknown = [];
    for (const name of allNetNames(text, netNames)) {
        if (!COPPER.test(name))
            continue;
        const explicit = given.get(name);
        const current = explicit ?? defaultCurrentForNet(name);
        if (current <= 0) {
            unknown.push(name);
            continue;
        }
        const requiredMm = requiredWidthMm(current, tempRise, copperOz);
        specs.push({ net: name, currentA: current, requiredMm, source: explicit === undefined ? "default" : "given" });
        const own = segments.filter((segment) => segment.net === name);
        if (own.length > 0 && !poured.has(name)) {
            const weak = own.filter((segment) => segment.width + 0.0005 < requiredMm);
            for (const segment of weak) {
                thin.push({
                    net: name,
                    layer: segment.layer,
                    widthMm: Math.round(segment.width * 1000) / 1000,
                    requiredMm,
                    lengthMm: Math.round(Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) * 100) / 100,
                    at: { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2 },
                });
            }
            if (weak.length > 0) {
                findings.push({
                    id: "power.thin-segment",
                    severity: "warning",
                    message: name + " 按 " + String(current) + " A 算需要 " + String(requiredMm) + " mm 宽，有 " + String(weak.length) +
                        " 段细于要求（最窄 " + String(thin[thin.length - 1]?.widthMm ?? "") + " mm）。",
                    fix: "把这几段加宽到 " + String(requiredMm) + " mm 以上，或把大电流回路改到内层并加铜厚。",
                });
            }
        }
        if (poured.has(name) && own.length > 0) {
            notes.push(name + " 有整块铺铜：载流靠铜皮，瓶颈在热焊盘与过孔连接处，要人工看图确认。");
        }
        const ownVias = vias.filter((via) => via.net === name);
        if (ownVias.length > 0) {
            const drill = Math.min(...ownVias.map((via) => via.drill).filter((value) => value > 0));
            const perVia = viaCurrentA(drill, plating, tempRise);
            const needed = perVia <= 0 ? ownVias.length : Math.ceil(current / perVia);
            const ok = ownVias.length >= needed;
            viaCounts.push({ net: name, currentA: current, vias: ownVias.length, needed, perViaA: Math.round(perVia * 100) / 100, ok });
            if (!ok) {
                findings.push({
                    id: "power.via-shortfall",
                    severity: "warning",
                    message: name + " 有 " + String(ownVias.length) + " 个过孔，按 Ø" + String(Math.round(drill * 1000) / 1000) + " mm 孔、孔壁 " + String(plating) +
                        " µm 算每个约 " + String(Math.round(perVia * 100) / 100) + " A，" + String(current) + " A 至少要 " + String(needed) + " 个。",
                    fix: "并联过孔补到 " + String(needed) + " 个以上，或把孔加大；不要只因为「连通性没问题」就删并联孔。",
                });
            }
        }
    }
    if (specs.some((spec) => spec.source === "default")) {
        notes.push("有网络按名字估的电流（VBUS/VIN 1 A、VCC/VDD/3V3/5V 0.5 A、GND 1 A）：准确值请在 currents 里给。");
    }
    if (unknown.length > 0)
        notes.push("这 " + String(unknown.length) + " 个电源类网络没有可用电流，跳过了宽度判据：" + unknown.slice(0, 6).join("、") + "。");
    if (segments.length === 0)
        notes.push("板子上没有走线：只有铺铜或还没布线。");
    return {
        ok: true,
        error: "",
        boardFile,
        specs,
        thin,
        vias: viaCounts,
        findings,
        notes,
    };
}
export function readPower(boardFile, options = {}, read) {
    try {
        const text = read === undefined ? readFileSync(boardFile, "utf8") : read(boardFile);
        const report = analyzePower(text, options);
        return { ...report, boardFile };
    }
    catch (error) {
        return { ...EMPTY_POWER, boardFile, error: "读不到板子：" + (error instanceof Error ? error.message : String(error)) };
    }
}
