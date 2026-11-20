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
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
export function planDecaps(pins, caps, options = {}) {
    const crowdedMm = options.crowdedMm ?? 5;
    const capsByNet = new Map();
    for (const cap of caps) {
        const list = capsByNet.get(cap.net);
        if (list === undefined)
            capsByNet.set(cap.net, [cap]);
        else
            list.push(cap);
    }
    const pinsByNet = new Map();
    for (const pin of pins) {
        const list = pinsByNet.get(pin.net);
        if (list === undefined)
            pinsByNet.set(pin.net, [pin]);
        else
            list.push(pin);
    }
    // 每颗电容归给它同网络里最近的电源脚。
    const assigned = new Map();
    const unpaired = [];
    const usedCaps = new Set();
    for (const [net, list] of capsByNet) {
        const candidates = pinsByNet.get(net) ?? [];
        if (candidates.length === 0) {
            for (const cap of list)
                unpaired.push(cap.ref);
            continue;
        }
        for (const cap of list) {
            let best = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const pin of candidates) {
                const d = distance(cap, pin);
                if (d < bestDistance) {
                    best = pin;
                    bestDistance = d;
                }
            }
            if (best === null)
                continue;
            const pair = {
                cap: cap.ref,
                ref: best.ref,
                pin: best.pin,
                net,
                distanceMm: Math.round(bestDistance * 100) / 100,
            };
            const key = best.ref + "." + best.pin;
            const bucket = assigned.get(key);
            if (bucket === undefined)
                assigned.set(key, [pair]);
            else
                bucket.push(pair);
            usedCaps.add(cap.ref);
        }
    }
    const reports = [];
    for (const pin of pins) {
        const bucket = assigned.get(pin.ref + "." + pin.pin) ?? [];
        const sorted = [...bucket].sort((a, b) => a.distanceMm - b.distanceMm);
        reports.push({
            ref: pin.ref,
            pin: pin.pin,
            net: pin.net,
            caps: sorted,
            nearestMm: sorted.length === 0 ? null : sorted[0].distanceMm,
            crowded: bucket.filter((pair) => pair.distanceMm <= crowdedMm).length,
        });
    }
    reports.sort((a, b) => (a.ref === b.ref ? a.pin.localeCompare(b.pin, "en") : a.ref.localeCompare(b.ref, "en")));
    const notes = [];
    if (unpaired.length > 0) {
        notes.push("这些电容所在网络没有电源输入脚，未参与对位（可能是整体储能或电源入口电容）：" + unpaired.join("、"));
    }
    const uncovered = reports.filter((pin) => pin.nearestMm === null);
    if (uncovered.length > 0) {
        notes.push("有 " +
            uncovered.length +
            " 个电源脚所在网络上没有电容（由平面或远端电容供电时属正常，但没有平面就该补）：" +
            uncovered.map((pin) => pin.ref + "." + pin.pin + "(" + pin.net + ")").join("、"));
    }
    return { pins: reports, unpaired, notes };
}
