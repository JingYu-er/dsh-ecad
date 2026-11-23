import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { parsePcbScene } from "./scene.js";
import { analyzeRouting } from "./routing.js";
import { analyzeBuses } from "./bus.js";
import { analyzeReference } from "./reference.js";
import { analyzeDiff } from "./diff.js";

/** 一次候选比较里，单个候选相对基线的结果。 */
export interface CandidateRow {
  readonly label: string;
  readonly file: string;
  readonly segments: number;
  readonly vias: number;
  readonly addedSegments: number;
  readonly removedSegments: number;
  readonly addedMm: number;
  readonly removedMm: number;
  readonly rightAngles: number;
  readonly acuteAngles: number;
  readonly stairRuns: number;
  readonly badExits: number;
  readonly busGroups: number;
  readonly busUneven: number;
  readonly gaps: number;
  readonly partialGaps: number;
  /** 这次比较里「回流缺口」能不能比：基线没有填充平面时不可比。 */
  readonly gapsComparable: boolean;
  /** 相对基线的结论：更好 / 持平 / 更差。 */
  readonly verdict: "更好" | "持平" | "更差";
  /** 相对基线，各项判据的增减（负数表示变好）。 */
  readonly score: number;
}

export interface CandidateReport {
  readonly ok: boolean;
  readonly error: string;
  readonly baselineFile: string;
  readonly rows: CandidateRow[];
  readonly markdown: string;
  readonly notes: string[];
}

export const EMPTY_CANDIDATES: CandidateReport = {
  ok: false,
  error: "",
  baselineFile: "",
  rows: [],
  markdown: "",
  notes: [],
};

interface CandidateInput {
  readonly label?: string;
  readonly file: string;
  /** 已经读好的板子文本；不给就按 file 读。 */
  readonly text?: string;
}

function readBoard(file: string): string {
  return readFileSync(file, "utf8");
}

function metrics(text: string): {
  segments: number;
  vias: number;
  rightAngles: number;
  acuteAngles: number;
  stairRuns: number;
  badExits: number;
  busGroups: number;
  busUneven: number;
  gaps: number;
  partialGaps: number;
  planes: number;
} {
  const scene = parsePcbScene(text, "candidate");
  const routing = analyzeRouting(scene, {});
  const buses = analyzeBuses(text, {});
  const reference = analyzeReference(text, {});
  return {
    segments: scene.tracks.length,
    vias: scene.vias.length,
    rightAngles: routing.stats.rightAngles,
    acuteAngles: routing.stats.acuteAngles,
    stairRuns: routing.stats.stairRuns,
    badExits: routing.stats.badExits,
    busGroups: buses.groups.length,
    busUneven: buses.findings.filter((finding) => finding.id === "bus.uneven-spacing").length,
    gaps: reference.findings.filter((finding) => finding.id === "reference.gap").length,
    partialGaps: reference.findings.filter((finding) => finding.id === "reference.partial-gap").length,
    planes: reference.planes.length,
  };
}

