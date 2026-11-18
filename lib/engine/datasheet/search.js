/**
 * 器件搜索（S163）：立创的公开搜索接口。
 *
 * 打的是前端自己在用的那个接口（`wmsc.lcsc.com/ftps/wm/search/third`），不需要登录：
 * 搜关键词回产品列表，含编号、型号、品牌、封装、库存、阶梯价、手册地址。
 *
 * 这一层只做三件事：拼请求、把回包削成稳定的形状、按查询缓存（默认 24 小时）。
 * 「该选哪个」不在这里判断——参数、温度等级、寿命都得人看手册。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ecadHome } from "../ecad-home.js";
export const LCSC_SEARCH_URL = "https://wmsc.lcsc.com/ftps/wm/search/third";
const GENERIC_PACKAGE = /\b(SOP|SOIC|SSOP|TSSOP|MSOP|HSOP|QFN|DFN|LQFP|TQFP|QFP|BGA|DIP|SOT|TO|SOD|CSP|WLCSP|PLCC|LCC)[-_ ]?(\d{1,3})(?:[-_ ]?(\d))?\b/iu;
const CHIP_SIZE = /\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/u;
const UNIT_VALUE = /^\d+(?:\.\d+)?(?:[pnuµmkKM]?[FfVvAaWwΩ]|R|K|M|RPM|Hz)$/u;
/**
 * 剩下这段文字还像不像一个型号。
 *
 * 只因为「查询里出现了封装」就把封装拿掉，`0603 100nF 50V` 会变成 `100nF 50V`——
 * 立创的全文检索会把它当模糊词，返回一堆 MOS 管。所以只有剩下的词里确实有
 * 「字母+数字混排、且不是单位量」的型号样式时，才把封装摘出去单独判。
 */
