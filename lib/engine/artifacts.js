/**
 * 产物与内存：读构建目录里的 elf / hex / bin，配上芯片的 Flash / RAM 容量，供调试台显示。
 *
 * 只读文件属性，不跑 size / objdump：内存占用来自上一次 `stm32_build` 的
 * `--print-memory-usage` 结果（面板从事件流里取），避免为了一个数字再起一个子进程。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
function statFile(file) {
    try {
        const info = statSync(file);
        return { name: basename(file), path: file, size: info.size, mtimeMs: info.mtimeMs, sha256: "" };
    }
    catch {
        return null;
    }
}
/** 给一个产物补上校验和；超过上限的文件保持空串，调用方据此提示（S62）。 */
function withHash(file) {
    if (file === null)
        return null;
    return { ...file, sha256: hashFile(file) };
}
/** 与 elf 同名、扩展名不同的兄弟产物。 */
function sibling(elfPath, extension) {
    const dot = elfPath.lastIndexOf(".");
    const base = dot === -1 ? elfPath : elfPath.slice(0, dot);
    return statFile(base + extension);
}
/** 超过这个大小的 elf 不算校验和：调试台每 10 秒轮询一次，不值得。 */
export const ARTIFACT_HASH_MAX_BYTES = 8 * 1024 * 1024;
/** 单个文件的 SHA-256（S68）：构建摘要用它标出「这次 elf 和上次是不是同一个」。 */
export function sha256OfPath(filePath) {
    const file = statFile(filePath);
    return file === null ? "" : hashFile(file);
}
function hashFile(file) {
    if (file.size > ARTIFACT_HASH_MAX_BYTES)
        return "";
    try {
        return createHash("sha256").update(readFileSync(file.path)).digest("hex");
    }
    catch {
        return "";
    }
}
/** 本地找构建目录：<固件目录>/build/* 里挑最新的；找不到再试 <工程>/build/*。 */
function detectBuildDir(projectDir) {
    const candidates = [];
    for (const base of [projectDir, join(projectDir, "fw"), join(projectDir, "program"), join(projectDir, "firmware")]) {
        const buildRoot = join(base, "build");
        if (!existsSync(buildRoot))
            continue;
        for (const name of readdirSync(buildRoot)) {
            const full = join(buildRoot, name);
            if (existsSync(full) && statSync(full).isDirectory())
                candidates.push(full);
        }
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates[0] ?? null;
}
/** 构建目录里的 elf：优先与目录名/工程名同名的，其次最新的。 */
function findElf(buildDir) {
    const elves = listElves(buildDir);
    if (elves.length === 0)
        return null;
    const wanted = basename(buildDir).toLowerCase();
    const match = elves.find((file) => basename(file.name, ".elf").toLowerCase() === wanted);
    return { path: (match ?? elves[0]).path };
}
/** 从 .ioc 里读 Mcu.CPN（没有就回空串：不猜型号）。 */
function readIocCpn(projectDir) {
    for (const base of [projectDir, join(projectDir, "fw"), join(projectDir, "program"), join(projectDir, "firmware")]) {
        if (!existsSync(base))
            continue;
        for (const name of readdirSync(base)) {
            if (!name.toLowerCase().endsWith(".ioc"))
                continue;
            try {
                const match = /^Mcu\.CPN=(.+)$/mu.exec(readFileSync(join(base, name), "utf8"));
                if (match !== null)
                    return (match[1] ?? "").trim();
            }
            catch {
                // 读不了就继续找下一个
            }
        }
    }
    return "";
}
function listElves(buildDir) {
    let names;
    try {
        names = readdirSync(buildDir);
    }
    catch {
        return [];
    }
    const files = [];
    for (const name of names) {
        if (!name.toLowerCase().endsWith(".elf"))
            continue;
        const file = statFile(join(buildDir, name));
        if (file !== null)
            files.push(file);
    }
    return files;
}
export function readArtifacts(projectDir, _env = process.env) {
    const dir = projectDir.trim();
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const notes = [];
    const buildDir = detectBuildDir(dir) ?? "";
    if (buildDir === "") {
        notes.push("还没有可识别的构建目录：先执行 stm32_build 或 cmake --preset。");
    }
    let elfInfo = null;
    if (buildDir !== "")
        elfInfo = findElf(buildDir);
    const elf = withHash(elfInfo === null ? null : statFile(elfInfo.path));
    const hex = withHash(elf === null ? null : sibling(elf.path, ".hex"));
    const bin = withHash(elf === null ? null : sibling(elf.path, ".bin"));
    const otherElves = buildDir === "" ? [] : listElves(buildDir).filter((file) => file.path !== elf?.path);
    if (otherElves.length > 0) {
        notes.push("构建目录里有 " + String(otherElves.length + 1) + " 个 .elf，当前显示按工程名/修改时间挑出的那个。");
    }
    const sha256 = elf?.sha256 ?? "";
    if (elf !== null && sha256 === "") {
        notes.push("elf 超过 " + String(Math.round(ARTIFACT_HASH_MAX_BYTES / 1024 / 1024)) + " MB，跳过校验和。");
    }
    const cpn = readIocCpn(dir);
    // 容量上限表属于固件侧（芯片资源包），硬件台不查它：这里只保留型号，容量留空。
    const chip = null;
    if (cpn !== "")
        notes.push("芯片型号 " + cpn + "：容量上限要到固件侧看，硬件台不查芯片资源包。");
    else
        notes.push("工程里没有 .ioc 的 Mcu.CPN，无法给出型号。");
    return {
        ok: true,
        report: {
            projectDir: dir,
            buildDir,
            elf,
            hex,
            bin,
            otherElves,
            chip,
            sha256,
            notes,
        },
    };
}
/** 构建目录存在但还没有产物的判断，供面板给出下一步。 */
export function hasBuildDir(projectDir) {
    const dir = detectBuildDir(projectDir);
    return dir !== null && existsSync(dir);
}
