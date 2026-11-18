/** 读 `DSH_ECAD_<suffix>`，没有就退回 `DSH_STM32_<suffix>`，两者都空返回 undefined。 */
export function envValue(env, suffix) {
    const value = env["DSH_ECAD_" + suffix];
    if (typeof value === "string" && value.trim() !== "") {
        return value;
    }
    const legacy = env["DSH_STM32_" + suffix];
    return typeof legacy === "string" && legacy.trim() !== "" ? legacy : value;
}
/** 文档与报错里用的正式变量名。 */
export function ecadEnvName(suffix) {
    return "DSH_ECAD_" + suffix;
}
