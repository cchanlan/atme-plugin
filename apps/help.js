import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import * as Render from '../components/render.js'
import { getSegmentFactory, imageMessage } from '../lib/messageAdapter.js'
import { applyGroupGate } from '../lib/pluginKit.js'
import { resourcesDir, helpCacheDir } from '../components/paths.js'
import { getImgType } from '../components/imageType.js'

const require = createRequire(import.meta.url)

// 帮助图模板版本号：仅当模板结构/渲染方式本身变化时才需要递增。
// 日常改 modules 文案不用动它 —— 缓存文件名带内容哈希，内容一变自动失效重建。
// v7：换成蓝粉渐变浅色卡片风（与出图界面统一）+ 默认开启语义
const HELP_VERSION = 'v7'

const tplPath = path.join(resourcesDir, 'html', 'atme_help.html')
const CACHE_DIR = helpCacheDir

try { await fs.mkdir(CACHE_DIR, { recursive: true }) } catch {}

const themeColors = ['#7cb2ff', '#bda6ff', '#ffa8d4']

function getNow () {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}/${p(now.getMonth() + 1)}/${p(now.getDate())}`
  const hour = `${p(now.getHours())}:${p(now.getMinutes())}`
  return { date, hour, full: `${date} ${hour}` }
}

// 帮助菜单内容（分组 + 条目）
const modules = [
  {
    name: '谁艾特我',
    desc: '所有人可用 · 只查当前群',
    commands: [
      { cmd: '谁艾特我 / 谁@我 / 谁at我', desc: '查询自己在当前群被艾特的记录' },
      { cmd: '谁艾特他 @某人', desc: '查询指定成员（「它」= 机器人自己，不用 @）' }
    ]
  },
  {
    name: '艾特提醒',
    desc: '默认开启 · 被艾特的群友下次发言时会收到提醒',
    commands: [
      { cmd: '#关闭我的艾特提醒', desc: '不想接收提醒就发这一条（只对你自己生效）' },
      { cmd: '#我的艾特提醒状态 / #开启我的艾特提醒', desc: '查看状态 · 重新开启' },
      { cmd: '#关闭本群艾特提醒', desc: '仅主人 · 关掉整个群的提醒（#开启本群艾特提醒 恢复）' }
    ]
  },
  {
    name: '上下文',
    desc: '记录层与提醒层是两个独立开关',
    commands: [
      { cmd: '#开启艾特上下文 / #关闭艾特上下文', desc: '仅主人 · 是否记录艾特前后的聊天' },
      { cmd: '#开启本群提醒上下文 / #关闭本群提醒上下文', desc: '仅主人 · 提醒图是否显示前后消息' },
      { cmd: '#设置本群提醒上下文 前 后', desc: '仅主人 · 范围 0~5（例：#设置本群提醒上下文 3 2）' }
    ]
  },
  {
    name: '数据清理',
    desc: '删记录的同时会删掉对应图片',
    commands: [
      { cmd: '#清空我的艾特', desc: '所有人可用 · 清空自己在本群的记录与图片' },
      { cmd: '#清空全部艾特 / #重置艾特插件', desc: '仅主人 · 前者不动开关，后者一切回到默认' }
    ]
  },
  {
    name: '提醒规则',
    desc: '可在锅巴后台「提醒配置」中调整',
    commands: [
      { cmd: '静默期 / 冷却期', desc: '被艾特后 600 秒内发言不提醒 · 提醒过一次 60 分钟内不再提醒' },
      { cmd: '自动撤回 / 数据过期', desc: '提醒消息 60 秒后撤回 · 记录保留 1 天后连图片一起清理' }
    ]
  },
  {
    name: '其他',
    desc: '帮助与统计',
    commands: [
      { cmd: '#艾特帮助 / #艾特帮助刷新', desc: '查看本帮助 · 重新生成' },
      { cmd: '#艾特统计', desc: '查看已存记录、图片数量与占用大小' }
    ]
  }
].map((m, i) => ({ ...m, color: themeColors[i % themeColors.length] }))

// ---------- 渲染（插件自管管线，2x 超采样 PNG）----------
const template = require('art-template')

async function renderHelpImage () {
  const now = getNow()
  const html = template(tplPath, {
    title: 'Atme-Plugin',
    version: HELP_VERSION,
    time: now.full,
    date: now.date,
    hour: now.hour,
    modules
  })

  const buffs = await Render.renderPageBuffers({
    pages: [html],
    tempPrefix: 'atme_help',
    viewportWidth: 760,
    deviceScaleFactor: 2,
    screenshotSelector: '#container',
    imgType: getImgType()
  })

  if (!buffs || buffs.length === 0) throw new Error('渲染返回空结果')
  const cacheFile = getCacheFile()
  await fs.writeFile(cacheFile, buffs[0])
  return cacheFile
}

/**
 * 缓存文件名带「帮助内容」的哈希。
 * 内容一变文件名就变，旧缓存自然不再命中；顺带把旧文件清掉。
 */
function getCacheFile () {
  const imgType = getImgType()
  // 哈希里带上出图格式：改了格式必须重建缓存，否则拿到的还是旧格式的图
  const hash = crypto.createHash('md5')
    .update(HELP_VERSION + imgType + JSON.stringify(modules))
    .digest('hex').slice(0, 8)
  // 后缀跟着格式走（宿主发送时按文件头识别，但文件名与实际格式一致更清楚）
  return path.join(CACHE_DIR, `help_${HELP_VERSION}_${imgType}_${hash}.${imgType}`)
}

/**
 * 判断哪些文件属于本插件生成的帮助图缓存。
 *
 * 要认得历代命名，否则旧版本留下的文件会永远占着目录
 * （曾出现过 `help.png` 和 `help_v6_xxx.png` 两个旧缓存一直清不掉的情况）。
 * 只要文件名以 help 开头、以 .png 结尾，都算本插件的东西。
 */
const isCacheFile = (f) => /^help.*\.(png|jpe?g|webp)$/i.test(f)

async function cleanStaleCache () {
  const keep = path.basename(getCacheFile())
  try {
    const files = await fs.readdir(CACHE_DIR)
    for (const f of files) {
      if (isCacheFile(f) && f !== keep) await fs.unlink(path.join(CACHE_DIR, f)).catch(() => {})
    }
  } catch { /* 目录不存在就当没缓存 */ }
}

async function isCacheValid () {
  try {
    await fs.access(getCacheFile())
    return true
  } catch {
    return false
  }
}

/**
 * 拿帮助图。命中缓存直接用；没命中就现出图。
 *
 * ⚠️ 两条路径都要清旧缓存：改了出图格式后，新格式的缓存文件**不存在**，
 *    走的是"现出图"这条 —— 早先只有命中缓存时才清，结果旧格式的缓存
 *    一直留在目录里没人管（实测切换格式后 png 和 jpeg 两份并存）。
 */
async function generateIfNeeded () {
  if (await isCacheValid()) {
    cleanStaleCache()
    return getCacheFile()
  }
  const file = await renderHelpImage()
  await cleanStaleCache()   // 刚生成新格式，顺手把别的格式/版本的清掉
  return file
}

async function refreshHelp () {
  // 清掉所有历史版本的缓存文件
  try {
    const files = await fs.readdir(CACHE_DIR)
    for (const f of files) {
      if (isCacheFile(f)) await fs.unlink(path.join(CACHE_DIR, f)).catch(() => {})
    }
  } catch { /* 目录不存在 */ }
  return await renderHelpImage()
}

function replyImage (e, imgPath) {
  return e.reply(imageMessage(getSegmentFactory(e), imgPath))
}

export class AtmeHelp extends plugin {
  constructor () {
    super({
      name: 'Atme-Plugin 艾特帮助',
      dsc: '#艾特帮助',
      event: 'message',
      priority: 100,
      rule: [
        { reg: /^#艾特帮助$/i, fnc: 'showHelp' },
        { reg: /^#艾特帮助刷新$/i, fnc: 'refreshCache' }
      ]
    })

    applyGroupGate(this)
  }

  async showHelp (e) {
    if (this._generating) {
      e.reply('⏳ 正在生成帮助图片，请稍后再试...')
      return true
    }
    this._generating = true
    try {
      replyImage(e, await generateIfNeeded())
    } catch (err) {
      logger.error('[Atme-Plugin] 帮助生成失败:', err)
      e.reply('❌ 生成帮助菜单失败')
    } finally {
      this._generating = false
    }
    return true
  }

  async refreshCache (e) {
    if (this._generating) {
      e.reply('⏳ 正在刷新帮助图片，请稍后再试...')
      return true
    }
    this._generating = true
    try {
      replyImage(e, await refreshHelp())
    } catch (err) {
      logger.error('[Atme-Plugin] 刷新帮助失败:', err)
      e.reply('❌ 刷新帮助失败')
    } finally {
      this._generating = false
    }
    return true
  }
}

export { AtmeHelp as plugin }
