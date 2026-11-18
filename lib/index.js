/**
 * dsh-ecad —— 插件入口（宿主侧，无 UI）。
 *
 * 结构：L0 engine/subprocess-runner（进程）→ L1 engine/*（纯逻辑）→
 *      L3 tools/*（模型可见工具）← 本文件只做装配。
 *
 * 这个插件只做硬件侧：tscircuit 原理图与库、KiCad PCB、ERC/DRC/DFM、BOM 与成本、
 * 叠层阻抗、EMC、机械、Gerber 与 3D。固件侧的编译、烧录、调试在 dsh-ecad。
 */
import { registerEcadTools } from "./tools/ecad.js";
import { registerPcbTools } from "./tools/pcb.js";
import { registerPdfTools } from "./tools/pdf.js";
import { registerSchematicTools } from "./tools/schematic.js";
import { registerSchEditTools } from "./tools/sch-edit.js";
import { registerSchDrawTools } from "./tools/sch-draw.js";
import { registerImportTools } from "./tools/import-circuit.js";
import { registerLayoutTools } from "./tools/layout.js";
import { registerDatasheetTools } from "./tools/datasheet.js";
import { registerGenTools } from "./tools/gen.js";
import { registerPartImportTools } from "./tools/part-import.js";
import { registerWebRoutes } from "./engine/web-routes.js";
import { setSessionWorkspaceResolver } from "./engine/web-api.js";
import { agentIdOf, agentOfSession, noteSessionAgent, noteSessionDir, sessionDirOf } from "./engine/session-context.js";
import { emitEvent } from "./engine/event-bus.js";
import { runAutoBuild } from "./engine/ecad/autobuild.js";
import { locateEcadToolchain } from "./engine/ecad/toolchain.js";
import { planEcadWorkspace } from "./engine/ecad/tsci.js";
import { resolveProjectLayout } from "./engine/project-layout.js";
import { startEventLog } from "./engine/event-log.js";
import { instrumentContext } from "./engine/tool-events.js";
export const name = "dsh-ecad";
export const inject = ["tools", "subprocess", "jobs"];
export function sessionIdOf(session) {
    if (session === null || typeof session !== "object")
        return "";
    const record = session;
    const header = record["header"];
    if (header !== null && typeof header === "object") {
        const id = header["id"];
        if (typeof id === "string" && id !== "")
            return id;
    }
    const direct = record["id"];
    return typeof direct === "string" ? direct : "";
}
export function apply(ctx) {
    // 工具注册走一层代理：每次调用记 start / ok / fail，调试台的事件流由此而来。
    const toolsCtx = instrumentContext(ctx);
    // 被环形缓冲挤出的事件按批落进证据目录（每会话一个目录）。
    const stopEventLog = startEventLog();
    const stopLog = () => {
        emitEvent({
            source: "system",
            kind: "lifecycle",
            status: "info",
            summary: "插件卸载，事件日志停止",
        });
        void stopEventLog();
    };
    // 硬件侧工具：原理图、PCB、制造文件、3D、BOM 与成本、叠层与 EMC、机械
    registerSchematicTools(toolsCtx);
    registerSchEditTools(toolsCtx);
    registerSchDrawTools(toolsCtx);
    registerImportTools(toolsCtx);
    registerLayoutTools(toolsCtx);
    registerDatasheetTools(toolsCtx);
    registerGenTools(toolsCtx);
    registerPartImportTools(toolsCtx);
    registerEcadTools(toolsCtx);
    registerPcbTools(toolsCtx);
    // PDF 读取两边都要：手册里的引脚表、时序、封装尺寸
    registerPdfTools(toolsCtx);
    // 设置面板的宿主 API（浏览器端 lib/client.js 用）。宿主没 webServer 服务时静默跳过。
    registerWebRoutes(toolsCtx);
    // 面板没传 projectDir 时按会话工作目录兜底（S84）：宿主没这个服务就留空，接口回 400 说明原因。
    if (typeof ctx.get === "function") {
        setSessionWorkspaceResolver(async (sessionId) => {
            const known = sessionDirOf(sessionId);
            if (known !== "")
                return known;
            const service = ctx.get("workingDirectory");
            if (service === undefined || typeof service.ensure !== "function")
                return "";
            const agent = sessionId === "" ? undefined : agentOfSession(sessionId);
            if (agent === undefined)
                return "";
            try {
                return await service.ensure(agent);
            }
            catch {
                return "";
            }
        });
        if (typeof ctx.on === "function") {
            ctx.on("agent/created", (payload) => {
                const agent = payload?.agent;
                const id = agentIdOf(agent);
                if (agent === undefined || agent === null || id === "")
                    return;
                noteSessionAgent(id, agent);
                const service = ctx.get("workingDirectory");
                if (service === undefined || typeof service.ensure !== "function")
                    return;
                void service.ensure(agent)
                    .then((dir) => {
                    if (typeof dir === "string" && dir !== "")
                        noteSessionDir(id, dir);
                })
                    .catch(() => undefined);
            });
        }
    }
    if (typeof ctx.on === "function") {
        ctx.on("session/event", (session, event) => {
            const sessionAgent = session?.agent;
            noteSessionAgent(sessionIdOf(session), sessionAgent);
            if (event?.type !== "turn/end")
                return;
            // 回合末自动构建（S136）：只在源码比产物新时跑，结果写 .dsh-stm32/ecad-state.json。
            const turnSession = sessionIdOf(session);
            const turnDir = turnSession === "" ? "" : sessionDirOf(turnSession);
            if (turnDir !== "")
                void autoBuildInWorkspace(ctx, turnDir, turnSession);
        });
        ctx.on("dispose", () => {
            stopLog();
        });
    }
}
/** 同一工程同时只跑一条自动构建；回合末重复触发时后来的直接退出。 */
const autoBuildRunning = new Set();
/**
 * 回合末自动构建入口（S136）。
 *
 * 只做「判断要不要构建」与「别把异常抛给宿主」两件事，具体流水线在 autobuild.ts。
 */
async function autoBuildInWorkspace(ctx, workspaceDir, sessionId) {
    if (autoBuildRunning.has(workspaceDir))
        return;
    autoBuildRunning.add(workspaceDir);
    try {
        const layout = resolveProjectLayout(workspaceDir);
        const workspace = planEcadWorkspace(layout.projectDir, layout.hardwareDir);
        if (!workspace.initialized)
            return;
        const located = locateEcadToolchain();
        if (located.toolchain === null)
            return;
        const turn = sessionId + ":" + String(Math.floor(Date.now() / 60_000));
        const result = await runAutoBuild({
            subprocess: ctx.subprocess,
            toolchain: located.toolchain,
            workspace,
            turn,
        });
        if (result.ran) {
            emitEvent({
                kind: result.ok ? "note" : "error",
                source: "system",
                summary: result.ok
                    ? "回合末自动构建完成（" + String(Math.round(result.durationMs / 1000)) + " s）"
                    : "回合末自动构建失败：" + result.error,
                payload: { autoBuild: true, ran: true, ok: result.ok, durationMs: result.durationMs },
            });
        }
    }
    catch {
        // 自动构建是便利功能：失败只在状态文件里留痕，不能让宿主事件处理器抛错。
    }
    finally {
        autoBuildRunning.delete(workspaceDir);
    }
}
