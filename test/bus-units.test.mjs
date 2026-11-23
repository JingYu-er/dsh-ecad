import test from "node:test";
import assert from "node:assert/strict";

import { analyzeBuses } from "../lib/engine/ecad/pcb/bus.js";

function board(segments) {
  const nets = new Map();
  const pads = [];
  const lines = [];
  for (const segment of segments) {
    if (!nets.has(segment.net)) nets.set(segment.net, nets.size + 1);
    const id = nets.get(segment.net);
    if (!lines.some((line) => line.includes('"' + segment.net + '"'))) lines.push('\t(net ' + String(id) + ' "' + segment.net + '")');
    pads.push(
      "\t(segment (start " + String(segment.x1) + " " + String(segment.y1) + ") (end " + String(segment.x2) + " " + String(segment.y2) +
        ") (width " + String(segment.width ?? 0.25) + ") (layer \"" + (segment.layer ?? "F.Cu") + "\") (net " + String(id) + "))",
    );
  }
  return "(kicad_pcb (version 20240108)\n" + lines.join("\n") + "\n" + pads.join("\n") + "\n)\n";
}

test("总线体检：三根不同网络等距平行线不报，间距不一致才报（S236）", () => {
  const even = board([
    { net: "A0", x1: 0, y1: 0, x2: 5, y2: 0 },
    { net: "A1", x1: 0, y1: 0.2, x2: 5, y2: 0.2 },
    { net: "A2", x1: 0, y1: 0.4, x2: 5, y2: 0.4 },
  ]);
  const evenReport = analyzeBuses(even);
  assert.equal(evenReport.ok, true);
  assert.equal(evenReport.groups.length, 1);
  assert.equal(evenReport.groups[0].lines, 3);
  assert.equal(evenReport.groups[0].unevenMm, 0);
  assert.equal(evenReport.findings.some((finding) => finding.id === "bus.uneven-spacing"), false);

  const uneven = board([
    { net: "A0", x1: 0, y1: 0, x2: 5, y2: 0 },
    { net: "A1", x1: 0, y1: 0.2, x2: 5, y2: 0.2 },
    { net: "A2", x1: 0, y1: 0.6, x2: 5, y2: 0.6 },
  ]);
  const unevenReport = analyzeBuses(uneven);
  const finding = unevenReport.findings.find((item) => item.id === "bus.uneven-spacing");
  assert.ok(finding);
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /间距 0\.2–0\.4 mm/);
});

test("总线体检：同一网络的线不算总线，电源主干夹细段要报（S236）", () => {
  const sameNet = board([
    { net: "GND", x1: 0, y1: 0, x2: 5, y2: 0 },
    { net: "GND", x1: 0, y1: 0.2, x2: 5, y2: 0.2 },
    { net: "GND", x1: 0, y1: 0.4, x2: 5, y2: 0.4 },
  ]);
  assert.equal(analyzeBuses(sameNet).groups.length, 0);

  const trunk = board([
    { net: "V3V3", x1: 0, y1: 0, x2: 6, y2: 0, width: 0.5 },
    { net: "V3V3", x1: 6, y1: 0, x2: 12, y2: 0, width: 0.5 },
    { net: "V3V3", x1: 12, y1: 0, x2: 14, y2: 0, width: 0.2 },
  ]);
  const trunkReport = analyzeBuses(trunk);
  const finding = trunkReport.findings.find((item) => item.id === "bus.trunk-narrower");
  assert.ok(finding);
  assert.equal(finding.severity, "info");
  assert.equal(trunkReport.trunks[0].dominantMm, 0.5);
  assert.equal(trunkReport.trunks[0].narrow, 1);
});

test("总线体检：有铺铜的网络不判主干宽度", () => {
  const text =
    "(kicad_pcb (version 20240108)\n\t(net 1 \"GND\")\n" +
    "\t(segment (start 0 0) (end 6 0) (width 0.5) (layer \"F.Cu\") (net 1))\n" +
    "\t(segment (start 6 0) (end 9 0) (width 0.2) (layer \"F.Cu\") (net 1))\n" +
    "\t(zone (net 1) (layer \"F.Cu\") (filled_polygon (pts (xy 0 0) (xy 10 0) (xy 10 5) (xy 0 5))))\n" +
    ")\n";
  const report = analyzeBuses(text);
  assert.equal(report.trunks.length, 0);
  assert.equal(report.findings.some((finding) => finding.id === "bus.trunk-narrower"), false);
  assert.ok(report.findings.some((finding) => finding.id === "bus.poured-nets"));
});
