// 工具链路守卫：注册面、命名、描述与「不与固件插件撞名」四件事一次查完。
//
// 起不到进程：stub ctx 只收 register 结果，随后逐条检查工具定义。
// 运行：node test/tool-contract-units.test.mjs（需先 npm run build）

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

/** 当前对外承诺的工具清单（新增/删除都会在这里显形）。 */
const GOLDEN = [
  "ecad_ds_fetch",
  "ecad_ds_list",
  "ecad_ds_lookup",
  "ecad_layout_fix",
  "ecad_part_search",
  "ecad_pdf_read",
  "ecad_sch_check",
  "ecad_sch_pins",
  "ecad_sch_read",
  "ecad_sch_review",
  "ecad_sch_to_ioc",
  "stm32_bom",
  "stm32_brief",
  "stm32_ecad_build",
  "stm32_ecad_check",
  "stm32_ecad_design",
  "stm32_ecad_export",
  "stm32_ecad_init",
  "stm32_ecad_libs",
  "stm32_ecad_package",
  "stm32_ecad_step",
  "stm32_emc",
  "stm32_impedance",
  "stm32_mech",
  "stm32_netgate",
  "stm32_part_import",
  "stm32_pcb_3d",
  "stm32_pcb_autoroute",
  "stm32_pcb_gerber",
  "stm32_pcb_ipc",
  "stm32_pcb_layout",
  "stm32_pcb_links",
  "stm32_pcb_routing",
  "stm32_pcb_layers",
  "stm32_ecad_verify",
  "stm32_pcb_place",
  "stm32_pcb_render",
  "stm32_pcb_route",
  "stm32_pcb_swap",
  "stm32_power",
  "stm32_sch_draw",
  "stm32_sch_edit",
  "stm32_sch_import",
  "stm32_sch_sync",
  "stm32_stackup",
  "stm32_symbol_footprint",
];

async function collectTools() {
  const mod = await import(pathToFileURL(join(process.cwd(), "lib", "index.js")).href);
  const tools = [];
  const noop = () => {};
  const base = {
    tools: {
      register(definition) {
        tools.push(definition);
        return noop;
      },
    },
    inject: (_deps, fn) => {
      try {
        fn(base);
      } catch {
        /* 与工具注册无关的失败不影响这份清单 */
      }
    },
    on: noop,
    emit: noop,
    effect: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    subprocess: { spawn: noop, resolveExecutable: async () => "" },
    jobs: { start: () => "job" },
  };
  const ctx = new Proxy(base, { get: (target, key) => (key in target ? target[key] : undefined) });
  mod.apply(ctx);
  return tools;
}

test("工具链路：注册 46 个，名字、描述、参数与输出齐备", async () => {
  const tools = await collectTools();
  const names = tools.map((item) => String(item.name));
  assert.deepEqual([...names].sort(), [...GOLDEN].sort(), "工具清单与约定的 46 个不一致");
  assert.equal(new Set(names).size, names.length, "工具名有重复");
  for (const def of tools) {
    assert.equal(typeof def.description, "string", def.name + " 缺 description");
    assert.ok(def.description.length >= 8, def.name + " 的 description 太短");
    assert.ok(def.parameters !== undefined, def.name + " 缺 parameters");
    assert.equal(def.parameters.type, "object", def.name + " 的 parameters 必须是 object");
    assert.ok(def.output !== undefined, def.name + " 缺 output");
    assert.ok(def.output.schema !== undefined, def.name + " 缺 output.schema");
    assert.equal(typeof def.execute, "function", def.name + " 缺 execute");
  }
});

test("工具链路：54 处可并发标记与超时都给了明确值", async () => {
  const tools = await collectTools();
  const noTimeout = tools.filter((def) => typeof def.timeoutMs !== "number" || def.timeoutMs <= 0).map((def) => def.name);
  assert.deepEqual(noTimeout, [], "这些工具没给 timeoutMs：\n" + noTimeout.join("\n"));
  const safe = tools.filter((def) => def.isConcurrencySafe === undefined).map((def) => def.name);
  assert.deepEqual(safe, [], "这些工具没声明 isConcurrencySafe：\n" + safe.join("\n"));
});

test("工具链路：与固件插件 dsh-stm32 不撞名", async (t) => {
  const siblings = join(process.cwd(), "..", "dsh-stm32", "src", "tools");
  if (!existsSync(siblings)) {
    t.skip("同级目录没有 dsh-stm32 仓库，跳过撞名检查");
    return;
  }
  const theirs = new Set();
  for (const file of readdirSync(siblings)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(siblings, file), "utf8");
    for (const matched of text.matchAll(/_TOOL = "([a-z0-9_]+)"/gu)) {
      if (matched[1] !== undefined) theirs.add(matched[1]);
    }
  }
  assert.ok(theirs.size > 20, "没能从 dsh-stm32 里读出工具名（实际 " + String(theirs.size) + " 个）");
  const tools = await collectTools();
  const shared = tools.map((item) => String(item.name)).filter((name) => theirs.has(name));
  assert.deepEqual(shared, [], "这些工具名与 dsh-stm32 重复，两个插件同时装会撞注册表：\n" + shared.join("\n"));
});
