// 为什么要有这个套件：lib/client.js 是手写浏览器模块，不经 tsc，也没有浏览器测试环境。
// 它一旦写错（少一个 require、hooks 用错、槽位注册名写错），表现是"标签不出现"，
// 而且在插件日志里往往无声无息。这里用最小 React/存档器桩把模块跑起来，
// 钉住两件事：两个槽位都注册了；调试台组件能完成一次渲染。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** 最小 React 桩：只实现 client/client.js 用到的 API。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // 错误边界用了 Component（S212）：假 React 也得给一个能继承的基类。
  Component: class {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  },
  Fragment: "Fragment",
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useEffect: () => undefined,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial ?? null }),
  createContext: () => ({ Provider: "Provider", Consumer: "Consumer" }),
};

function stubLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("电路设计页显示共享运行时与最近一次自动构建（S136）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function autoBuildText("));
  assert.ok(source.includes("共享运行时 "));
  assert.ok(source.includes("本工程未挂载"));
  assert.ok(source.includes("依赖已挂载"), "工程级挂载状态与机器共享运行时是两个数，标签要分开");
  assert.ok(source.includes("ecad.autoBuild"));
  assert.ok(source.includes("autoBuild.lastOk === true"));
});

test("设计通过后提示是否导出 STEP 与 Gerber（S137）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("ecad.autoBuild.pendingExport === true"));
  assert.ok(source.includes("现在导出 STEP 与 Gerber 吗"));
  assert.ok(source.includes('runAction("export")'));
});

test("电路设计页有一键设计按钮并渲染步骤（S134）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes('["design", "一键设计"]'));
  assert.ok(source.includes("Array.isArray(outcome.steps)"));
});

