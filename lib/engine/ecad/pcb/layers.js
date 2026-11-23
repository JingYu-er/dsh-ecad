/**
 * 逐层物理图导出（S230）。
 *
 * 外部技能文档 §7.2 要求「修改前后同坐标同比例」的逐层真实铜图：只看 DRC 数字看不出
 * 「这一层到底画了什么」，而看整板合成图又分不清是哪一层的铜。这里直接让 KiCad 自己
 * 出图——`kicad-cli pcb export svg` 一层一张，`--page-size-mode 2`（只留板面）+
 * `--exclude-drawing-sheet`，因此每张图的坐标原点与比例天然一致，改前改后可以直接叠。
 *
 * 不自己画：内层铜、异形焊盘、铺铜孤岛与开窗细节全在 KiCad 的绘制规则里，自研 SVG 只会
 * 得到「看起来像」的图。
 */
import { runCapture } from "../../subprocess-runner.js";
import { coverageOf } from "./coverage.js";
import { statSync } from "node:fs";
export const EMPTY_LAYERS = {
    ok: false,
    error: "",
    dir: "",
    layers: [],
    notes: [],
};
/** 从板子文本里取铜层顺序（外层在前，内层按编号）。 */
export function copperLayersOfBoard(text) {
    const report = coverageOf(text);
    return report.layers.map((layer) => layer.name);
}
/** 一层一次调用的 argv；抽出来是为了能单测，不必真跑 KiCad。 */
export function layerSvgArgv(input) {
    const argv = [
        input.kicadCli,
        "pcb",
        "export",
        "svg",
        "--output",
        input.output,
        "--layers",
        input.layer,
        // 2 = 只留板面：这样每层的原点与比例一致，改前改后可以直接叠图比较。
        "--page-size-mode",
        "2",
        "--exclude-drawing-sheet",
        "--mode-single",
    ];
    if (input.blackAndWhite)
        argv.push("--black-and-white");
    argv.push(input.boardFile);
    return argv;
}
/** 一层一图，全部落在同一个目录里；每张图只含该层的铜。 */
export async function exportLayerSvgs(deps, boardFile, boardText, options) {
    const copper = copperLayersOfBoard(boardText);
    const wanted = options.layers === undefined ? copper : copper.filter((name) => options.layers?.includes(name) === true);
    if (wanted.length === 0) {
        return { ...EMPTY_LAYERS, error: "这块板子没有可导出的铜层：先确认 .kicad_pcb 里有 (layers …)" };
    }
    const dir = options.outDir;
    const blackAndWhite = options.blackAndWhite !== false;
    const layers = [];
    const notes = [];
    for (const name of wanted) {
        const file = joinPath(dir, name.replace(/\./gu, "_") + ".svg");
        const argv = layerSvgArgv({ kicadCli: deps.kicadCli, output: file, layer: name, boardFile, blackAndWhite });
        const outcome = await runCapture(deps.subprocess, { argv, env: deps.env, timeoutMs: 120_000, cwd: cwdOf(boardFile) });
        if (outcome.exitCode !== 0) {
            return {
                ...EMPTY_LAYERS,
                dir,
                layers,
                error: "导出 " + name + " 失败（退出码 " + String(outcome.exitCode ?? -1) + "）：" + (outcome.stderr + outcome.spawnError).slice(0, 400),
                notes,
            };
        }
        layers.push({ name, file, bytes: sizeOf(file) });
    }
    notes.push("每张图都按「只留板面」出，原点与比例一致：改前改后同层叠图即可比较。");
    if (wanted.length !== copper.length) {
        notes.push("按指定层导出 " + String(wanted.length) + " / " + String(copper.length) + " 层。");
    }
    return { ok: true, error: "", dir, layers, notes };
}
/** 输出目录拼路径：不引 node:path，避免这个模块在浏览器侧被打进来。 */
function joinPath(dir, name) {
    const base = dir.replace(/[\\/]+$/u, "");
    return base + "/" + name;
}
/** 目录部分：拿板子所在目录当工作目录，KiCad 才会按工程解析相对路径。 */
function cwdOf(file) {
    const normalized = file.replace(/\\/gu, "/");
    const cut = normalized.lastIndexOf("/");
    return cut <= 0 ? "." : normalized.slice(0, cut);
}
/** 产物大小；读不到记 0（不因为统计失败把导出的结果判成失败）。 */
function sizeOf(file) {
    try {
        return statSync(file).size;
    }
    catch {
        return 0;
    }
}
