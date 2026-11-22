/**
 * 覆盖记录（S228）：板子上每一层到底做了什么。
 *
 * 只看最终板子本身——走线按 `(segment … (layer X))` 块数，铺铜区按 `(zone … (layer "X"))` 块数，
 * 填充与否看块里有没有 `filled_polygon`。不看中间步骤的日志：日志说「布过了」而板子上没有
 * 走线，交付出去就是空的。
 *
 * 两个必须按块解析的原因：KiCad 把封装里的 `(layers "F.Cu" "F.Paste")` 也写成 layers，
 * 直接取第一个会拿到封装的层表；布线器写 segment 时一行一个字段，不是单行。
 */

export interface CoverageLayer {
  readonly name: string;
  readonly role: string;
  readonly state: string;
  readonly tracks: number;
  readonly zones: number;
  readonly filled: number;
}

export interface CoverageSummary {
  readonly copper: number;
  readonly signalLayers: number;
  readonly planeLayers: number;
  readonly emptyLayers: number;
}

export interface CoverageReport {
  readonly layers: readonly CoverageLayer[];
  readonly summary: CoverageSummary;
}

/**
 * 取 `(tag … )` 块：按 \b 定位开括号（这样 `(zone` 不会命中 `(zone_connect`），
 * 再从那里按括号配平到对应 `)`，跳过引号里的括号。
 */
function blocksOf(text: string, tag: string): string[] {
  const blocks: string[] = [];
  const opener = new RegExp("\\(" + tag + "\\b", "gu");
  let hit = opener.exec(text);
  while (hit !== null) {
    const start = hit.index;
    let depth = 0;
    let quote = false;
    let end = -1;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === '"') {
        quote = !quote;
        continue;
      }
      if (quote) continue;
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end < 0) break;
    blocks.push(text.slice(start, end + 1));
    opener.lastIndex = end + 1;
    hit = opener.exec(text);
  }
  return blocks;
}

/** 板子的铜层表：取 .Cu 层最多的那个 `(layers …)` 块（封装的层表只会有两三层）。 */
function copperLayersOf(text: string): string[] {
  let best: string[] = [];
  for (const block of blocksOf(text, "layers")) {
    const names: string[] = [];
    for (const item of block.match(/"[^"]+"/gu) ?? []) {
      const name = item.replace(/"/gu, "");
      if (/\.Cu$/u.test(name) && !names.includes(name)) names.push(name);
    }
    if (names.length > best.length) best = names;
  }
  return best;
}

function layerOf(block: string): string {
  const hit = /\(layer\s+"?([A-Za-z0-9.]+)"?\)/u.exec(block);
  return hit === null ? "" : hit[1]!;
}

export function coverageOf(text: string): CoverageReport {
  const copper = copperLayersOf(text);
  const segments = blocksOf(text, "segment").map(layerOf).filter((name) => name !== "");
  const zones = blocksOf(text, "zone")
    .map((block) => ({ layer: layerOf(block), filled: block.includes("filled_polygon") }))
    .filter((zone) => zone.layer !== "");
  const layers: CoverageLayer[] = copper.map((name) => {
    const tracks = segments.filter((layer) => layer === name).length;
    const own = zones.filter((zone) => zone.layer === name);
    const filled = own.filter((zone) => zone.filled).length;
    const role = name === "F.Cu" || name === "B.Cu" ? "外层" : own.length > 0 ? "内层平面" : "内层";
    let state = "空";
    if (own.length > 0) state = filled === own.length ? "铺铜已填充" : "铺铜未填充";
    else if (tracks > 0) state = "只有信号";
    return { name, role, state, tracks, zones: own.length, filled };
  });
  return {
    layers,
    summary: {
      copper: layers.length,
      signalLayers: layers.filter((layer) => layer.tracks > 0).length,
      planeLayers: layers.filter((layer) => layer.zones > 0).length,
      emptyLayers: layers.filter((layer) => layer.tracks === 0 && layer.zones === 0).length,
    },
  };
}
