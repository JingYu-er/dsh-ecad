const PAD_PAD_MM = 0.25;
/** 估高度：只看焊盘数量。两脚件（阻容、二极管）最薄，多脚 IC 最厚。 */
function estimateHeight(padCount) {
    if (padCount >= 16)
        return 1.6;
    if (padCount >= 6)
        return 1.2;
    if (padCount === 2)
        return 0.6;
    return 1;
}
export function componentBoxes(scene) {
    const groups = new Map();
    for (const pad of scene.pads) {
        if (pad.ref === "")
            continue;
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
                side: pad.side === "bottom" ? "B" : "F",
            });
            continue;
        }
        group.x0 = Math.min(group.x0, pad.x - halfW);
        group.y0 = Math.min(group.y0, pad.y - halfH);
        group.x1 = Math.max(group.x1, pad.x + halfW);
        group.y1 = Math.max(group.y1, pad.y + halfH);
        group.count += 1;
        if (pad.side === "bottom")
            group.side = "B";
    }
    const boxes = [];
    for (const [ref, group] of groups) {
        boxes.push({
            ref,
            x0: group.x0 - PAD_PAD_MM,
            y0: group.y0 - PAD_PAD_MM,
            x1: group.x1 + PAD_PAD_MM,
            y1: group.y1 + PAD_PAD_MM,
            heightMm: estimateHeight(group.count),
            side: group.side,
            estimated: true,
        });
    }
    boxes.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return boxes;
}
export function boardBox3(scene, thicknessMm = 1.6) {
    const box = scene.bbox;
    if (box === null)
        return null;
    return { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height, thicknessMm };
}
