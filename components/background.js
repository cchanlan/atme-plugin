/**
 * 出图的自定义聊天背景（锅巴里的「其他配置 → 出图 → 聊天背景图」，
 * 对应 atme.yaml 的 `background.image` / `background.veil`）。
 *
 * ## 为什么不直接读 record.js 的 getConfig
 *
 * 同 imageType.js：`record.js → render.js → background.js → record.js` 会成环。
 * 这里自己读 yaml，只依赖 paths.js（纯路径常量）。
 *
 * ## 遮罩（veil）是必须的
 *
 * 背景图铺在聊天区底下，气泡是白的。背景一浓，气泡和文字就糊在一起 ——
 * 所以上面要盖一层白色半透明遮罩，`veil` 就是那层的浓度：
 *   0    = 完全看得见背景（文字可能看不清）
 *   0.72 = 默认，背景若隐若现、文字清楚（接近 QQ 自带背景自己那档观感）
 *   0.95 = 几乎看不见背景
 * 出图路径上不能因为配置写错就画不出图 —— 读不到/值非法一律按默认走。
 */

import { readFileSync, statSync, existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs'
import { resolve, isAbsolute, dirname } from 'node:path'
import YAML from 'yaml'
import { userConfigPath, resourcesDir } from './paths.js'

/**
 * 背景图专用目录：`plugins/atme-plugin/resources/bg/`。
 * 锅巴面板里上传的图会被搬到这里，配置里只写文件名就能用。
 */
export const bgDir = resolve(resourcesDir, 'bg')

/**
 * 遮罩默认浓度（**百分比** 0~100）。
 *
 * ⚠️ 这个值对外是百分比（30 表示 30%），因为锅巴上填百分比直观得多。
 *    但**要兼容老配置**：早先写的是 0~1 的小数（如 0.72），
 *    直接按百分比解析会变成 0.72%（背景几乎全透），所以这里做归一化 ——
 *    值 ≤ 1 当老格式 ×100，> 1 当已经是百分比。
 */
const DEFAULT_VEIL = 72

/** 把配置里的遮罩值归一成 0~100 的百分比（兼容 0~1 的老格式） */
function parseVeil (raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_VEIL
  const percent = n <= 1 && n >= 0 ? Math.round(n * 100) : Math.round(n)
  return Math.min(100, Math.max(0, percent))
}

/**
 * 背景图怎么铺。
 *
 * ⚠️ 出图是**长图**（高度随消息条数变），而用户给的背景多半是竖图。
 *    用 `cover` 会把图放大到铺满整屏 —— 高图一比容器矮就会被裁，
 *    实测直接把人物**头部裁掉了**。所以位置默认取 `top`：先保住上半部分。
 *   `contain` 则完整显示整张图，代价是四周留白。
 *
 *   位置默认 `center`：实测「顶对齐」在人物图上只露出发顶，而中心对齐能看到脸；
 *   横图居中通常也是最稳的取景。想要特定一端再改。
 */
const FIT_VALUES = ['cover', 'contain']
const POS_VALUES = ['top', 'center', 'bottom']

/**
 * 铺了背景时把手机撑成「屏幕比例」（高 / 宽）。**0 = 不撑，按内容高度出图。**
 *
 * ## 它解决的与它的代价（两个诉求是冲突的，必须二选一）
 *
 * 出图高度原本随消息条数变 —— 消息少时容器比例接近 1.2（很宽），
 * 而背景壁纸是手机屏那种细长比例，`cover` 一比就疯狂放大、把人物裁得只剩一张脸。
 * 给容器一个屏幕比例，比例对上、`cover` 基本不裁，**代价是内容少时下方留一大片背景**。
 *
 * 反过来，`0`（默认）让图跟内容走、下方不空，**代价是背景会被裁**。
 *
 * 默认取 0：主人 2026-10-12 明确要「没那么多内容时下方缩回来」。
 * 想要壁纸铺满的效果，把 screenRatio 填 1.9（约 9:17）或 2.17（全面屏）。
 */
const DEFAULT_SCREEN_RATIO = 0

let cache = null
let cacheMtime = -1

/**
 * 把配置里的图片地址转成能在页面里用的 CSS url。
 * - 空 → null（不用背景）
 * - http(s):// 或 data: → 原样用
 * - 其它当本地路径：相对路径按宿主工作目录解析；文件不存在就忽略（不报错）
 */
/**
 * 只写文件名（不含路径分隔符）时，按这个顺序找，找到就搬进 `resources/bg/`。
 *
 * 为什么要搬：锅巴的上传组件（GUpload）**不暴露目标目录字段**，
 * 上传的文件只能落在锅巴的文件根（= 机器人根目录）。配置面板拿到的就是
 * 一个光秃秃的文件名，所以这里把它收进插件自己的目录 ——
 * 既满足"上传后存进插件"，也让配置值从此稳定指向插件内路径。
 */
function resolveBareName (name) {
  const inPlugin = resolve(bgDir, name)
  if (existsSync(inPlugin)) return inPlugin

  // 锅巴上传的落点：机器人根目录
  const inRoot = resolve(process.cwd(), name)
  if (existsSync(inRoot)) {
    try {
      mkdirSync(bgDir, { recursive: true })
      const target = resolve(bgDir, name)
      try {
        renameSync(inRoot, target)
      } catch {
        // 跨设备 rename 会失败，退回复制 + 删源
        copyFileSync(inRoot, target)
        unlinkSync(inRoot)
      }
      logger.info(`[Atme-Plugin] 背景图已收进插件目录：${target}`)
      return target
    } catch (err) {
      logger.warn(`[Atme-Plugin] 背景图搬进插件目录失败，改用原路径：${err.message}`)
      return inRoot
    }
  }
  return null
}

function toCssUrl (raw) {
  // 锅巴上传组件的值是数组（maxCount=1 时也偶发），取第一个
  const v0 = Array.isArray(raw) ? raw[0] : raw
  const v = String(v0 ?? '').trim()
  if (!v) return null
  if (/^(https?:|data:)/i.test(v)) return v

  // 只写文件名 → 去插件 resources/bg 找（顺手把锅巴上传的搬进来）
  const hasPath = isAbsolute(v) || v.includes('/') || v.includes('\\')
  const abs = hasPath ? (isAbsolute(v) ? v : resolve(process.cwd(), v)) : resolveBareName(v)

  if (!abs || !existsSync(abs)) {
    logger.warn(`[Atme-Plugin] 聊天背景图不存在，已忽略：${v}（可放到 ${bgDir}）`)
    return null
  }
  return `file:///${abs.replace(/\\/g, '/')}`
}

/**
 * CSS url() 里的引号与反斜杠要转义。
 * ⚠️ 这里用**单引号**包 url：整段是拼进 `style="..."` 的，
 *    url 里再用双引号会让属性在上面那个双引号处**提前截断** ——
 *    浏览器拿到的 style 只有半截 `background-image:url(`，整条规则作废。
 */
function escapeCssUrl (url) {
  return String(url).replace(/[\\']/g, '\\$&').replace(/[\r\n]/g, '')
}

/**
 * 取背景配置（按文件 mtime 缓存）。
 * @returns {{url: string|null, veil: number}}
 */
export function getBackground () {
  try {
    const mtime = statSync(userConfigPath).mtimeMs
    if (cache && mtime === cacheMtime) return cache

    const cfg = YAML.parse(readFileSync(userConfigPath, 'utf-8')) || {}
    const bg = cfg.background || {}

    // 面板上有两个入口：上传的图（image）和手填的链接/路径（imageUrl）；填了后者优先
    const rawUrl = toCssUrl(bg.imageUrl || bg.image)
    const veil = parseVeil(bg.veil)
    const fitRaw = String(bg.fit ?? '').trim().toLowerCase()
    const posRaw = String(bg.position ?? '').trim().toLowerCase()
    const ratioNum = Number(bg.screenRatio)
    cache = {
      url: rawUrl,
      veil,
      fit: FIT_VALUES.includes(fitRaw) ? fitRaw : 'cover',
      position: POS_VALUES.includes(posRaw) ? posRaw : 'center',
      // 0 = 不撑；其余限制在 1~3，防手滑填个 100 把图撑坏
      screenRatio: ratioNum === 0
        ? 0
        : (Number.isFinite(ratioNum) && ratioNum >= 1 && ratioNum <= 3 ? ratioNum : DEFAULT_SCREEN_RATIO)
    }
    cacheMtime = mtime
    return cache
  } catch {
    return { url: null, veil: DEFAULT_VEIL, fit: 'cover', position: 'center', screenRatio: DEFAULT_SCREEN_RATIO }
  }
}

/**
 * 生成铺到 `.phone` 上的样式（不用背景时返回空串）。
 * 返回的是可以直接拼进 style="" 的一段。
 */
export function backgroundStyle () {
  const { url, fit, position, veil } = getBackground()
  if (!url) return ''
  // --veil 交给 CSS 里的 .phone.has-bg::before 用（遮罩要盖住整个手机，不只是聊天区）。
  // CSS 的 rgba() 要 0~1，所以这里把百分比折回去。
  return `--veil:${(veil / 100).toFixed(3)};background-image:url('${escapeCssUrl(url)}');`
    + `background-size:${fit};background-position:${position};background-repeat:no-repeat;`
}

/** 聊天区那层白色遮罩的 rgba（不用背景时返回空串，保持原来的透明） */
export function chatVeilStyle () {
  const { url, veil } = getBackground()
  if (!url) return ''
  return `background:rgba(255,255,255,${(veil / 100).toFixed(3)});`
}

/**
 * 有背景时手机的最小高度（px）。没背景返回 0（不加约束）。
 * 由调用方把 viewportWidth 传进来，换宽度（比如帮助图 760）也按比例对齐。
 */
export function minHeightPx (viewportWidth) {
  const { url, screenRatio } = getBackground()
  if (!url) return 0
  return Math.round(Number(viewportWidth) * screenRatio)
}

export { DEFAULT_VEIL, DEFAULT_SCREEN_RATIO, parseVeil }
export default { getBackground, backgroundStyle, chatVeilStyle, minHeightPx }
