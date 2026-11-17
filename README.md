# dsh-ecad

[![license](https://img.shields.io/github/license/JingYu-er/dsh-ecad)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-orange)](https://github.com/JingYu-er/dsh-ecad)

STM32 硬件侧的 DSH 插件：原理图、PCB、制造文件、成本与体检。与固件插件 `dsh-stm32` 分工，二者通过工程内的 `dsh/mcu.json` 交换事实，工具名不重叠，可同时安装。

作用范围从「写一份 circuit.tsx」到「交出可打样的 Gerber 与 BOM」：器件与封装取自 KiCad 官方库（缺了回退立创页面）、原理图与 PCB 由 tscircuit 生成、放置与布线交给 KiCad 生态工具、校验与成本由本插件自己算。

## 与 dsh-stm32 的关系

| | dsh-stm32（固件） | dsh-ecad（硬件） |
| --- | --- | --- |
| 负责 | 工具链、`.ioc` 事务、建工程、生成、编译、烧录、调试、串口/RTT | 器件与封装、原理图、PCB、制造文件、BOM/成本、EMC/热/阻抗体检 |
| 原理图 | 只读：读图、引脚表、规则检查、评审、`.ioc` 草案 | 可写：生成、手绘层增量、从 KiCad 吸收回源 |
| 事实文件 | 写 `<工程>/dsh/mcu.json`（`dsh-mcu/1`） | 读 `mcu.json`；`board.json` 为规划中的反向通道 |

两个插件各自拷贝共享核心（KiCad 解析、工程目录约定、工具链定位、原子写），不抽公共包。

## 能力清单

- **原理图**：解析 KiCad 10 `.kicad_sch`（实例变换、多页、网络），输出 SVG 与网表对账；手绘层可加导线、标名、克隆、挪位、放新器件，改动存成图纸本身而不碰生成目录。
- **PCB**：从 `circuit.json` 读网表做放置（主控居中、接口沿边、小件贴大件）；自动布线用 KiCadRoutingTools（Rust 网格路由器）；局部修改走 KiCad 官方 IPC（编辑器在跑时）。
- **制造**：Gerber 与钻孔回看成 SVG；STEP / GLB 导出；DXF 板框与定位孔；嘉立创工艺档写进 `.kicad_dru`。
- **校验**：ERC / DRC / 可制造性、网表↔PCB 门禁（含手绘层差异）、EMC（载流线宽、回流覆盖、串扰、差分间距）、叠层与阻抗、功耗与电源树、3D 模型覆盖。
- **成本**：BOM 分组（主选编号 + 替代料）、立创单价与库存按需查询、元件成本合计。
- **器件**：型号/参数/立创编号搜索；按编号导入封装（KiCad 库优先，缺了从立创页面转）；封装引用的 3D 模型一并收进工程。

## 安装

```bash
dsh plugin --profile desktop add dsh-ecad
```

安装后完全退出 DSH 再启动（插件层只在进程启动时加载）。

- 校验：`dsh plugin --profile desktop why dsh-ecad` 显示 `0.1.0`
- 卸载：`dsh plugin --profile desktop remove dsh-ecad`，随后重启 DSH

外部依赖（缺哪个，对应工具会说明缺什么）：

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| KiCad 10（`kicad-cli`、`pcbnew`、官方库） | 生成工程、ERC/DRC、Gerber、3D、封装与符号库 | 构建与校验不可用 |
| Node.js + 共享运行时（tscircuit） | 把 `circuit.tsx` 编成 KiCad 工程 | 首次构建时提示安装；装在 `~/.dsh-ecad/ecad-runtime`，全机一份 |
| KiCadRoutingTools | 自动布线 | 布线步骤记为「跳过」，不算失败 |
| poppler（`pdftotext`） | 手册取文字与表格 | PDF 工具提示安装去向 |

## 快速开始

```
1. stm32_ecad_init        在工程里建 hardware/circuit 工作区
2. 写 hardware/circuit/index.circuit.tsx（tscircuit 源，唯一写者）
3. stm32_ecad_build      构建出 hardware/circuit/dist/<名>/kicad/*.kicad_pcb + .kicad_sch
4. stm32_ecad_design     一键：预检 → 构建 → 合并焊盘 → 导库 → ERC → DRC → 可制造性 → STEP → Gerber
```

`dsh-ecad` 不猜器件：`index.circuit.tsx` 里的 `jlcpcb:C<编号>` 决定 BOM 料号，封装名决定 PCB 封装；缺封装时 `stm32_part_import` 从 KiCad 官方库复制，库里没有才回退立创页面转换，两条都失败会同时给出两个原因。

## 工具参考（42 个）

### 工程与构建

| 工具 | 说明 |
| --- | --- |
| `stm32_ecad_init` | 在 `hardware/` 下建 `circuit/`、`kicad/`、`libs/`、`out/`，写 `package.json`；不装依赖 |
| `stm32_ecad_build` | 用 KiCad 自带 bun 跑 `tsci build --kicad-project --svgs`，产出 `circuit.json`、SVG、KiCad 工程 |
| `stm32_ecad_check` | 对生成的 KiCad 工程跑 ERC 与 DRC，收敛成清单（含 `notes` 与 DFM） |
| `stm32_ecad_libs` | 把板与图里内嵌的封装/符号抽成 `hardware/libs` 下的真库并登记库表 |
| `stm32_ecad_design` | 九步流水线：预检 → 构建 → 合并焊盘 → 导库 → ERC → DRC → 可制造性 → STEP → 制造文件（可选布线） |
| `stm32_ecad_step` / `stm32_ecad_export` / `stm32_ecad_package` | 导 STEP；导 Gerber/钻孔/坐标；打包交付 zip（含自检） |
| `ecad_layout_fix` | 检查并把 `.dsh-stm32/workspace.conf`、`dsh-stm32.conf` 归位 |

### 原理图

| 工具 | 说明 |
| --- | --- |
| `ecad_sch_read` | 读图：图纸树、元件与引脚网络、网表、模块框图 |
| `ecad_sch_pins` | 主控每个引脚的网络 + CubeMX 复用候选 |
| `ecad_sch_check` | 规则检查（调试口/电源/BOOT0/缺值/网络冲突），可选与 PCB、`.ioc` 对账 |
| `ecad_sch_review` | 一键评审：读图 → 规则检查 → 与 `.ioc` 对账 → 配置草案 |
| `ecad_sch_to_ioc` | 把连接转成 `.ioc` 配置草案（建议 + 置信度，软件模拟单独列） |
| `stm32_sch_draw` | 手绘层：`seed` 拷底图；`wire`/`label`/`clone`/`move`/`remove`/`place`；写盘后用 `kicad-cli` 导网表校验 |
| `stm32_sch_edit` | 指令式编辑：`connect`/`label` 存 `schematic-edits.json`，构建收尾重放 |
| `stm32_sch_import` | 把 KiCad 里的改动按网表差异吸收回 `index.circuit.tsx`（坐标不保留） |
| `stm32_sch_sync` | 手绘层新放的器件补到板上：封装从库来、已在板上的跳过、自动网名不赋 |

### PCB 与制造

| 工具 | 说明 |
| --- | --- |
| `stm32_pcb_place` | 按网表放置：主控居中、接口沿边、小件贴大件、courtyard 间隙 0.6 mm |
| `stm32_pcb_autoroute` | KiCadRoutingTools 布线（`dryRun` 默认 true，`apply` 前留 `.bak`） |
| `stm32_pcb_route` | 自研最近邻布线，仅作对照（已被取代） |
| `stm32_pcb_ipc` | KiCad 官方 IPC：移动/布线/过孔/重铺/保存；未开 KiCad 时自动 `pcbnew` 打开并等就绪 |
| `stm32_pcb_render` | 板图 SVG（顶层/底层，焊盘/走线/过孔/丝印/板框/位号可关） |
| `stm32_pcb_gerber` | 把导出的 Gerber 与钻孔读回来画成一张图 |
| `stm32_pcb_3d` | 3D 预览（PNG）与 GLB/STEP 导出；缺模型点名到「位号：路径」 |
| `stm32_pcb_swap` | 换封装（KiCad 官方库）：位号/值/位置/旋转保留，网络按焊盘号搬，提示重布 |
| `stm32_mech` | 板框尺寸、定位孔、孔到边距离，可导 DXF |
| `stm32_stackup` | 按层数取嘉立创常规叠层，反算 50/90/100 Ω 的线宽与间距 |
| `stm32_impedance` | 把阻抗目标写成 `.kicad_dru` 的线宽/间距规则（DRC 无 impedance 约束） |

### 校验与成本

| 工具 | 说明 |
| --- | --- |
| `stm32_netgate` | 网表↔PCB 门禁：图纸比板子新、网络拆开、缺焊盘、元件缺失、手绘层差异 |
| `stm32_emc` | 载流线宽（IPC-2221）、铺铜、回流路径、串扰、差分间距 |
| `stm32_pcb_links` | 布线体检：差分对长度差、平面层上的信号、去耦电容到引脚距离 |
| `stm32_power` | 功耗与电源树电流预算（只合计填的电流，估算单列） |
| `stm32_bom` | BOM 分组与元件成本；`prices: true` 才联网取立创报价 |
| `stm32_brief` | 生成 `docs/01-MRD.md`、`02-hardware-PRD.md`、`03-design-brief.md` 骨架（事实自动填，需求留待定） |
| `stm32_symbol_footprint` | 按引脚表生成 `.kicad_sym`，按尺寸生成 `.kicad_mod` |

### 器件与手册

| 工具 | 说明 |
| --- | --- |
| `stm32_part_import` | 按 `Lib:Name` 导入封装（KiCad 库优先，`source=lcsc` 可强制立创），生成符号骨架，3D 模型一并收进工程 |
| `ecad_part_search` | 型号/参数/立创编号搜索：库存、起订、阶梯价（接口不给封装字段就如实说） |
| `ecad_ds_fetch` / `ecad_ds_list` / `ecad_ds_lookup` | 立创手册下载与缓存、清单、按用途查页 |
| `ecad_pdf_read` | PDF：文字、表格、图、页面渲染、曲线数字化、原理图 PDF 元件清单 |

## 硬件台面板

会话页签里的「硬件台」（`conversation.view`，与固件插件的「调试台」并列）：

- 页签：概览 / 事件 / 流程图 / 电路设计 / 故障 / 产物 / 变更
- 「电路设计」：板图、BOM、电源预算、叠层、一致性、EMC、机械、3D 预览、制造文件、器件搜索
- 工程选择按会话隔离；状态条显示插件版本、路由数与「有新构建」提示

## 工程目录约定

```
<工程>/
  dsh-stm32.conf            工程描述（name / mcu / ioc / build / firmware），两个插件共用
  dsh/mcu.json              固件插件写的 MCU 事实（dsh-mcu/1）
  hardware/
    circuit/                tscircuit 源与产物（index.circuit.tsx、dist/）
    kicad/                  生成的 KiCad 工程（每次构建重写，只读）
    schematic/              手绘层（schematic.kicad_sch，不被构建覆盖）
    libs/                   从 KiCad 库或立创导入的封装、符号、3D 模型
    out/                    Gerber、STEP、GLB、PNG、DXF、BOM
  .dsh-stm32/               工作区索引与备份（两个插件共用）
```

## 配置

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_ECAD_HOME` | `~/.dsh-ecad` | 用户级目录：运行时、手册与价格缓存、封装缓存、证据 |
| `DSH_STM32_ECAD_RUNTIME` | `<DSH_ECAD_HOME>/ecad-runtime` | 共享运行时（tscircuit）位置，全机一份 |
| `DSH_STM32_ECAD_AUTO_INSTALL` | `ask` | `auto` 首次构建时自动装运行时；`off` 不装 |
| `DSH_STM32_OFFLINE` | — | `1` 时禁止联网（搜索、查价、手册、立创封装） |
| `DSH_STM32_FOOTPRINTS` | — | 覆盖封装缓存目录 |
| `KICAD_PYTHON` / `DSH_KICAD_PYTHON` | KiCad 自带 python | `pcbnew` 与 IPC 脚本解释器 |

## 已知限制

- **自动布线是辅助**：KiCadRoutingTools 能布通、DRC 干净，但线形不如人工；插件只做「布通 + 体检」，不假装能替代手工走线。
- **细间距档**：布线器按嘉立创工艺下限走线（1–2 层 0.127 mm，≥4 层 0.10 mm，另有 0.003 mm 量化余量），要做到 0.2 mm 统一档需人工加宽。
- **KiCad 10 的 IPC 没有原理图读接口**：只能写（`CreateItems` 等），所以「读图」用本插件自己的解析器；`Update PCB from Schematic` 需要 KiCad 管理器打开工程（`RunAction` 未纳入自动流程）。
- **3D 覆盖率**：tscircuit 产出的模型不保证每个封装都有；缺的会点名，不画假模型。
- **手绘层不进构建目录**：`hardware/schematic/` 是人的图纸，构建不覆盖，也不会自动回流到 `circuit.tsx`（要显式 `stm32_sch_import`）。
- **单活动工程**：面板一次看一个工程（按会话记忆）。
- 在 Windows 上验证最充分；Linux/macOS 的工具链探测已按路径分开，但未做同等实测。

## 校验

```bash
npm run typecheck
npm run build
node test/run-units.mjs     # 22 套件 / 339 pass（含 tools 契约与 schema 子集守卫）
npm run test:pack
npm run test:size           # 需 export npm_config_cache=/tmp/npmcache
```

## 致谢

- [KiCad](https://www.kicad.org/)：工程格式、`kicad-cli`、`pcbnew`、IPC。
- [KiCadRoutingTools](https://github.com/alphapixels/KiCadRoutingTools)（MIT）：网格布线器。
- [tscircuit](https://github.com/tscircuit/tscircuit)（MIT）：`circuit.tsx` 到 KiCad 工程。
- [uPesy/easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py) 的 `CMD_FOOTPRINT.md`：立创封装字段与层号的事实来源（文档参考，未复制代码）。

## 文档

- [使用与维护指南](docs/reading-guide.md)
- [开发笔记](docs/development-notes.md)（硬件侧条目 S90 起；S1–S89 属于拆分前的固件侧）
