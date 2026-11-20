/**
 * 去耦电容与电源输入脚的配对。
 *
 * 为什么不是「每颗电容离最近焊盘多远」：一颗芯片常有十几个 VCC 脚，
 * 一个网络上又有十几颗电容，逐颗判距离必然误报——装在 pin 3 旁边的电容
 * 对 pin 48 就是「远」，但它本来也不该服务 pin 48。
 *
 * 正确的问法是反过来的：**每个电源输入脚旁边有没有电容**，以及
 * **每颗电容实际站到了哪个脚旁边**。所以这里做一次「就近指派」：
 * 每颗电容归给同网络里离它最近的电源输入脚，然后按脚统计。
 *
 * 电源输入脚来自原理图（`power_in` 电气类型）：PCB 上的焊盘只有编号，
 * 不知道哪根是电流入口。
 */

export interface DecapPin {
  readonly ref: string;
  readonly pin: string;
  readonly net: string;
  readonly x: number;
  readonly y: number;
}

export interface DecapCap {
  readonly ref: string;
  readonly net: string;
  readonly x: number;
  readonly y: number;
}

export interface DecapPair {
  readonly cap: string;
  readonly ref: string;
  readonly pin: string;
  readonly net: string;
  readonly distanceMm: number;
}

export interface DecapPinReport {
  readonly ref: string;
  readonly pin: string;
  readonly net: string;
  /** 归到这个脚的电容，按距离升序。 */
  readonly caps: readonly DecapPair[];
  /** 最近的电容距离；没有同网电容时为 null。 */
  readonly nearestMm: number | null;
  /** 5 mm 内的电容颗数（判断摆位空间够不够）。 */
  readonly crowded: number;
}

export interface DecapPlan {
  readonly pins: readonly DecapPinReport[];
  /** 网络里没有任何电源输入脚、因此没法对位的电容。 */
  readonly unpaired: readonly string[];
  readonly notes: readonly string[];
}

export interface DecapPlanOptions {
  /** 判断「拥挤」的半径，默认 5 mm。 */
  readonly crowdedMm?: number;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function planDecaps(
  pins: readonly DecapPin[],
  caps: readonly DecapCap[],
  options: DecapPlanOptions = {},
): DecapPlan {
  const crowdedMm = options.crowdedMm ?? 5;
  const capsByNet = new Map<string, DecapCap[]>();
  for (const cap of caps) {
    const list = capsByNet.get(cap.net);
    if (list === undefined) capsByNet.set(cap.net, [cap]);
    else list.push(cap);
  }

  const pinsByNet = new Map<string, DecapPin[]>();
  for (const pin of pins) {
    const list = pinsByNet.get(pin.net);
    if (list === undefined) pinsByNet.set(pin.net, [pin]);
    else list.push(pin);
  }

  // 每颗电容归给它同网络里最近的电源脚。
  const assigned = new Map<string, DecapPair[]>();
  const unpaired: string[] = [];
  const usedCaps = new Set<string>();
  for (const [net, list] of capsByNet) {
    const candidates = pinsByNet.get(net) ?? [];
    if (candidates.length === 0) {
      for (const cap of list) unpaired.push(cap.ref);
      continue;
    }
    for (const cap of list) {
      let best: DecapPin | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const pin of candidates) {
        const d = distance(cap, pin);
        if (d < bestDistance) {
          best = pin;
          bestDistance = d;
        }
      }
      if (best === null) continue;
      const pair: DecapPair = {
        cap: cap.ref,
        ref: best.ref,
        pin: best.pin,
        net,
        distanceMm: Math.round(bestDistance * 100) / 100,
      };
      const key = best.ref + "." + best.pin;
      const bucket = assigned.get(key);
      if (bucket === undefined) assigned.set(key, [pair]);
      else bucket.push(pair);
      usedCaps.add(cap.ref);
    }
  }

  const reports: DecapPinReport[] = [];
  for (const pin of pins) {
    const bucket = assigned.get(pin.ref + "." + pin.pin) ?? [];
    const sorted = [...bucket].sort((a, b) => a.distanceMm - b.distanceMm);
    reports.push({
      ref: pin.ref,
      pin: pin.pin,
      net: pin.net,
      caps: sorted,
      nearestMm: sorted.length === 0 ? null : sorted[0]!.distanceMm,
      crowded: bucket.filter((pair) => pair.distanceMm <= crowdedMm).length,
    });
  }
  reports.sort((a, b) => (a.ref === b.ref ? a.pin.localeCompare(b.pin, "en") : a.ref.localeCompare(b.ref, "en")));

  const notes: string[] = [];
  if (unpaired.length > 0) {
    notes.push(
      "这些电容所在网络没有电源输入脚，未参与对位（可能是整体储能或电源入口电容）：" + unpaired.join("、"),
    );
  }
  const uncovered = reports.filter((pin) => pin.nearestMm === null);
  if (uncovered.length > 0) {
    notes.push(
      "有 " +
        uncovered.length +
        " 个电源脚所在网络上没有电容（由平面或远端电容供电时属正常，但没有平面就该补）：" +
        uncovered.map((pin) => pin.ref + "." + pin.pin + "(" + pin.net + ")").join("、"),
    );
  }
  return { pins: reports, unpaired, notes };
}
