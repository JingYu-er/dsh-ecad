/**
 * 嘉立创打样的成本档位（S193）。
 *
 * 三条口径都来自官方页面或用户实测的下单页报价，改动时请连同来源一起改：
 * - 走线：多层板线宽/线距小于 3.5 mil 时，4–8 层加收货款的 20%，10 层及以上 30%
 *   （《附加收费一览表(硬板)》第七节「其他难度工艺费」）。
 * - 过孔：按下单页的孔径档位加收，0.3/0.4 mm 起免费，越细越贵。
 * - 层压：4 层的 JLC04161H-3313 与 6 层的 JLC06161H-3313 是免费结构，其余加收。
 *
 * 这些是**估算**：最终以嘉立创下单页上传 Gerber 后的价格明细为准。这里的作用是
 * 在出板之前就把「这一版会不会加钱」说清楚，而不是等报价出来再回头改设计。
 */
/** 铜厚（1 oz）。 */
const CU = 0.035;
/**
 * 免费的两种层压结构（成品板厚与介质厚度取自嘉立创叠层表）。
 *
 * 4 层 JLC04161H-3313：1.56 mm ±10%，1.3 mm H/H 含铜；
 * 6 层 JLC06161H-3313：1.54 mm ±10%，0.55 mm H/H 不含铜。
 */
export const FREE_STACKUPS = [
    {
        id: "JLC04161H-3313",
        layers: 4,
        label: "嘉立创 4 层 JLC04161H-3313（免费）",
        totalMm: 1.56,
        note: "成品板厚 1.56 mm ±10%，1.3 mm H/H 含铜",
        materials: [
            { kind: "copper", name: "顶层线路", thicknessMm: CU },
            { kind: "prepreg", name: "压合 PP 3313*1", thicknessMm: 0.0994 },
            { kind: "copper", name: "中间线路 1", thicknessMm: 0.0152 },
            { kind: "core", name: "芯板 core", thicknessMm: 1.265 },
            { kind: "copper", name: "中间线路 2", thicknessMm: 0.0152 },
            { kind: "prepreg", name: "压合 PP 3313*1", thicknessMm: 0.0994 },
            { kind: "copper", name: "底层线路", thicknessMm: CU },
        ],
    },
    {
        id: "JLC06161H-3313",
        layers: 6,
        label: "嘉立创 6 层 JLC06161H-3313（免费）",
        totalMm: 1.54,
        note: "成品板厚 1.54 mm ±10%，0.55 mm H/H 不含铜",
        materials: [
            { kind: "copper", name: "顶层线路", thicknessMm: CU },
            { kind: "prepreg", name: "压合 PP 3313*1", thicknessMm: 0.0994 },
            { kind: "copper", name: "中间线路 1", thicknessMm: 0.0152 },
            { kind: "core", name: "芯板 core", thicknessMm: 0.55 },
            { kind: "copper", name: "中间线路 2", thicknessMm: 0.0152 },
            { kind: "prepreg", name: "压合 PP 2116*1", thicknessMm: 0.1088 },
            { kind: "copper", name: "中间线路 3", thicknessMm: 0.0152 },
            { kind: "core", name: "芯板 core", thicknessMm: 0.55 },
            { kind: "copper", name: "中间线路 4", thicknessMm: 0.0152 },
            { kind: "prepreg", name: "压合 PP 3313*1", thicknessMm: 0.0994 },
            { kind: "copper", name: "底层线路", thicknessMm: CU },
        ],
    },
];
/** 非免费层压的加收区间（元/款）：下单页按具体结构给，这里取中值做估算。 */
export const STACKUP_SURCHARGE_MIN_YUAN = 100;
export const STACKUP_SURCHARGE_MAX_YUAN = 300;
export const STACKUP_SURCHARGE_DEFAULT_YUAN = 200;
export function freeStackupFor(layers) {
    return FREE_STACKUPS.find((stackup) => stackup.layers === layers) ?? null;
}
/**
 * 层压结构是否免费。
 *
 * 2 层板用常规 FR4，属基础产品本身，不计附加；4/6 层只有上表两种结构免费，
 * 其余（2 oz 铜、别的板厚、别的 PP 组合）按下单页加收 100–300 元/款。
 */
