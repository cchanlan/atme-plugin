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
 * ## 值非法怎么办
 *
 * 出图路径上绝不能因为一个配置项写错就整张图发不出去 ——
 * 读不到 / 值不认识一律退回 png。
 */

import { getConfig } from './record.js'

/** 出图后端认的取值 */
const VALID = ['jpeg', 'png', 'webp']

/** 默认格式（写死为 png 那版就是这个值，改配置才变） */
const DEFAULT = 'png'

/**
 * 读配置拿出图格式。
 * @returns {'jpeg'|'png'|'webp'}
 */
export function getImgType () {
  try {
    const raw = String(getConfig()?.imgType ?? '').trim().toLowerCase()
    // 后端只认 jpeg，顺手把 jpg 这种常见写法归一化掉
    if (raw === 'jpg') return 'jpeg'
    return VALID.includes(raw) ? raw : DEFAULT
  } catch {
    return DEFAULT
  }
}

export { VALID as VALID_IMG_TYPES, DEFAULT as DEFAULT_IMG_TYPE }
