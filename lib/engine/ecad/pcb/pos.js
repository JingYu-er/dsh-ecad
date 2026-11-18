/**
 * 贴片坐标（CPL）归一化（S188）。
 *
 * `kicad-cli pcb export pos` 输出的是 Y 轴已经取反的坐标（Y 向上），所以 PosY 是一串
 * 负数（实测 handheld 板：−148 … −58，而板框在 Y 48 … 152）。SMT 厂要的是
 * 「原点在板子左下角、Y 向上、0 起算」，直接把这份 CSV 给他们，贴片机会整板上下镜像。
 *
 * 换算只有两步：
 *   x' = PosX − 板框左边缘（x0）
 *   y' = PosY + 板框上边缘（y1）   ← pos 已经取反，所以是「加」，不是减
 * 平移后 x' ∈ [0, 宽]、y' ∈ [0, 高]，原点就在左下角。
 */
const EMPTY = { ok: false, error: "", rows: [], text: "", shiftX: 0, shiftY: 0, notes: [] };
function cell(text) {
    const trimmed = text.trim();
    return trimmed.includes(",") || trimmed.includes("\"") ? "\"" + trimmed.split("\"").join("\"\"") + "\"" : trimmed;
}
/** 拆一行 CSV：kicad-cli 的 `--format csv` 每个字段都带引号，朴素 split 会把引号留在值里。 */
function parseCsvLine(line) {
    const cells = [];
    let cellText = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i] ?? "";
        if (quoted) {
            if (ch === "\"") {
                if (line[i + 1] === "\"") {
                    cellText += "\"";
                    i += 1;
                }
                else {
                    quoted = false;
                }
            }
            else {
                cellText += ch;
            }
            continue;
        }
        if (ch === "\"") {
            quoted = true;
            continue;
        }
        if (ch === ",") {
            cells.push(cellText);
            cellText = "";
            continue;
        }
        cellText += ch;
    }
    cells.push(cellText);
    return cells;
}
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
/**
 * 解析 pos.csv 并平移到板左下角。
 *
 * `box` 来自 `readBoardBox()`；读不到板框时只能原样返回并说明原因——宁可不改，
 * 也不要猜一个偏移量把坐标改错。
 */
export function normalizePosCsv(text, box) {
    if (box === null) {
        return { ...EMPTY, error: "读不到板框（Edge.Cuts），贴片坐标没法平移到左下角原点" };
    }
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
    const rows = [];
    const notes = [];
    let sawHeader = false;
    for (const line of lines) {
        // 注释行：`###` 是文件头，`# Ref …` 是表头。
        if (line.startsWith("#")) {
            if (line.includes("Ref"))
                sawHeader = true;
            continue;
        }
        // kicad-cli 默认输出 ascii（列间 2+ 个空格），`--format csv` 才是逗号。
        const cells = line.includes(",") ? parseCsvLine(line) : line.split(/\s{2,}/u);
        const ref = (cells[0] ?? "").trim();
        if (ref === "Ref") {
            sawHeader = true;
            continue;
        }
        if (ref === "")
            continue;
        // ascii 里空的 Value/Package 列会被空格对齐「吃掉」，只剩 6 列：ref val x y rot side。
        const padded = cells.length >= 7;
        if (!padded && cells.length < 6)
            continue;
        const value2 = padded ? (cells[1] ?? "").trim() : (cells[1] ?? "").trim();
        const package2 = padded ? (cells[2] ?? "").trim() : "";
        const x = Number(((padded ? cells[3] : cells[2]) ?? "").trim());
        const y = Number(((padded ? cells[4] : cells[3]) ?? "").trim());
        const rotation = Number(((padded ? cells[5] : cells[4]) ?? "").trim());
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            notes.push("这一行坐标读不出来，已跳过：" + line.slice(0, 60));
            continue;
        }
        rows.push({
            ref,
            value: value2,
            packageName: package2,
            x: round4(x - box.x0),
            y: round4(y + box.y1),
            rotation: Number.isFinite(rotation) ? rotation : 0,
            side: ((padded ? cells[6] : cells[5]) ?? "").trim(),
        });
    }
    if (!sawHeader)
        notes.push("pos.csv 里没有表头行（# Ref …），按位置解析的结果可能不准");
    if (rows.length === 0)
        return { ...EMPTY, error: "pos.csv 里没有可用的贴片行", notes };
    const body = rows.map((row) => [row.ref, row.value, row.packageName, String(row.x), String(row.y), String(row.rotation), row.side].map(cell).join(","));
    notes.push("原点已改到板框左下角、Y 向上（x − " + String(round4(box.x0)) + " mm、y + " + String(round4(box.y1)) + " mm）");
    return {
        ok: true,
        error: "",
        rows,
        text: ["Ref,Val,Package,PosX,PosY,Rot,Side", ...body].join("\n") + "\n",
        shiftX: round4(box.x0),
        shiftY: round4(box.y1),
        notes,
    };
}
