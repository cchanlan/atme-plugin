/**
 * 出图格式（锅巴里的「其他配置 → 出图 → 输出图片类型」，对应 atme.yaml 的 imgType）。
 *
 * ## 为什么默认 png
 *
 * 插件原本写死 png，起因是一次实测：JPEG 在文字/小图标边缘的压缩噪点很明显，
 * 聊天截图这种「大色块 + 小字」的图尤其糊，用户直接反馈「图很糊」。
 * png 无损，代价是体积大约翻几倍（600px 宽一页 jpeg 约 60KB / png 约 450KB）。
 *
 * **想省流量就改用 jpeg**：一般场景肉眼看不出差别，只是小字会略毛。
 * 两者都比 webp 保险 —— 见下。
 *
 * ## 为什么不默认 webp
 *
 * webp 在 QQ / OneBot 那边能省不少体积，但**微信（ComWeChat）适配器的图片接口
 * 不认 webp**：实测会把它降级成「文件」发出去，群里收到的是 xxx.webp 文件卡片
 * 而不是图片。所以 webp 只作为可选项列出，并在锅巴里标了警告。
 *
 * ## ⚠️ 为什么自己读 yaml 而不是用 record.js 的 getConfig
 *
 * 用 `getConfig()` 会形成**循环依赖**：
 *   record.js → render.js → imageType.js → record.js
 * ESM 虽然能容忍（函数调用时才求值），但初始化顺序稍有变化就会拿到 undefined。
 * 这个模块只依赖 paths.js（纯路径常量，无副作用），依赖图是干净的。
 *
 * ## 值非法怎么办
 *
 * 出图路径上绝不能因为一个配置项写错就整张图发不出去 ——
 * 读不到 / 值不认识一律退回 png（带 mtime 缓存，不每次都读盘）。
 */

import { readFileSync, statSync } from 'node:fs'
import YAML from 'yaml'
import { userConfigPath } from './paths.js'

/** 出图后端认的取值 */
const VALID = ['jpeg', 'png', 'webp']

/** 默认格式（写死为 png 那版就是这个值，改配置才变） */
const DEFAULT = 'png'

let cache = null
let cacheMtime = 0

/**
 * 读配置拿出图格式（按文件 mtime 缓存，改完保存即生效）。
 * @returns {'jpeg'|'png'|'webp'}
 */
export function getImgType () {
  try {
    const mtime = statSync(userConfigPath).mtimeMs
    if (cache !== null && mtime === cacheMtime) return cache

    const cfg = YAML.parse(readFileSync(userConfigPath, 'utf-8')) || {}
    const raw = String(cfg.imgType ?? '').trim().toLowerCase()
    // 后端只认 jpeg，顺手把 jpg 这种常见写法归一化掉
    cache = raw === 'jpg' ? 'jpeg' : (VALID.includes(raw) ? raw : DEFAULT)
    cacheMtime = mtime
    return cache
  } catch {
    // 配置文件读不到（还没生成 / 语法错）就用默认值，别让出图挂掉
    return DEFAULT
  }
}

export { VALID as VALID_IMG_TYPES, DEFAULT as DEFAULT_IMG_TYPE }