test("client.js：注册设置面板与调试台两个槽位，调试台可渲染", async () => {
  const registered = [];
  let loaded = null;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition;
      },
    },
    localStorage: stubLocalStorage(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globalThis.document = { baseURI: "http://127.0.0.1/" };
  try {
    await import("../lib/client.js");
    assert.ok(loaded !== null, "client.js 必须调用 __ModuleLoader__.load");
    assert.equal(loaded.id, "dsh-ecad");
    const exports = loaded.factory((name) => {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return { jsx: React.createElement, jsxs: React.createElement };
      return {};
    });
    assert.deepEqual(exports.inject, ["slots"]);
    const ctx = {
      effect: (callback) => callback(),
      slots: {
        inject: (name, callback) => {
          assert.ok(
            name === "settings.section" || name === "conversation.view" || name === "conversation.session.header.actions" || name === "conversation.chat.turnTail",
            name,
          );
          return callback();
        },
        register: (definition, component) => {
          registered.push({ definition, component });
          return () => undefined;
        },
      },
    };
    exports.apply(ctx);
    assert.equal(registered.length, 4, "设置、硬件台、卡片观察器、卡片本体各一个槽位");
    const settings = registered.find((item) => item.definition.name === "settings.section");
    const debug = registered.find((item) => item.definition.name === "conversation.view");
    assert.ok(settings !== undefined, "设置面板槽位不能丢");
    assert.equal(settings.definition.id, "ecad");
    assert.equal(settings.definition.label(), "电路设计工具链");
    assert.ok(debug !== undefined, "调试台槽位必须注册");
    assert.equal(debug.definition.id, "ecad-hardware");
    assert.equal(debug.definition.label(), "硬件台");
    assert.equal(typeof debug.component, "function");
    assert.equal(typeof debug.definition.inject, "function", "必须从宿主拿 sessionId，否则不能按会话过滤事件");
    assert.deepEqual(debug.definition.inject("session-abc"), { sessionId: "session-abc" });

    // 渲染一次：桩 React 只造元素不执行组件，这里递归展开函数组件，
    // 能暴露"少字段/引用未定义"这类错误，也能验证关键文案确实进了树。
    const renderText = (node) => {
      if (node === null || node === undefined || node === false || node === true) return "";
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(renderText).join(" ");
      // 真 React 会把 children 塞进 props.children；桩把它留在 node.children，
      // 展开组件时补回去，否则面板正文（DebugPanel 的 props.children）会被吞掉。
      if (typeof node.type === "function") {
        const props = Object.assign({}, node.props, { children: node.children });
        // 类组件（错误边界）要 new 出来再 render，直接调用会抛
        // 「Class constructor cannot be invoked without 'new'」。
        if (typeof node.type.prototype?.render === "function") return renderText(new node.type(props).render());
        return renderText(node.type(props));
      }
      return renderText(node.children);
    };
    const settingsText = renderText(React.createElement(settings.component));
    assert.ok(settingsText.includes("电路设计工具链"), "设置页标题要是电路设计工具链：" + settingsText.slice(0, 200));
    assert.equal(settingsText.includes("STM32 工具链"), false, "设置页里不该再出现 STM32 工具链");

    const text = renderText(debug.component({}));
    assert.ok(text.includes("硬件台"), text.slice(0, 300));
    for (const label of ["概览", "事件", "流程图", "电路设计", "故障"]) {
      assert.ok(text.includes(label), "工作区标签要有 " + label + " 页：" + text.slice(0, 500));
    }
    assert.ok(text.includes("工程"), "未选工程时要有工程卡片：" + text.slice(0, 500));
    assert.ok(text.includes("回放…"), "工具栏要有回放入口：" + text.slice(0, 500));
    assert.ok(text.includes("导出 JSONL"), "工具栏要能导出当前视图：" + text.slice(0, 500));
    assert.ok(text.includes("全部事件"), "工具栏要有状态筛选：" + text.slice(0, 500));
    assert.ok(text.includes("复制已选"), "批量复制引用的按钮要常驻：" + text.slice(0, 500));
    assert.ok(!text.includes("引脚"), "固件页签不该再出现：" + text.slice(0, 500));
    assert.ok(!text.includes("时钟"), "固件页签不该再出现：" + text.slice(0, 500));
    const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
    assert.ok(source.includes("硬件侧"), "概览页要说明硬件侧入口");
    assert.ok(source.includes("function EcadPanel("), "电路设计页要在（S99）");
    assert.ok(source.includes("function SchematicPanel("), "流程图页要在（S90）");
    assert.ok(source.includes("function FaultPanel("), "故障页要在");
    assert.ok(!source.includes("function PinoutPanel("), "引脚页已删除（S192）");
    assert.ok(!source.includes("function ClockPanel("), "时钟页已删除（S192）");
    assert.ok(!source.includes("function InterruptPanel("), "中断页已删除（S192）");
    assert.ok(!source.includes("function IocDiffPanel("), "变更页已删除（S192）");
    assert.ok(!source.includes("function ArtifactPanel("), "产物页已删除（S192）");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("电路设计页签：读 /ecad 并给出下一步动作（S99）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.equal(source.includes("function useEcad("), true);
  assert.equal(source.includes("function EcadPanel("), true);
  assert.equal(source.includes('callApi("GET", "ecad?projectDir="'), true);
  assert.equal(source.includes('navItem("ecad", DEBUG_LABELS.ecad)'), true);
  assert.equal(source.includes('tab === "ecad"'), true);
  assert.match(source, /stm32_ecad_init/u);
  assert.match(source, /ecad\/action/u);
  assert.match(source, /const runAction/u);
});

test("电路设计页签：有「打包交付」按钮，动作走同一个端点（S107）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes('["package", "打包交付"]'), "缺少打包交付按钮");
  assert.ok(source.includes("outcome.file"), "结果区要显示交付包路径");
});

test("电路设计结果区显示可制造性与打样成本（S109）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.match(source, /outcome\.dfm/u);
  assert.match(source, /dfm\.approxCny/u);
  assert.match(source, /最细走线/u);
});

test("电路设计页签：数据手册状态与补齐按钮（S120）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.match(source, /dsMissing/);
  assert.match(source, /\["datasheets", "补手册"\]/);
  assert.match(source, /ecad\.datasheets/);
});

test("电路设计页签：手册占用与补手册按钮（S124）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.match(source, /function dsSizeText\(/u);
  assert.match(source, /dsSizeText\(datasheets\)/u);
  assert.match(source, /ecad\.datasheets/u);
});

test("流程图页有一键评审按钮，请求走 /schematic/review（S135）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.equal(source.includes("\"一键评审\""), true);
  assert.equal(source.includes("schematic/review?projectDir="), true);
  assert.equal(source.includes("...reviewRows"), true);
});

test("电路设计页在数据回来之前不读空对象，避免整页空白（S150）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  // 首次渲染时 ecad 必然是 null；直接读 ecad.autoBuild 会抛错，React 卸载整棵子树。
  assert.ok(source.includes("const pendingExport = ecad !== null && ecad !== undefined && ecad.autoBuild !== null"));
  const panel = source.slice(source.indexOf("function EcadPanel("));
  assert.equal(panel.includes("const pendingExport = ecad.autoBuild"), false);
});

test("电路设计页显示布线引擎状态，并可勾选含布线（S146）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("布线引擎未安装"));
  assert.ok(source.includes("含布线"));
  assert.ok(source.includes("pcb: true"));
  assert.ok(source.includes("autoroute.ready"));
});

