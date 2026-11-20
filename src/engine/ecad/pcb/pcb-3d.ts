/**
 * 板子的 3D 骨架：板厚 + 每个元件的包围盒（S209）。
 *
 * 只做「看得见形状」这一层：不读 STEP 模型、不做真实贴图，浏览器端按包围盒挤出并
 * 用正交投影画出来。高度是按焊盘尺寸与数量估的——真实高度要 3D 模型才有，所以
 * 每个盒子都带 `estimated: true`，面板上要说明「高度是估算」。
 */
import type { PcbScene } from "./scene.js";

export interface ComponentBox3 {
  readonly ref: string;
  /** 板面坐标（mm，与板图同一坐标系）。 */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** 估算高度（mm）。 */
  readonly heightMm: number;
  readonly side: "top" | "bottom";
  readonly estimated: true;
}

export interface BoardBox3 {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** 板厚（mm）：从 `(general (thickness …))` 来，缺省 1.6。 */
  readonly thicknessMm: number;
}

const PAD_PAD_MM = 0.25;

/** 估高度：先看焊盘面积与数量，再看位号前缀。 */
function estimateHeight(padCount: number, maxPad: number): number {
  if (padCount >= 16) return 1.6;
  if (padCount >= 6) return 1.2;
  if (maxPad >= 1.4) return 2.5;
  if (maxPad >= 1.0) return 1.0;
  return 0.5;
}

export function componentBoxes(scene: PcbScene): ComponentBox3[] {
  const groups = new Map<string, { x0: number; y0: number; x1: number; y1: number; count: number; maxPad: number; side: "top" | "bottom" }>();
  for (const pad of scene.pads) {
    if (pad.ref === "") continue;
    const halfW = Math.max(pad.width, 0.2) / 2;
    const halfH = Math.max(pad.height, 0.2) / 2;
    const group = groups.get(pad.ref);
    if (group === undefined) {
      groups.set(pad.ref, {
        x0: pad.x - halfW,
        y0: pad.y - halfH,
        x1: pad.x + halfW,
        y1: pad.y + halfH,
        count: 1,
        maxPad: Math.max(pad.width, pad.height),
        side: pad.side === "bottom" ? "bottom" : "top",
      });
      continue;
    }
    group.x0 = Math.min(group.x0, pad.x - halfW);
    group.y0 = Math.min(group.y0, pad.y - halfH);
    group.x1 = Math.max(group.x1, pad.x + halfW);
    group.y1 = Math.max(group.y1, pad.y + halfH);
    group.count += 1;
    group.maxPad = Math.max(group.maxPad, pad.width, pad.height);
  }
  const boxes: ComponentBox3[] = [];
  for (const [ref, group] of groups) {
    boxes.push({
      ref,
      x0: group.x0 - PAD_PAD_MM,
      y0: group.y0 - PAD_PAD_MM,
      x1: group.x1 + PAD_PAD_MM,
      y1: group.y1 + PAD_PAD_MM,
      heightMm: estimateHeight(group.count, group.maxPad),
      side: group.side,
      estimated: true,
    });
  }
  boxes.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return boxes;
}

export function boardBox3(scene: PcbScene, thicknessMm = 1.6): BoardBox3 | null {
  const box = scene.bbox;
  if (box === null) return null;
  return { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height, thicknessMm };
}