export function stackupCostOf(layers, stackupId = "") {
    if (layers <= 2) {
        return {
            layers,
            stackupId: stackupId !== "" ? stackupId : "FR-4 1.6 mm",
            free: true,
            surchargeYuan: 0,
            note: "2 层常规 FR-4 属基础产品，层压不计附加",
        };
    }
    const free = freeStackupFor(layers);
    if (free !== null && (stackupId === "" || stackupId === free.id)) {
        return { layers, stackupId: free.id, free: true, surchargeYuan: 0, note: free.note };
    }
    return {
        layers,
        stackupId: stackupId !== "" ? stackupId : "非标准叠层",
        free: false,
        surchargeYuan: STACKUP_SURCHARGE_DEFAULT_YUAN,
        note: `不是免费叠层（免费的是 4 层 ${FREE_STACKUPS[0]?.id ?? ""} 与 6 层 ${FREE_STACKUPS[1]?.id ?? ""}）：下单页加收 ${STACKUP_SURCHARGE_MIN_YUAN}–${STACKUP_SURCHARGE_MAX_YUAN} 元/款`,
    };
}
/**
 * 孔径档位（来自用户实测的下单页报价，2 层与多层同一套）。
 *
 * 0.3/0.4 mm 起免费；0.25/0.35–0.4 加 300；0.2/0.3–0.35 加 300；
 * 0.15/0.25–0.3 加 400；0.1/0.2–0.25 加 400。
 */
export const HOLE_TIERS = [
    { drillMm: 0.3, ringMm: 0.1, addYuan: 0, label: "0.3/0.4 mm（标准档）" },
    { drillMm: 0.25, ringMm: 0.075, addYuan: 300, label: "0.25/0.35–0.4 mm（+300 元/款）" },
    { drillMm: 0.2, ringMm: 0.05, addYuan: 300, label: "0.2/0.3–0.35 mm（+300 元/款）" },
    { drillMm: 0.15, ringMm: 0.05, addYuan: 400, label: "0.15/0.25–0.3 mm（+400 元/款）" },
    { drillMm: 0.1, ringMm: 0.05, addYuan: 400, label: "0.1/0.2–0.25 mm（+400 元/款）" },
];
/** 按最小孔径找它落在哪一档（向上取档：能放进更粗的档就按那一档算）。 */
export function holeCostOf(drillMm) {
    if (drillMm <= 0) {
        return { drillMm: 0, tierLabel: "没有过孔", addYuan: 0, belowCapability: false, note: "板子上没有过孔，不计孔径附加" };
    }
    if (drillMm < 0.1 - 1e-6) {
        return {
            drillMm,
            tierLabel: "低于 0.1 mm",
            addYuan: 0,
            belowCapability: true,
            note: "最小孔径低于 0.1 mm：超出嘉立创常规能力，需要走特殊工艺，价格与交期都要单独谈",
        };
    }
    const tier = [...HOLE_TIERS].reverse().find((item) => drillMm <= item.drillMm + 1e-6) ?? null;
    if (tier === null) {
        return {
            drillMm,
            tierLabel: "低于 0.1 mm",
            addYuan: 0,
            belowCapability: true,
            note: "最小孔径低于 0.1 mm：超出嘉立创常规能力，需要走特殊工艺，价格与交期都要单独谈",
        };
    }
    return {
        drillMm,
        tierLabel: tier.label,
        addYuan: tier.addYuan,
        belowCapability: false,
        note: tier.addYuan === 0
            ? "最小孔径在标准档，不计附加"
            : `最小孔径落在「${tier.label}」：按档位加收 ${tier.addYuan} 元/款`,
    };
}
/** mm → mil（1 mil = 0.0254 mm）。 */
export function mmToMil(mm) {
    return mm / 0.0254;
}
/**
 * 走线档位。
 *
 * 官方只对多层给了明确规则（<3.5 mil 加收 20%/30% 货款）；2 层的 4/4 mil 是
 * 能力下限，公开文档里没有对应加价条目，所以这里**不编数字**，只标「精细档」。
 */
