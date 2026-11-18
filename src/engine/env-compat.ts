/**
 * 环境变量的两个名字：`DSH_ECAD_*` 是正式名，`DSH_STM32_*` 是拆分前的旧名。
 *
 * 拆分后硬件插件沿用旧名会让用户以为它属于固件插件，所以对外统一叫 `DSH_ECAD_*`；
 * 但已经配过旧名的机器不能因此失效，读的时候先看新名、再退回旧名。写文档、报错文案
 * 一律只提新名。
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** 读 `DSH_ECAD_<suffix>`，没有就退回 `DSH_STM32_<suffix>`，两者都空返回 undefined。 */
export function envValue(env: EnvLike, suffix: string): string | undefined {
  const value = env["DSH_ECAD_" + suffix];
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  const legacy = env["DSH_STM32_" + suffix];
  return typeof legacy === "string" && legacy.trim() !== "" ? legacy : value;
}

/** 文档与报错里用的正式变量名。 */
export function ecadEnvName(suffix: string): string {
  return "DSH_ECAD_" + suffix;
}
