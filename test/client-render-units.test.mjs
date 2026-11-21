// 为什么要有这个套件：硬件台已经两次「点一下整片空白」，两次都是渲染期抛异常
// （D32_* 未定义、hooks 顺序变化）。宿主的真 React 遇到这种异常会把整棵子树卸载，
// 表现是空白，而不是报错——所以必须在离线环境里把「点得下去」这件事测出来。
//
// 做法：最小 hooks 运行时（useState 能真的改并触发重渲染、useEffect 真的跑），
// 把面板渲染出来，然后按按钮文案挨个点一遍；任何一次渲染抛异常都算失败。
import { test } from "node:test";
import assert from "node:assert/strict";

const BOARD = {
  ok: true,
  error: "",
  file: "board.kicad_pcb",
  copperLayers: 2,
  svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  width: 10,
  height: 10,
  widthMm: 62,
  heightMm: 104,
  pads: 3,
  tracks: 2,
  innerTracks: 0,
  vias: 1,
  elements: 1,
  board3d: { x0: 0, y0: 0, x1: 62, y1: 104, thicknessMm: 1.6 },
  boxes: [{ ref: "U1", x0: 1, y0: 1, x1: 6, y1: 6, heightMm: 1.6, side: "F", estimated: true }],
  focus: "",
  notes: [],
};

/** 每个接口的假回包：只求形状对，不求数值真。 */
const ROUTES = [
  ["ecad/pcb", { pcbView: BOARD }],
  ["ecad/layout-check", { layoutCheck: { ok: true, error: "", boardFile: "b.kicad_pcb", widthMm: 62, heightMm: 104, findings: [{ id: "layout.decap-far", severity: "warning", message: "C10 离 U3 的电源脚 12.2 mm", fix: "挪近", refs: ["C10", "U3"] }], notes: [], decap: { pins: 2, paired: 1, uncovered: 1 } } }],
  ["ecad/bom", { bom: { ok: true, error: "", lines: [{ refs: ["R1"], qty: 1, value: "10k", footprint: "0603", lcsc: "C1", unitPriceUsd: 0.01, subtotalUsd: 0.01, alternates: [], notes: [] }], componentCount: 1, priced: 1, partsUsd: 0.01, notes: [] } }],
  ["ecad/schematic", { schematic: { ok: true, error: "", widthMm: 0, heightMm: 0, components: [], nets: [], findings: [], diagram: { blocks: [], links: [], powerNets: [] }, notes: [] } }],
  ["ecad?projectDir", { ecad: { ok: true, error: "", initialized: true, installed: true, entries: ["index.circuit.tsx"], workspace: { circuitDir: "hardware/circuit", kicadDir: "hardware/kicad", libsDir: "hardware/libs", outDir: "hardware/out" }, runtime: { ready: true, linked: true, root: "runtime", bytes: 1, error: "" }, latest: null, autoBuild: null, notes: [] } }],
];

function stubFetch() {
  return async (url) => {
    const hit = ROUTES.find(([key]) => String(url).includes(key));
    const body = hit === undefined ? { ok: false, error: "没打桩：" + String(url) } : { ok: true, ...hit[1] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

/** 最小 hooks 运行时：够跑面板，且 setState 真的会触发重渲染。 */
function makeRuntime() {
  let slots = [];
  let cursor = 0;
  let pending = false;
  const effects = [];
  let cleanups = [];
  const state = { current: null };

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: "Fragment",
    Component: class {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
    },
    useState: (initial) => {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      const set = (value) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (Object.is(next, slots[index])) return;
        slots[index] = next;
        pending = true;
      };
      return [slots[index], set];
    },
    useEffect: (callback) => {
      effects.push(callback);
    },
    useCallback: (callback) => callback,
    useMemo: (callback) => callback(),
    useRef: (initial) => {
      const index = 1000 + cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { current: initial ?? null };
      return slots[index];
    },
    createContext: () => ({ Provider: "Provider", Consumer: "Consumer" }),
  };

  const textOf = (node) => {
    if (node === null || node === undefined || node === false || node === true) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(" ");
    // 渲染后的文本节点是 {text, children: []}：先取自身文本，再拼子节点。
    const own = typeof node.text === "string" ? node.text : "";
    return own + " " + node.children.map(textOf).join(" ");
  };

  const renderNode = (node) => {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === "string" || typeof node === "number") return { text: String(node), props: {}, children: [] };
    if (Array.isArray(node)) return node.map(renderNode);
    const props = Object.assign({}, node.props, { children: node.children });
    if (typeof node.type === "function") {
      // 类组件：真 React 会 new 出来再 render；函数组件直接调用。
      if (node.type.prototype !== undefined && typeof node.type.prototype.render === "function") {
        const instance = new node.type(props);
        instance.state = instance.state ?? {};
        if (typeof node.type.getDerivedStateFromError === "function" && state.current !== null) {
          instance.state = Object.assign({}, instance.state, node.type.getDerivedStateFromError(state.current));
        }
        return renderNode(instance.render());
      }
      return renderNode(node.type(props));
    }
    const kids = node.children.map(renderNode);
    return { type: node.type, props, text: textOf(props.children), children: kids };
  };

  const walk = (tree, visit) => {
    if (tree === null || tree === undefined) return;
    if (Array.isArray(tree)) {
      for (const item of tree) walk(item, visit);
      return;
    }
    visit(tree);
    for (const kid of tree.children) walk(kid, visit);
  };

  const api = {
    React,
    /** 全量渲染一次（含 effects），直到没有新的 state 变化。 */
    render: async (Component, props) => {
      for (let pass = 0; pass < 12; pass += 1) {
        cursor = 0;
        pending = false;
        effects.length = 0;
        state.current = null;
        for (const cleanup of cleanups) cleanup();
        cleanups = [];
        const tree = renderNode(React.createElement(Component, props));
        for (const callback of effects) {
          const cleanup = callback();
          if (typeof cleanup === "function") cleanups.push(cleanup);
        }
        // 让 fetch 的 promise 落地，再决定要不要重渲染。
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!pending) return tree;
      }
      return renderNode(React.createElement(Component, props));
    },
    /** 按文案找按钮并点它；返回点完之后的新树。 */
    click: async (Component, props, matcher) => {
      const tree = await api.render(Component, props);
      const buttons = [];
      walk(tree, (node) => {
        if (node !== null && node !== undefined && node.type === "button") buttons.push(node);
      });
      const target = buttons.find((button) => matcher(button.text));
      if (target === undefined) return { clicked: false, tree };
      const onClick = target.props.onClick;
      if (typeof onClick !== "function") return { clicked: false, tree };
      onClick({ target: { checked: true }, preventDefault: () => undefined, currentTarget: { style: {} } });
      const next = await api.render(Component, props);
      return { clicked: true, tree: next, label: target.text };
    },
    textOf,
    walk,
  };
  return api;
}

