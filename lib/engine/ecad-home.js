/**
 * 本插件的用户级目录（S185）。
 *
 * 默认 `~/.dsh-ecad`：ECAD 的运行时、封装缓存与价格/手册缓存都放这里，
 * 与固件插件 `~/.dsh-stm32` 分开，两个插件各管各的目录。
 * 环境变量 `DSH_ECAD_HOME` 可整体改到别处。
 */
import { homedir } from "node:os";
import { join } from "node:path";
export function userHome(env = process.env) {
    return env["USERPROFILE"]?.trim() || homedir();
}
/** ECAD 的用户级根目录：`DSH_ECAD_HOME` 优先，否则 `<用户主目录>/.dsh-ecad`。 */
export function ecadHome(env = process.env) {
    const explicit = (env["DSH_ECAD_HOME"] ?? "").trim();
    if (explicit !== "")
        return explicit;
    const home = userHome(env);
    return join(home === "" ? "." : home, ".dsh-ecad");
}