/** 判据加权：回流缺口最贵，其次是锐角/阶梯这类「看着乱且难修」的。 */
function scoreOf(row: {
  rightAngles: number;
  acuteAngles: number;
  stairRuns: number;
  badExits: number;
  busUneven: number;
  gaps: number;
  addedSegments: number;
}, gapsComparable = true): number {
  return (
    (gapsComparable ? row.gaps * 4 : 0) +
    row.acuteAngles * 2 +
    row.stairRuns * 2 +
    row.busUneven * 2 +
    row.badExits +
    row.rightAngles * 0.5 +
    row.addedSegments * 0.02
  );
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

/**
 * 候选比较记录（§7.1.4）。
 *
 * 只回答四件事：基线有什么缺陷、真实几何改了多少、约束核验过了没有、为什么选它。
 * 不替使用者做决定——verdict 是「判据加权后的相对结论」，真正的选择理由要人来补。
 */
export function compareCandidates(baselineFile: string, baselineText: string, candidates: readonly CandidateInput[]): CandidateReport {
  if (baselineText.trim() === "") return { ...EMPTY_CANDIDATES, baselineFile, error: "基线板子是空的" };
  const base = metrics(baselineText);
  const gapsComparable = base.planes > 0;
  const baseScore = scoreOf({ ...base, addedSegments: 0 }, gapsComparable);
  const rows: CandidateRow[] = [];
  for (const candidate of candidates) {
    const text = candidate.text ?? readBoard(candidate.file);
    const own = metrics(text);
    const diff = analyzeDiff(baselineText, text);
    const score = scoreOf({ ...own, addedSegments: diff.stats.added }, gapsComparable);
    const row: CandidateRow = {
      label: candidate.label ?? basename(candidate.file),
      file: candidate.file,
      segments: own.segments,
      vias: own.vias,
      addedSegments: diff.stats.added,
      removedSegments: diff.stats.removed,
      addedMm: Math.round(diff.stats.addedMm * 10) / 10,
      removedMm: Math.round(diff.stats.removedMm * 10) / 10,
      rightAngles: own.rightAngles,
      acuteAngles: own.acuteAngles,
      stairRuns: own.stairRuns,
      badExits: own.badExits,
      busGroups: own.busGroups,
      busUneven: own.busUneven,
      gaps: own.gaps,
      partialGaps: own.partialGaps,
      gapsComparable,
      // 几何没变而判据变了，多半是「原来判不了、现在判得了」（例如重填铺铜后平面才可见），
      // 那不是回归，不该打上「更差」。
      verdict:
        diff.stats.added + diff.stats.removed === 0
          ? "持平"
          : score < baseScore - 0.5
            ? "更好"
            : score > baseScore + 0.5
              ? "更差"
              : "持平",
      score: diff.stats.added + diff.stats.removed === 0 ? 0 : Math.round((score - baseScore) * 10) / 10,
    };
    rows.push(row);
  }
  const markdown = renderCandidatesMarkdown(baselineFile, base, rows);
  return {
    ok: rows.length > 0,
    error: rows.length === 0 ? "一个候选都没给" : "",
    baselineFile,
    rows,
    markdown,
    notes: [
      base.segments === 0
        ? "基线没有走线：这种比较只能看「候选多了什么」，任何真实布线都会被评为更差——要比布线方案，基线应当是同一条已布通的板子。"
        : "基线已有走线：结论是「相对这条基线的判据增减」，通常用来比较同一块板的两个改法。",
      gapsComparable
        ? "回流缺口这项可比：基线有已填充的平面。"
        : "回流缺口这项不可比：基线没有已填充的平面（铺铜前后比这项会把「原来判不了」当成「变差了」）。",
      rows.some((row) => row.score === 0 && (row.gaps !== base.gaps || row.acuteAngles !== base.acuteAngles))
        ? "有候选几何没变但判据变了：这是「原来判不了、现在判得了」（例如重填铺铜后平面才可见），不算回归。"
        : "判据增减只对几何有变化的候选有意义。",
      "verdict 是判据加权后的相对结论（回流缺口 ×4、锐角/阶梯/总线不等距 ×2、斜拉 ×1、直角 ×0.5、新增段 ×0.02），不是最终决定。",
      "选择理由要人来补：这张表只列「改了多少」与「判据增减」，不替使用者判断值不值得。",
    ],
  };
}

function delta(before: number, after: number): string {
  const diff = after - before;
  if (diff === 0) return String(after);
  return String(after) + "（" + (diff > 0 ? "+" : "") + String(Math.round(diff * 10) / 10) + "）";
}

export function renderCandidatesMarkdown(
  baselineFile: string,
  base: {
    segments: number;
    vias: number;
    rightAngles: number;
    acuteAngles: number;
    stairRuns: number;
    badExits: number;
    busUneven: number;
    gaps: number;
  },
  rows: readonly CandidateRow[],
): string {
  const lines: string[] = [];
  lines.push("# 候选比较记录");
  lines.push("");
  lines.push("基线：" + baselineFile + (base.segments === 0 ? "（没有走线：这里只能看候选多了什么）" : ""));
  lines.push(
    "基线缺陷：回流缺口 " + String(base.gaps) + " 处、锐角 " + String(base.acuteAngles) + " 处、阶梯 " +
      String(base.stairRuns) + " 处、斜拉 " + String(base.badExits) + " 处、总线不等距 " + String(base.busUneven) + " 处。",
  );
  lines.push("");
  lines.push("| 候选 | 真实几何改变 | 约束核验（相对基线） | 结论 |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of rows) {
    const geometry =
      "+" + String(row.addedSegments) + " / -" + String(row.removedSegments) + " 段，" +
      "+" + String(row.addedMm) + " / -" + String(row.removedMm) + " mm，" +
      "过孔 " + String(row.vias) + " 个";
    const checks =
      (row.gapsComparable ? "缺口 " + delta(base.gaps, row.gaps) : "缺口 不可比（基线没有填充平面）") + "、锐角 " + delta(base.acuteAngles, row.acuteAngles) +
      "、直角 " + delta(base.rightAngles, row.rightAngles) + "、阶梯 " + delta(base.stairRuns, row.stairRuns) +
      "、斜拉 " + delta(base.badExits, row.badExits) + "、总线 " + delta(base.busUneven, row.busUneven);
    lines.push(
      "| " + escapeCell(row.label) + " | " + escapeCell(geometry) + " | " + escapeCell(checks) + " | " +
        row.verdict + "（加权 " + (row.score > 0 ? "+" : "") + String(row.score) + "） |",
    );
  }
  lines.push("");
  lines.push("说明：");
  lines.push("- 结论只看判据增减；同样的几何改变在不同板子上代价不同，选之前仍要看图。");
  lines.push("- 几何改变用身份键（端点 + 层 + 宽度）对比，重新保存一遍不会被算成改动。");
  return lines.join("\n") + "\n";
}