test("硬件台：每个页签、每个开关都点得下去，不会把面板点成空白（S212）", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let loaded = null;
  const runtime = makeRuntime();
  globalThis.window = {
    devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    __ModuleLoader__: { load: (definition) => { loaded = definition; } },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    fetch: stubFetch(),
  };
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ id: "", textContent: "", appendChild: () => undefined }),
    head: { appendChild: () => undefined },
    body: { appendChild: () => undefined },
  };
  globalThis.fetch = globalThis.window.fetch;
  // 面板里的轮询用 setInterval：离线运行时把它换成不触发的桩，
  // 否则 effect 每跑一轮就多一个定时器，测试进程永远退不出去。
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => undefined;
  try {
    Object.assign(globalThis.window, {});
    await import("../lib/client.js");
    assert.ok(loaded !== null, "client.js 必须调用 __ModuleLoader__.load");
    const module = loaded.factory((name) => (name === "react" ? runtime.React : {}));
    const registered = [];
    module.apply({
      effect: (callback) => callback(),
      slots: {
        inject: (name, callback) => callback(),
        register: (definition, component) => {
          registered.push({ definition, component });
          return () => undefined;
        },
      },
    });
    const view = registered.find((item) => item.definition.name === "conversation.view");
    assert.ok(view !== undefined, "硬件台槽位必须注册");
    const props = { sessionId: "s1", projectDir: "D:/fake/project" };

    // 初始渲染：先确认带工程时能出板图与页签。
    const first = await runtime.render(view.component, props);
    const firstText = runtime.textOf(first);
    if (!firstText.includes("概览")) console.log("FIRST TEXT:", firstText.slice(0, 400));
    for (const label of ["概览", "事件", "流程图", "电路设计", "故障"]) {
      assert.ok(firstText.includes(label), "页签缺 " + label);
    }
    // 默认页必须是电路设计：串口 / RTT / 监视是固件侧的东西，不该是硬件台的首页（S213）。
    assert.ok(firstText.includes("器件搜索"), "默认页应是电路设计（首屏有器件搜索）：" + firstText.slice(0, 200));
    assert.equal(firstText.includes("串口"), false, "硬件台不该再出串口通道");
    assert.equal(firstText.includes("RTT"), false, "硬件台不该再出 RTT 通道");

    // 逐个页签点一遍：任何一次渲染抛异常都会在这里冒出来。
    for (const label of ["概览", "事件", "流程图", "电路设计", "故障"]) {
      const result = await runtime.click(view.component, props, (text) => text.trim() === label);
      if (result.clicked) {
        assert.ok(runtime.textOf(result.tree).length > 0, "点 " + label + " 之后面板不能是空的");
      }
    }

    // 电路设计里的开关与动作按钮：板图视图切换、层开关、刷新、连接 KiCad。
    await runtime.click(view.component, props, (text) => text.trim() === "电路设计");
    for (const label of ["2D 板图", "3D 草图", "刷新", "连接 KiCad", "顶层", "位号"]) {
      const result = await runtime.click(view.component, props, (text) => text.trim() === label || text.includes(label));
      if (result.clicked) {
        assert.ok(runtime.textOf(result.tree).length > 0, "点 " + label + " 之后面板不能是空的");
      }
    }
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