test("电路设计页能看 BOM：默认只读缓存，点「查价」才联网（S156）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function useBom("));
  assert.ok(source.includes("\"ecad/bom?\""));
  assert.ok(source.includes("\"BOM\""));
  assert.ok(source.includes("\"查价\""));
  assert.ok(source.includes("params.push(\"prices=1\")"), "只有点查价才带 prices=1");
  assert.ok(source.indexOf("function useBom(") < source.indexOf("function EcadPanel("));
});
test("电路设计页能看 EMC 体检：铺铜与电源线宽写在面板上（S158）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function useEmc("));
  assert.ok(source.includes("\"ecad/emc?projectDir=\""));
  assert.ok(source.includes("\"EMC\""));
  assert.ok(source.includes("emc-deep"), "EMC 块要显示深度体检那一行（S167）");
  assert.equal(source.includes("function useNetGate("), true, "电路设计页要有一致性门禁的钩子");
  assert.equal(source.includes("ecad/netgate?projectDir="), true, "一致性门禁走独立接口");
  assert.equal(source.includes("一致性"), true, "面板上要能看到这一块");
  assert.equal(source.includes("手绘层"), true, "面板要显示手绘层与生成图纸的差异");
  assert.ok(source.indexOf("function useNetGate(") < source.indexOf("function EcadPanel("), "钩子要定义在面板之前");
  assert.equal(source.includes("function useImpedance("), true, "叠层块要有阻抗规则按钮的钩子");
  assert.equal(source.includes("ecad/impedance?projectDir="), true, "阻抗规则走独立接口");
  assert.equal(source.includes("写入阻抗规则"), true, "按钮文案要能搜到");
  assert.ok(source.indexOf("function useImpedance(") < source.indexOf("function EcadPanel("), "钩子要定义在面板之前");
  assert.ok(source.includes("回流 "));
  assert.ok(source.indexOf("function useEmc(") < source.indexOf("function EcadPanel("));
});

test("电路设计页能看电源预算：未填电流标待定（S160）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function usePower("));
  assert.ok(source.includes("\"ecad/power?projectDir=\""));
  assert.ok(source.includes("\"电源预算\""));
  assert.ok(source.includes("电流未填"), "未填电流要如实标，不能当 0 A");
  assert.ok(source.indexOf("function usePower(") < source.indexOf("function EcadPanel("));
});

test("电路设计页能看叠层：按工程取阻抗线宽，没有板子就显示提示（S157）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function useStackup("));
  assert.ok(source.includes("\"ecad/stackup?projectDir=\""));
  assert.ok(source.includes("\"叠层\""));
  assert.ok(source.indexOf("function useStackup(") < source.indexOf("function EcadPanel("));
});

test("电路设计页能用自有规则布线（S195）", () => {
  const text = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(text.includes("自有规则布线"));
  assert.ok(text.includes('"route-own"'));
  // 布线完要把引擎的话（线宽分布、细段占比、补布轮次）原样摊开，不能只报「成功」
  assert.ok(text.includes('key: "route-notes"'));
});

test("电路设计页能看板图：按层开关请求 /ecad/pcb，SVG 内联渲染（S151）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function usePcbView("));
  assert.ok(source.includes("\"ecad/pcb?\""));
  assert.ok(source.includes("\"板图\""));
  assert.ok(source.includes("d32-pcb-figure"));
  // 3D 草图（S209）：只要求几何、客户端画；拖动旋转、滚轮缩放、模式落 localStorage。
  assert.ok(source.includes("function Pcb3D("), source.length);
  assert.ok(source.includes("dsh-ecad-pcb-mode"));
  assert.ok(source.includes("e(Pcb3D, "));
  // 点击定位（S210）：BOM 位号与布局发现的「定位」设同一个 pcbFocus，2D 与 3D 共用。
  assert.ok(source.includes('const [pcbFocus, setPcbFocus] = useState("");'), "高亮要有一个共享状态");
  assert.ok(source.includes("usePcbView(projectDir, pcbShow, pcbFocus)"), "板图请求要带上高亮位号");
  assert.ok(source.includes("focus: pcbFocus"), "3D 草图也要吃同一个高亮");
  assert.ok(source.includes("onClick: () => setPcbFocus(ref)"), "点 BOM 位号要能定位");
  assert.ok(source.includes('"定位 " + ref'), "布局发现旁要有定位按钮");
  assert.ok(source.includes("params.push(\"focus=\" + encodeURIComponent(focus))"), "高亮要以 focus 查询参数发给服务端");
  // 回合尾巴卡片（S211）：chain 槽位 + 纯 select + 渲染 null 的观察器。
  assert.ok(source.includes('ctx.slots.inject("conversation.chat.turnTail"'), "卡片要挂在 turnTail 槽位上");
  assert.ok(source.includes("select: (owner) =>"), "chain 槽位要按回合号自我选举");
  assert.ok(source.includes("function TailWatcher(props)"), "观察器只记状态、渲染 null");
  assert.ok(source.includes("function TailCard(props)"), "卡片本体要存在");
  assert.ok(source.includes('"conversation.session.header.actions"'), "观察器挂在会话头部槽位");
  assert.ok(source.includes("stm32_ecad_design: \"一键设计\""), "卡片要认识硬件侧的长任务工具");
  assert.ok(source.includes("连接 KiCad"), "面板要能手动探一次 IPC 连接");
  assert.ok(source.includes('"ecad/ipc?open=1"'), "连不上时请求带 open=1，让插件自己把 KiCad 打开");
  assert.ok(source.includes("reply.value.ipc"), "callApi 已经把回包包进 value，读 ipc 必须先解包");
  // 关掉的层传 0，位号只有显式打开才请求。
  assert.ok(source.includes("params.push(name + \"=0\")"));
  assert.ok(source.includes("params.push(\"refs=1\")"));
  // 钩子必须定义在面板之前，否则运行期引用不到。
  assert.ok(source.indexOf("function usePcbView(") < source.indexOf("function EcadPanel("));
});

