/**
 * 把任意返回值收敛成「无损 JSON」（S188）。
 *
 * 宿主会检查工具返回值能否无损序列化：`NaN`、`Infinity`、`undefined`、`BigInt`、
 * 函数与 Symbol 都会让它整次调用失败（实测 `ecad_pdf_read` 报了
 * `returned invalid output: value is not lossless JSON`，整步白跑）。
 *
 * 规则：非有限数变 null（NaN 是「算不出来」，不是 0）；undefined 的字段直接去掉；
 * BigInt 转字符串；函数/Symbol 丢掉。数组里的 undefined 也变 null，保持下标不变。
 */
export function jsonSafe<T>(value: T): T {
  return sanitize(value, new WeakSet<object>()) as T;
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "number") return Number.isFinite(value as number) ? value : null;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "bigint") return (value as bigint).toString();
  if (kind === "undefined" || kind === "function" || kind === "symbol") return undefined;
  if (kind === "object") {
    const object = value as object;
    if (seen.has(object)) return null;
    seen.add(object);
    if (Array.isArray(value)) {
      const rows: unknown[] = [];
      for (const item of value) {
        const next = sanitize(item, seen);
        rows.push(next === undefined ? null : next);
      }
      return rows;
    }
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (value instanceof Map) {
      const rows: Record<string, unknown> = {};
      for (const [key, item] of value) {
        const next = sanitize(item, seen);
        if (next !== undefined) rows[String(key)] = next;
      }
      return rows;
    }
    if (value instanceof Set) {
      return [...value].map((item) => sanitize(item, seen)).filter((item) => item !== undefined);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
      const next = sanitize(item, seen);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return null;
}