function looksLikePartName(text) {
    for (const token of text.split(/\s+/u)) {
        const word = token.trim();
        if (word === "")
            continue;
        if (UNIT_VALUE.test(word))
            continue;
        if (!/[A-Za-z]/u.test(word) || !/\d/u.test(word))
            continue;
        if (word.length >= 4)
            return true;
    }
    return false;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
/** 从查询里认出封装：型号后面常跟着 `SOP8`、`SOT-23`、`0603`。认出的封装会从关键词里拿掉，用它单独判命中。 */
export function parsePackageQuery(raw) {
    const text = raw.trim();
    const generic = GENERIC_PACKAGE.exec(text);
    if (generic !== null) {
        const family = (generic[1] ?? "").toUpperCase();
        const pins = generic[2] ?? "";
        const suffix = generic[3] ?? "";
        const canonical = family + "-" + pins + (suffix === "" ? "" : "-" + suffix);
        const stripped = text.replace(generic[0], " ").replace(/\s+/gu, " ").trim();
        // 摘掉封装后不像型号（例如 `100nF 50V`）就保留原查询：封装那一段对全文检索有用。
        const keyword = stripped !== "" && looksLikePartName(stripped) ? stripped : text;
        return { keyword, packageName: canonical };
    }
    const chip = CHIP_SIZE.exec(text);
    if (chip !== null) {
        const canonical = chip[1] ?? "";
        const stripped = text.replace(chip[0], " ").replace(/\s+/gu, " ").trim();
        const keyword = stripped !== "" && looksLikePartName(stripped) ? stripped : text;
        return { keyword, packageName: canonical };
    }
    return { keyword: text, packageName: "" };
}
function packagePatternOf(canonical) {
    const chip = CHIP_SIZE.exec(canonical);
    if (chip !== null) {
        return { canonical, query: new RegExp("\\b" + canonical + "\\b", "u"), value: new RegExp(canonical, "u") };
    }
    const generic = GENERIC_PACKAGE.exec(canonical);
    if (generic === null)
        return null;
    const family = (generic[1] ?? "").toUpperCase();
    const pins = generic[2] ?? "";
    // `SOT-23`、`SOP-8` 这类在封装名里可能写成 `SOT-23-3`、`SOIC-8`，也可能写成 `SOP8`；只要求族名与脚数都出现。
    const value = new RegExp(escapeRegExp(family) + "[-_ ]?" + pins, "iu");
    const query = new RegExp("\\b" + escapeRegExp(family) + "[-_ ]?" + pins, "iu");
    return { canonical, query, value };
}
/** 判一条命中与目标封装的关系。封装字段空时退到型号/品类里找，都找不到就是「判不出来」。 */
export function packageVerdict(hit, canonical) {
    const pattern = packagePatternOf(canonical);
    if (pattern === null)
        return "unknown";
    const fields = [hit.packageName, hit.mpn, hit.category].filter((item) => item.trim() !== "");
    if (fields.length === 0)
        return "unknown";
    for (const field of fields) {
        if (pattern.value.test(field))
            return "match";
    }
    return hit.packageName.trim() === "" ? "unknown" : "mismatch";
}
export function searchCachePath(env) {
    return join(ecadHome(env), "part-search.json");
}
function readCache(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed.version === 1 && typeof parsed.entries === "object" && parsed.entries !== null) {
            return { version: 1, entries: parsed.entries };
        }
    }
    catch {
        // 缓存坏了就当没有：搜索是只读操作，重下一份即可。
    }
    return { version: 1, entries: {} };
}
function writeCache(file, cache) {
    try {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, JSON.stringify(cache), "utf8");
    }
    catch {
        // 写不了缓存不影响搜索本身。
    }
}
function num(value) {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
/** 把一页回包削成 `PartHit[]`；字段名跟接口走，缺的下沉成空串/0。 */
export function parseProductList(payload) {
    const result = payload?.result;
    const list = Array.isArray(result?.productList) ? result.productList : [];
    const hits = [];
    for (const item of list) {
        const code = str(item["productCode"]);
        if (!/^C\d+$/u.test(code))
            continue;
        const rawLadder = Array.isArray(item["productPriceList"]) ? item["productPriceList"] : [];
        const ladder = [];
        for (const step of rawLadder) {
            const qty = num(step["ladder"]);
            const priceUsd = num(step["usdPrice"]);
            if (qty > 0 && priceUsd > 0)
                ladder.push({ qty, priceUsd });
        }
        ladder.sort((a, b) => a.qty - b.qty);
        const stock = num(item["stockNumber"]);
        hits.push({
            code,
            mpn: str(item["productModel"]),
            brand: str(item["brandNameEn"]) || str(item["lcOrderBrandNameEn"]),
            packageName: str(item["encapStandard"]),
            stock,
            minBuy: num(item["minBuyNumber"]),
            priceUsd: ladder.length > 0 ? ladder[0].priceUsd : 0,
            ladder,
            category: str(item["thirdWmCatalogNameEn"]) || str(item["wmCatalogNameEn"]),
            datasheetUrl: str(item["pdfUrl"]),
            inStock: stock > 0,
        });
    }
    return { total: num(result?.totalCount), hits };
}
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const VERDICT_RANK = { match: 0, unknown: 1, mismatch: 2 };
/**
 * 按封装重排并按判据计数。
 *
 * 搜索接口不一定回 `encapStandard`（实测常常是 null），所以这里只做三件事：
 * 明确匹配的排前面、判不出来的居中、明确不符的排最后；并把三个数写进结果。
 * 「判不出来」不算失败——不能因为接口没给字段，就把可能正确的型号剔掉。
 */
function rankByPackage(result, notes) {
    const pairs = result.hits.map((hit) => ({
        hit,
        verdict: result.packageName === "" ? "unknown" : packageVerdict(hit, result.packageName),
    }));
    if (result.packageName !== "") {
        pairs.sort((left, right) => VERDICT_RANK[left.verdict] - VERDICT_RANK[right.verdict]);
    }
    const matched = pairs.filter((pair) => pair.verdict === "match").length;
    const unknownPackage = pairs.filter((pair) => pair.verdict === "unknown").length;
    const mismatched = pairs.filter((pair) => pair.verdict === "mismatch").length;
    const merged = [...notes];
    if (!looksLikePartName(result.keyword)) {
        merged.push("这是参数式查询：立创的搜索是全文匹配，`100NF04` 这类型号也会命中 `100nF`；要缩小范围请直接给型号或立创编号，或到商品页按封装/容值筛。");
    }
    if (result.packageName !== "") {
        if (matched === 0) {
            merged.push("这一页没有封装明确匹配 " + result.packageName + " 的型号：接口回的封装字段常为空，请到商品页核对封装，或把封装写进型号关键词再搜一次");
        }
        else {
            merged.push("按封装 " + result.packageName + " 排序：明确匹配 " + String(matched) + " 条，接口没给封装 " + String(unknownPackage) + " 条（判不出来，未剔除），不符 " + String(mismatched) + " 条（排最后）");
        }
    }
    return { ...result, hits: pairs.map((pair) => pair.hit), matched, unknownPackage, mismatched, notes: merged };
}
/** 搜一次；命中缓存直接回，不回网络。 */
export async function searchParts(query, options = {}) {
    const raw = query.trim();
    const parsed = options.package !== undefined && options.package.trim() !== ""
        ? { keyword: raw, packageName: options.package.trim() }
        : parsePackageQuery(raw);
    const keyword = parsed.keyword;
    const packageName = parsed.packageName;
    const limit = Math.min(Math.max(Math.round(options.limit ?? 10), 1), 50);
    const page = Math.max(Math.round(options.page ?? 1), 1);
    const empty = {
        ok: false,
        error: "",
        query: raw,
        keyword,
        packageName,
        total: 0,
        hits: [],
        matched: 0,
        unknownPackage: 0,
        mismatched: 0,
        cached: false,
        notes: [],
    };
    if (keyword === "")
        return { ...empty, error: "搜索关键词不能为空：给型号、参数或立创编号，例如 `STM32F103C8T6`、`0603 100nF`" };
    const file = options.cacheFile ?? searchCachePath(process.env);
    // 没有封装过滤时沿用旧的缓存键，老缓存仍然有效；带封装才加第四段。
    const baseKey = String(limit) + "|" + String(page) + "|" + keyword.toLowerCase();
    const key = packageName === "" ? baseKey : baseKey + "|" + packageName.toLowerCase();
    const now = options.now ?? (() => Date.now());
    if (options.noCache !== true && existsSync(file)) {
        const cache = readCache(file);
        const hit = cache.entries[key];
        if (hit !== undefined && now() - hit.at < (options.ttlMs ?? DEFAULT_TTL_MS)) {
            return rankByPackage({ ...empty, ok: true, total: hit.total, hits: hit.hits, cached: true }, ["这一页来自本地缓存（24 小时内有效）"]);
        }
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    try {
        const response = await fetchImpl(LCSC_SEARCH_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                origin: "https://www.lcsc.com",
                referer: "https://www.lcsc.com/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-ecad",
            },
            body: JSON.stringify({ keyword, currentPage: page, pageSize: limit }),
            signal: controller.signal,
        });
        if (!response.ok)
            return { ...empty, error: "立创搜索接口回了 HTTP " + String(response.status) + "：稍后再试，或换成更具体的关键词" };
        const payload = (await response.json());
        const code = num(payload.code);
        if (code !== 200)
            return { ...empty, error: "立创搜索接口回了错误码 " + String(code) + "：" + str(payload.msg) };
        const pageHits = parseProductList(payload);
        const notes = [];
        if (pageHits.hits.length === 0)
            notes.push("没有匹配结果：试试去掉封装或电压，只留型号主体");
        if (pageHits.total > 0)
            notes.push("共 " + String(pageHits.total) + " 条匹配，这里只给前 " + String(pageHits.hits.length) + " 条");
        const cache = readCache(file);
        cache.entries[key] = { at: now(), total: pageHits.total, hits: pageHits.hits };
        const keys = Object.keys(cache.entries);
        if (keys.length > 200) {
            for (const stale of keys.slice(0, keys.length - 200))
                delete cache.entries[stale];
        }
        writeCache(file, cache);
        return rankByPackage({ ...empty, ok: true, total: pageHits.total, hits: pageHits.hits, cached: false }, notes);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ...empty, error: controller.signal.aborted ? "搜索超时或已取消：" + reason : "搜索失败：" + reason };
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
    }
}