test("电路设计页能看需求文档：先看状态，点生成才 POST（S161）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.match(source, /function useBrief\(/u);
  assert.match(source, /"ecad\/brief\?projectDir="/u);
  assert.match(source, /"需求文档"/u);
  assert.match(source, /"生成骨架"/u);
  assert.match(source, /write: true, force: force === true/u);
  assert.equal(source.indexOf("function useBrief(") < source.indexOf("function EcadPanel("), true, "hook 必须在组件之前定义");
});

test("电路设计页能看机械约束：板框与定位孔，点导出才 POST（S162）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.match(source, /function useMech\(/u);
  assert.match(source, /"ecad\/mech\?projectDir="/u);
  assert.match(source, /"机械"/u);
  assert.match(source, /"导出 DXF"/u);
  assert.match(source, /\{ export: true \}/u);
  assert.equal(source.indexOf("function useMech(") < source.indexOf("function EcadPanel("), true, "hook 必须在组件之前定义");
});

test("电路设计页能搜器件：输入关键词才联网（S163）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.match(source, /function useParts\(/u);
  assert.match(source, /"ecad\/parts\?"/u);
  assert.match(source, /器件搜索/u);
  assert.ok(source.indexOf("function useParts(") < source.indexOf("function EcadPanel("), "useParts 要在 EcadPanel 之前定义");
});

test("电路设计页能看布线体检：差分对、平面层与去耦距离（S165）", () => {
  const clientSource = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(clientSource.includes("function useLinks("), "要有 useLinks");
  assert.ok(clientSource.includes("ecad/links?projectDir="), "请求要走 ecad/links");
  assert.ok(clientSource.includes('"布线体检"'), "要有布线体检区块");
  assert.ok(clientSource.indexOf("function useLinks(") < clientSource.indexOf("function EcadPanel("), "hook 要定义在 EcadPanel 之前");
});

test("电路设计页能看制造文件：Gerber 与钻孔画成一张图（S166）", () => {
  const clientSource = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(clientSource.includes("function useGerber("), "要有 useGerber");
  assert.ok(clientSource.includes("ecad/gerber?"), "请求要走 ecad/gerber");
  assert.ok(clientSource.includes('"制造文件"'), "要有制造文件区块");
  assert.ok(clientSource.includes('"F_Cu,Edge_Cuts"'), "默认只看顶层与板框");
  assert.ok(clientSource.indexOf("function useGerber(") < clientSource.indexOf("function EcadPanel("), "hook 要定义在 EcadPanel 之前");
});


test("面板源码里用到的 D32_* 常量都必须定义过（S170.1）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  const used = [...new Set(source.match(/\bD32_[A-Z0-9_]+\b/g) || [])];
  const missing = used.filter((name) => !new RegExp("const " + name + "\\b").test(source));
  assert.deepEqual(missing, [], "引用了没定义的常量：" + missing.join("、") + "（缺一个整个面板都会渲染失败）");
});

test("原理图页签不放编辑区：改图在 KiCad 里做，再按需导入（S170.1）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.equal(source.includes("function useSchEdits("), false, "编辑区已撤掉");
  assert.equal(source.includes("\"连起来\""), false, "引脚连线按钮已撤掉");
});

