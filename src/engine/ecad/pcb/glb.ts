/**
 * 板子的 GLB 几何（S214）：给浏览器端的 three.js 提供「和 KiCad 渲染同一份几何」。
 *
 * 为什么不再自己拼盒子：`kicad-cli pcb export glb` 导出的就是 KiCad 3D 查看器用的那份
 * 实体——板体、铜层、丝印、阻焊、器件模型、材质与金属度全在里面。自己按包围盒堆方块的
 * 草图只能示意位置，看起来必然「low」，而且和渲染图对不上。
 *
 * 为什么缓存到用户目录：单手板 GLB 6–7 MB、导出 3 秒多，面板每次切 3D 都导一次没法用。
 * 缓存键 = 板子路径 + mtime + size + 导出参数，板子一改就自然失效。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ecadHome } from "../../ecad-home.js";
import { exportBoard3d, type Export3dOptions } from "./render3d.js";

export interface GlbViewerOptions {
  readonly includeTracks?: boolean;
  readonly includePads?: boolean;
  readonly includeZones?: boolean;
  readonly includeSilkscreen?: boolean;
  readonly includeSoldermask?: boolean;
  readonly minDistanceMm?: number;
  readonly force?: boolean;
}

export interface GlbViewerResult {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
  readonly bytes: number;
  readonly cached: boolean;
  readonly ms: number;
}

export const EMPTY_GLB: GlbViewerResult = {
  ok: false,
  error: "",
  file: "",
  bytes: 0,
  cached: false,
  ms: 0,
};

/** 浏览器端用的导出参数：看得见的都导，细碎到 0.05 mm 以下不导（否则文件翻倍）。 */
export const VIEWER_GLB_OPTIONS: GlbViewerOptions = {
  includeTracks: true,
  includePads: true,
  includeZones: true,
  includeSilkscreen: true,
  includeSoldermask: true,
  minDistanceMm: 0.05,
};

export function glbCacheDir(env: Record<string, string | undefined>): string {
  return join(ecadHome(env), "glb-cache");
}

/** 缓存键：路径 + mtime + 大小 + 参数，任一变化都重导。 */
export function glbCacheKey(boardFile: string, options: GlbViewerOptions): string {
  const stat = existsSync(boardFile) ? statSync(boardFile) : null;
  const shape = [
    boardFile,
    stat === null ? 0 : stat.mtimeMs,
    stat === null ? 0 : stat.size,
    options.includeTracks === true ? 1 : 0,
    options.includePads === true ? 1 : 0,
    options.includeZones === true ? 1 : 0,
    options.includeSilkscreen === true ? 1 : 0,
    options.includeSoldermask === true ? 1 : 0,
    options.minDistanceMm ?? 0,
  ].join("|");
  return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}

export function glbCachePath(env: Record<string, string | undefined>, key: string): string {
  return join(glbCacheDir(env), key + ".glb");
}

export interface GlbDeps {
  readonly kicadCli: string;
  readonly model3dDir: string;
  readonly env: Record<string, string>;
  readonly run: (argv: readonly string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly processEnv: Record<string, string | undefined>;
}

function toExportOptions(options: GlbViewerOptions, output: string): Export3dOptions {
  return {
    format: "glb",
    output,
    includeTracks: options.includeTracks === true,
    includePads: options.includePads === true,
    includeZones: options.includeZones === true,
    includeSilkscreen: options.includeSilkscreen === true,
    includeSoldermask: options.includeSoldermask === true,
    minDistanceMm: options.minDistanceMm,
  };
}

/**
 * 拿到（必要时导出）板子的 GLB。
 *
 * `env` 走 ecadHome 而不是 process.env：面板与工具读的是同一个用户目录，
 * 测试也能用 DSH_ECAD_HOME 指到临时目录。
 */
export async function exportViewerGlb(
  deps: GlbDeps,
  boardFile: string,
  options: GlbViewerOptions = VIEWER_GLB_OPTIONS,
): Promise<GlbViewerResult> {
  if (boardFile === "" || !existsSync(boardFile)) {
    return { ...EMPTY_GLB, error: "读不到板子文件：" + (boardFile === "" ? "（未指定）" : boardFile) };
  }
  const key = glbCacheKey(boardFile, options);
  const cacheFile = glbCachePath(deps.processEnv, key);
  const started = Date.now();
  if (options.force !== true && existsSync(cacheFile)) {
    const bytes = statSync(cacheFile).size;
    if (bytes > 0) return { ok: true, error: "", file: cacheFile, bytes, cached: true, ms: Date.now() - started };
  }
  mkdirSync(glbCacheDir(deps.processEnv), { recursive: true });
  const result = await exportBoard3d(deps, boardFile, toExportOptions(options, cacheFile));
  if (!result.ok) return { ...EMPTY_GLB, file: cacheFile, error: result.error, ms: Date.now() - started };
  return {
    ok: true,
    error: "",
    file: cacheFile,
    bytes: result.bytes,
    cached: false,
    ms: Date.now() - started,
  };
}
