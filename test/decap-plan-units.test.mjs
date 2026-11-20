import assert from "node:assert/strict";
import { test } from "node:test";

import { planDecaps } from "../lib/engine/ecad/pcb/decap-plan.js";

test("去耦配对：每颗电容归给同网最近的电源脚（S204）", () => {
  const pins = [
    { ref: "U1", pin: "1", net: "V3V3", x: 0, y: 0 },
    { ref: "U1", pin: "48", net: "V3V3", x: 20, y: 0 },
  ];
  const caps = [
    { ref: "C1", net: "V3V3", x: 1, y: 1 },
    { ref: "C2", net: "V3V3", x: 19, y: 1 },
  ];
  const plan = planDecaps(pins, caps);
  assert.equal(plan.pins.length, 2);
  const pin1 = plan.pins.find((pin) => pin.pin === "1");
  const pin48 = plan.pins.find((pin) => pin.pin === "48");
  assert.deepEqual(pin1.caps.map((pair) => pair.cap), ["C1"]);
  assert.deepEqual(pin48.caps.map((pair) => pair.cap), ["C2"]);
  assert.equal(pin1.nearestMm, 1.41);
  assert.equal(plan.unpaired.length, 0);
});

test("去耦配对：多颗电容挤同一脚时只报最近的一颗距离，并数出拥挤（S204）", () => {
  const pins = [{ ref: "U1", pin: "8", net: "VCC", x: 0, y: 0 }];
  const caps = [
    { ref: "C1", net: "VCC", x: 0.5, y: 0 },
    { ref: "C2", net: "VCC", x: 1, y: 0 },
    { ref: "C3", net: "VCC", x: 2, y: 0 },
    { ref: "C4", net: "VCC", x: 30, y: 0 },
  ];
  const plan = planDecaps(pins, caps);
  assert.equal(plan.pins[0].caps.length, 4);
  assert.equal(plan.pins[0].nearestMm, 0.5);
  assert.equal(plan.pins[0].crowded, 3);
});

test("去耦配对：网络上没有电源脚时电容进 unpaired，不硬配（S204）", () => {
  const pins = [{ ref: "U1", pin: "1", net: "V3V3", x: 0, y: 0 }];
  const caps = [
    { ref: "C9", net: "VBUS", x: 5, y: 5 },
    { ref: "C1", net: "V3V3", x: 1, y: 0 },
  ];
  const plan = planDecaps(pins, caps);
  assert.deepEqual(plan.unpaired, ["C9"]);
  assert.equal(plan.pins[0].caps[0].cap, "C1");
  assert.match(plan.notes.join(" "), /没有电源输入脚/u);
});

test("去耦配对：一个网络多个脚、电容少于脚数时，没分到电容的脚如实列出（S204）", () => {
  const pins = [
    { ref: "U1", pin: "1", net: "VCC", x: 0, y: 0 },
    { ref: "U1", pin: "2", net: "VCC", x: 40, y: 0 },
  ];
  const caps = [{ ref: "C1", net: "VCC", x: 1, y: 0 }];
  const plan = planDecaps(pins, caps);
  assert.equal(plan.pins.find((pin) => pin.pin === "1").nearestMm, 1);
  assert.equal(plan.pins.find((pin) => pin.pin === "2").nearestMm, null);
  assert.match(plan.notes.join(" "), /有 1 个电源脚所在网络上没有电容/u);
});

test("去耦配对：没有电源脚也没有电容时不炸（S204）", () => {
  const plan = planDecaps([], []);
  assert.deepEqual(plan.pins, []);
  assert.deepEqual(plan.unpaired, []);
  assert.deepEqual(plan.notes, []);
});