test("3D 模型缺口要点名，PNG 预览整块已删（S180/S215）", () => {
  const clientSource = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(clientSource.includes("function useRender3d("), "要有 useRender3d");
  assert.ok(clientSource.includes("ecad/render3d?"), "请求要走 ecad/render3d");
  assert.ok(clientSource.includes("image=0"), "只问缺口时不要让服务端内嵌 PNG");
  assert.ok(clientSource.includes("缺 3D 模型"), "缺模型要列出来");
  // S215：three 的 3D 实体视图已经取代了这张 PNG，四档视图按钮与图片不该再回来。
  // 注释里提到旧块的名字没关系，这里断言的是「按钮/标题不再渲染出来」。
  assert.equal(clientSource.includes('"3D 预览"),'), false, "3D 预览区块要删掉");
  assert.equal(clientSource.includes('"斜视"),'), false, "斜视按钮要删掉");
  assert.equal(clientSource.includes('"重新渲染"),'), false, "重新渲染按钮要删掉");
  assert.ok(clientSource.indexOf("function useRender3d(") < clientSource.indexOf("function EcadPanel("), "hook 要定义在 EcadPanel 之前");
});

test("3D 缺模型时面板给可换的官方封装（S181）", () => {
  const clientSource = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(clientSource.includes("可换的官方封装"), "要显示可换封装清单");
  assert.ok(clientSource.includes("fix.candidates"), "候选要从回包里取");
  assert.ok(clientSource.includes("有 STEP"), "候选要标明有没有 STEP");
});

test("3D 模型缺口里能一键换封装、能导出 STEP（S182/S183/S215）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("ecad/swap?projectDir="), "换封装要走 /ecad/swap");
  assert.ok(source.includes("换过去"), "缺模型的候选旁边要有换过去的按钮");
  assert.ok(source.includes("ecad/render3d?projectDir="), "导出复用 3D 路由");
  assert.ok(source.includes("format="), "导出要带 format");
  // S215：GLB 由 3D 实体视图内部导出并缓存，面板上只留 STEP（给机械）。
  assert.equal(source.includes('doExport3d("glb")'), false, "面板不再导 GLB");
  assert.ok(source.includes("导出 STEP"), "面板要有 STEP 按钮");
  assert.ok(source.includes("已导出 "), "导出完要显示文件与大小");
});

test("电路设计页能看布局体检：去耦/晶振/接口三类问题都在面板上（S203）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function useLayoutCheck("), "要有 useLayoutCheck");
  assert.ok(source.includes("ecad/layout-check?projectDir="), "要打布局体检接口");
  assert.ok(source.includes("\"布局体检\""), "面板要有「布局体检」");
  assert.ok(source.includes("stm32_pcb_layout"), "超出时要指向工具");
  assert.ok(source.indexOf("function useLayoutCheck(") < source.indexOf("function EcadPanel("), "hook 要定义在面板之前");
});

test("面板顶部按瑞士风骨架排：eyebrow、大标题、副句、四格统计（S220）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.ok(/e\(\s*"header"/u.test(source), "报头要是 header 元素");
  assert.ok(source.includes("[ 硬件台 ]"), "eyebrow 要带方括号标签");
  assert.ok(source.includes('e("h1", { style: debugStyles.title }, props.page)'), "要有随页签的大标题");
  assert.ok(source.includes("debugStyles.lead"), "要有副句");
  assert.ok(source.includes("d32-stat"), "统计格要有 d32-stat 类");
  assert.ok(source.includes('statCell("连接"'), "统计第一格是连接状态");
  assert.ok(source.includes('statCell("证据目录"'), "统计最后一格是证据目录");
  assert.ok(source.includes('fontSize: "28px"'), "大标题 28px");
  assert.ok(source.includes("repeat(4, minmax(0, 1fr))"), "统计条四等分");
  // 空态是人话，不是等宽大写标签。
  const emptyBlock = source.slice(source.indexOf("      empty: {"), source.indexOf("      mono:"));
  assert.equal(emptyBlock.includes("D32_FONT_CODE"), false, "空态不该用等宽字体");
});

test("内容区占满主列：不再有右侧停靠的分隔条与固定宽度（S223）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.equal(source.includes('divider-right'), false, "主列里不该再留 6px 拖宽条（它会占掉 grid 的第一格）");
  assert.equal(source.includes('flex: "0 0 " + String(layout.right)'), false, "内容面板不该再按 layout.right 定宽");
  assert.ok(source.includes('className: "d32-body"'), "内容区要是自己的 .d32-body 列");
  assert.ok(source.includes('flex: "1 1 auto"'), "内容面板要撑满主列");
});
