/**
 * 交付包身份复核（S229）。
 *
 * 交付出去的 zip 是「最终证据」：板厂与贴片厂只看它。这里不做解压，只按 zip 自己的结构
 * 逐条读回来核：每个成员的 CRC 是否与数据一致、有没有重名、有没有越界路径、清单是不是
 * 第一项、字节数与成员数是否与清单对得上。
 *
 * 为什么不用系统 unzip：一是要跨平台（Windows 自带的不一定在），二是我们要的是逐成员
 * 的哈希与 CRC，而不是「能解开」这个结论。
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { crc32 } from "./zip.js";

export interface BundleMember {
  readonly name: string;
  readonly bytes: number;
  readonly crc32: string;
  readonly sha256: string;
}

export interface BundleProblem {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface BundleReport {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
  readonly bytes: number;
  readonly members: readonly BundleMember[];
  readonly manifestFirst: boolean;
  readonly manifestLines: number;
  readonly problems: readonly BundleProblem[];
  readonly notes: readonly string[];
}

export const EMPTY_BUNDLE: BundleReport = {
  ok: false,
  error: "",
  file: "",
  bytes: 0,
  members: [],
  manifestFirst: false,
  manifestLines: 0,
  problems: [],
  notes: [],
};

function hex(value: number): string {
  return "0x" + value.toString(16).padStart(8, "0");
}

/** 越界路径：绝对路径、盘符、上跳、反斜杠混用。 */
function unsafeName(name: string): string {
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) return "绝对路径";
  if (name.replace(/\\/gu, "/").split("/").includes("..")) return "包含上跳段 ..";
  if (name.includes("\\")) return "用了反斜杠";
  if (name.trim() === "") return "空名字";
  return "";
}

interface ParsedMember extends BundleMember {
  readonly data: Buffer;
}

function parseMembers(buffer: Buffer): { members: ParsedMember[]; error: string } {
  const members: ParsedMember[] = [];
  let index = 0;
  while (index + 30 <= buffer.length) {
    if (buffer.readUInt32LE(index) !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(index + 6);
    const method = buffer.readUInt16LE(index + 8);
    const checksum = buffer.readUInt32LE(index + 14);
    const size = buffer.readUInt32LE(index + 18);
    const nameLength = buffer.readUInt16LE(index + 26);
    const extraLength = buffer.readUInt16LE(index + 28);
    const name = buffer.subarray(index + 30, index + 30 + nameLength).toString("utf8");
    const start = index + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + size);
    if (method !== 0) return { members, error: "成员 " + name + " 用了压缩（method " + String(method) + "），本工具只做 STORE" };
    if ((flags & 0x0008) !== 0) return { members, error: "成员 " + name + " 带数据描述符（flag 0x08），无法按顺序定位" };
    if (data.length !== size) return { members, error: "成员 " + name + " 的数据被截断" };
    members.push({
      name,
      bytes: size,
      crc32: hex(checksum),
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    });
    index = start + size;
  }
  if (members.length === 0) return { members, error: "没有读到任何 zip 成员：文件可能不是 zip，或已损坏" };
  return { members, error: "" };
}

export function verifyBundle(file: string): BundleReport {
  if (!existsSync(file)) return { ...EMPTY_BUNDLE, file, error: "找不到交付包：" + file };
  const buffer = readFileSync(file);
  const parsed = parseMembers(buffer);
  if (parsed.error !== "") return { ...EMPTY_BUNDLE, file, bytes: buffer.length, error: parsed.error };

  const problems: BundleProblem[] = [];
  const notes: string[] = [];
  const seen = new Map<string, number>();
  for (const member of parsed.members) {
    seen.set(member.name, (seen.get(member.name) ?? 0) + 1);
    const unsafe = unsafeName(member.name);
    if (unsafe !== "") {
      problems.push({ id: "bundle.unsafe-name", severity: "error", message: "成员 " + member.name + " 的路径不安全：" + unsafe });
    }
    const actual = crc32(member.data);
    if (hex(actual) !== member.crc32) {
      problems.push({
        id: "bundle.crc-mismatch",
        severity: "error",
        message: "成员 " + member.name + " 的 CRC 对不上：头里写 " + member.crc32 + "，实际数据 " + hex(actual),
      });
    }
  }
  for (const [name, count] of seen) {
    if (count > 1) problems.push({ id: "bundle.duplicate", severity: "error", message: "成员 " + name + " 出现了 " + String(count) + " 次" });
  }

  const first = parsed.members[0]?.name ?? "";
  const manifestFirst = first === "manifest.txt";
  if (!manifestFirst) {
    problems.push({
      id: "bundle.manifest-order",
      severity: "warning",
      message: "manifest.txt 不在第一项（当前第一项是 " + (first === "" ? "（空）" : first) + "）：先看清单再看文件的人会找不到入口",
    });
  }
  const manifest = parsed.members.find((member) => member.name === "manifest.txt");
  const manifestLines = manifest === undefined ? 0 : manifest.data.toString("utf8").split("\n").filter((line) => line.trim() !== "").length;
  if (manifest === undefined) {
    problems.push({ id: "bundle.manifest-missing", severity: "error", message: "包里没有 manifest.txt：交付物没有身份与清单" });
  } else {
    const text = manifest.data.toString("utf8");
    for (const key of ["生成时间", "文件数", "字节数"]) {
      if (!text.includes(key)) {
        problems.push({ id: "bundle.manifest-fields", severity: "warning", message: "manifest.txt 缺少「" + key + "」这一行" });
      }
    }
  }

  const memberCount = parsed.members.length;
  if (manifest !== undefined) {
    const text = manifest.data.toString("utf8");
    const declared = /文件数\s*[:：]?\s*(\d+)/u.exec(text);
    if (declared !== null && Number(declared[1]) !== memberCount) {
      problems.push({
        id: "bundle.manifest-count",
        severity: "error",
        message: "manifest.txt 写「文件数 " + String(declared[1] ?? 0) + "」，实际 " + String(memberCount) + " 个成员",
      });
    }
    const bytesDeclared = /字节数\s*[:：]?\s*(\d+)/u.exec(text);
    if (bytesDeclared !== null) {
      const total = parsed.members.reduce((sum, member) => sum + member.bytes, 0);
      if (Number(bytesDeclared[1]) !== total) {
        problems.push({
          id: "bundle.manifest-bytes",
          severity: "error",
          message: "manifest.txt 写「字节数 " + String(bytesDeclared[1] ?? 0) + "」，成员合计 " + String(total),
        });
      }
    }
  }

  const dirents = parsed.members.filter((member) => member.name.endsWith("/"));
  if (dirents.length > 0) notes.push("包里有 " + String(dirents.length) + " 个目录条目。");
  notes.push("成员合计 " + String(parsed.members.reduce((sum, member) => sum + member.bytes, 0)) + " 字节，文件 " + String(buffer.length) + " 字节。");

  return {
    ok: problems.every((problem) => problem.severity !== "error"),
    error: "",
    file,
    bytes: buffer.length,
    members: parsed.members.map((member) => ({
      name: member.name,
      bytes: member.bytes,
      crc32: member.crc32,
      sha256: member.sha256,
    })),
    manifestFirst,
    manifestLines,
    problems,
    notes,
  };
}