export function traceCostOf(layers, minTrackMm, minClearanceMm) {
    const minTrackMil = minTrackMm > 0 ? mmToMil(minTrackMm) : 0;
    const minClearanceMil = minClearanceMm > 0 ? mmToMil(minClearanceMm) : 0;
    // 两边都换成 mil 再取小：拿毫米直接和 3.5 比会把 0.15 mm 读成「0.15 mil」
    const minMil = Math.min(minTrackMil > 0 ? minTrackMil : Number.POSITIVE_INFINITY, minClearanceMil > 0 ? minClearanceMil : Number.POSITIVE_INFINITY);
    if (!Number.isFinite(minMil)) {
        return {
            minTrackMil,
            minClearanceMil,
            minMil: 0,
            tier: "standard",
            surchargePct: 0,
            note: "没读到走线与间距，无法判断档位",
        };
    }
    const rounded = Math.round(minMil * 100) / 100;
    if (layers >= 4) {
        if (rounded < 3.5) {
            const pct = layers >= 10 ? 30 : 20;
            return {
                minTrackMil,
                minClearanceMil,
                minMil: rounded,
                tier: "fine",
                surchargePct: pct,
                note: `最小线宽/间距 ${rounded.toFixed(2)} mil < 3.5 mil：${layers} 层板加收货款的 ${pct}%`,
            };
        }
        return {
            minTrackMil,
            minClearanceMil,
            minMil: rounded,
            tier: "standard",
            surchargePct: 0,
            note: `最小线宽/间距 ${rounded.toFixed(2)} mil ≥ 3.5 mil：不计难度工艺费`,
        };
    }
    if (rounded < 4) {
        return {
            minTrackMil,
            minClearanceMil,
            minMil: rounded,
            tier: "fine",
            surchargePct: 0,
            note: `最小线宽/间距 ${rounded.toFixed(2)} mil：2 层的 4/4 mil 是能力下限，公开文档未列加价；下单页可能进精细线路档，以报价为准`,
        };
    }
    return {
        minTrackMil,
        minClearanceMil,
        minMil: rounded,
        tier: "standard",
        surchargePct: 0,
        note: `最小线宽/间距 ${rounded.toFixed(2)} mil：2 层常规档`,
    };
}
/**
 * 布线参数（不贴工艺下限，留出「画整齐」的余量）。
 *
 * - 4 层：信号 0.20/0.15（7.9/5.9 mil，离 3.5 mil 加价线有 1.7–2.2 倍余量）、
 *   电源 0.45、差分间距 0.20、过孔 0.45/0.25（0.25 档 +300，若介意可用 0.3/0.4 档）；
 * - 2 层：信号 0.30/0.30（11.8/11.8 mil）、电源 0.60、差分 0.25、过孔 0.60/0.30（标准档）。
 *
 * 2 层把间距从 0.20 提到 0.30，是为了让「3 倍线宽」这条串扰规则有落点：
 * 0.30 线宽的 3 倍是 0.90 mm，全局按 0.90 会布不通，所以全局取 0.30，
 * 关键网（时钟、差分、复位）用 `criticalSpacingMm` 单独放宽，报告里分开写。
 */
export function routingPreset(layers) {
    if (layers <= 2) {
        return {
            layers,
            label: "2 层·整洁档",
            signalWidthMm: 0.3,
            signalClearanceMm: 0.3,
            criticalSpacingMm: 0.9,
            powerWidthMm: 0.6,
            diffGapMm: 0.25,
            viaDiameterMm: 0.6,
            viaDrillMm: 0.3,
            note: "信号 0.30/0.30 mm（11.8/11.8 mil）；关键网按 3 倍线宽 0.90 控制串扰；过孔 0.6/0.3 在标准档，不计孔径附加",
        };
    }
    return {
        layers,
        label: `${layers} 层·整洁档`,
        signalWidthMm: 0.2,
        signalClearanceMm: 0.15,
        criticalSpacingMm: 0.6,
        powerWidthMm: 0.45,
        diffGapMm: 0.2,
        viaDiameterMm: 0.45,
        viaDrillMm: 0.25,
        note: "信号 0.20/0.15 mm（7.9/5.9 mil，远离 3.5 mil 加价线）；关键网按 3 倍线宽 0.60 控制串扰；过孔 0.45/0.25 属 +300 档，想省这 300 元就改 0.3/0.4",
    };
}
/** 把三条档位合起来算一次「这一版会不会加钱」。 */
export function estimateFabCost(input) {
    const stackup = stackupCostOf(input.layers, input.stackupId);
    const trace = traceCostOf(input.layers, input.minTrackMm, input.minClearanceMm);
    const hole = holeCostOf(input.minDrillMm);
    const pctYuan = input.priceYuan !== undefined && input.priceYuan > 0 ? (input.priceYuan * trace.surchargePct) / 100 : 0;
    const notes = [stackup.note, trace.note, hole.note];
    if (trace.surchargePct > 0 && pctYuan === 0) {
        notes.push(`走线加价按货款的 ${trace.surchargePct}% 计，具体金额要等下单页报价`);
    }
    return {
        layers: input.layers,
        stackup,
        trace,
        hole,
        surchargeYuan: stackup.surchargeYuan + hole.addYuan + Math.round(pctYuan * 100) / 100,
        surchargePct: trace.surchargePct,
        preset: routingPreset(input.layers),
        notes,
    };
}
