// components/record.js —— Atme-Plugin 数据与 IO 核心
//
// 职责：配置读取 / 记录读写封装 / 上下文缓存与补全任务 / 录制主链路 / 清理调度 / 删除与重置
//
// 通用能力已抽到 lib/，本文件只做"把这些拼成业务链路"这件事：
//   lib/imageFetch.js   —— 图片下载与 ffmpeg 转码
//   lib/imageFiles.js   —— 图片扫描、引用收集、回收、孤儿扫描
//   lib/messageAdapter.js —— 消息段解析（ncqq / icqq 兼容）
//
// 依赖红线：只依赖 components/*（store / render）与 lib/*，不反向依赖 apps/*。
//   - 未读标记（saveUnreadAt）由 apps 层完成：recordAtMessage 返回待标记列表。
//   - beforeCache / afterTasks 是模块级单例 Map：Yunzai loader 每条消息都会
//     new 插件类，绝不能挂到类字段上，否则每条消息都会多出一份独立缓存。
//
// 数据层：SQLite（data/atme/atme.db），不依赖 Redis。

import fs from 'fs/promises'
import { readFileSync, existsSync, statSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'yaml'
import * as Store from './store.js'
import { cleanMessageSegments, clampCtxCount } from './render.js'
import { extractAt, extractImages, extractFaces, extractQuoted } from '../lib/messageAdapter.js'
import { downloadAll } from '../lib/imageFetch.js'
import {
  collectImagesFromRecord,
  deleteImageFiles,
  sweepOrphanImages
} from '../lib/imageFiles.js'

// ---------- 路径初始化 ----------
// 统一从 components/paths.js 取 —— 那里是全插件唯一的路径定义处，
// 数据目录、图片目录、临时目录、配置目录都只有一份，避免各文件各算一套。

import { dataDir, imagesDir, tempDir, configDir, defaultConfigDir, userConfigPath } from './paths.js'
export { dataDir, imagesDir }

await fs.mkdir(dataDir, { recursive: true })
await fs.mkdir(imagesDir, { recursive: true })
await fs.mkdir(tempDir, { recursive: true })
await fs.mkdir(configDir, { recursive: true })
await fs.mkdir(defaultConfigDir, { recursive: true })

// ---------- 配置 ----------
// 默认配置唯一来源是 config/default_config/atme.yaml（随插件仓库分发）。
// 这里不再内置旧模板：历史上那份模板缺键，一旦触发会造出残缺的默认文件。

try {
  if (!existsSync(userConfigPath)) {
    await fs.copyFile(resolve(defaultConfigDir, 'atme.yaml'), userConfigPath)
    logger.mark('[Atme-Plugin] 已创建用户配置文件')
  }
} catch (e) {
  logger.error(
    `[Atme-Plugin] 初始化用户配置失败（请检查 config/default_config/atme.yaml 是否存在，必要时更新插件）: ${e.message}`
  )
}

let configCache = null
let configLastModified = 0

/**
 * 获取配置（按文件 mtime 缓存，改完保存即生效）
 */
export function getConfig () {
  // 兜底默认值必须与 config/default_config/atme.yaml 保持一致：
  // 本分支只在用户配置读取失败时生效，若两处漂移，故障降级后的行为会静默跳变
  const defaultValues = {
    expireDays: 1,
    maxRecordsPerUser: 30,
    defaultContext: true,
    enableAtAll: false,
    atAll: { maxCount: 10 },
    context: { enabled: true, beforeCount: 1, afterCount: 1 }
  }

  try {
    const stats = statSync(userConfigPath)
    const currentModified = stats.mtimeMs

    if (currentModified !== configLastModified || !configCache) {
      const raw = readFileSync(userConfigPath, 'utf-8')
      const userConfig = yaml.parse(raw) || {}
      configCache = { ...defaultValues, ...userConfig }

      if (userConfig.context) {
        configCache.context = { ...defaultValues.context, ...userConfig.context }
        // clampCtxCount：0-5 clamp + NaN/非数字防御
        configCache.context.beforeCount = clampCtxCount(configCache.context.beforeCount)
        configCache.context.afterCount = clampCtxCount(configCache.context.afterCount)
      }
      if (userConfig.atAll) {
        configCache.atAll = { ...defaultValues.atAll, ...userConfig.atAll }
      }

      configLastModified = currentModified
      logger.debug(`[Atme-Plugin] 配置已重新读取，context: ${JSON.stringify(configCache.context)}`)
    }

    return configCache
  } catch (err) {
    logger.warn(`[Atme-Plugin] 读取配置失败，使用默认值: ${err.message}`)
    return defaultValues
  }
}

// 配置文件变了就丢缓存，下次读取时重载
try {
  const watcher = watch(configDir, (eventType, filename) => {
    if (filename === 'atme.yaml') {
      configCache = null
      configLastModified = 0
    }
  })
  watcher.unref?.()
} catch (err) {
  logger.debug(`[Atme-Plugin] 配置文件监听初始化失败: ${err.message}`)
}

// ---------- 存储初始化 ----------
try {
  await Store.initDB()
  logger.mark('[Atme-Plugin] SQLite 存储初始化完成')
} catch (err) {
  logger.error('[Atme-Plugin] SQLite 存储初始化失败', err)
  throw err
}

// ---------- 全局上下文缓存（模块级单例，见文件头红线说明） ----------
const beforeCache = new Map()   // group_id -> [{User,message,image,name,time}]
const afterTasks = new Map()    // group_id -> [{uniqueId,count}]

// ---------- 清理：过期 / 超量 / 孤儿 ----------

/** 删掉记录后，把内存里指向它们的「下文补全」任务一并清掉 */
function dropAfterTasks (deletedRows) {
  const byGroup = new Map()
  for (const row of deletedRows) {
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, new Set())
    byGroup.get(row.group_id).add(row.unique_id)
  }
  for (const [gid, ids] of byGroup) {
    const tasks = afterTasks.get(gid)
    if (!tasks) continue
    const kept = tasks.filter(t => !ids.has(t.uniqueId))
    if (kept.length) afterTasks.set(gid, kept)
    else afterTasks.delete(gid)
  }
}

let lastExpireCleanupAt = 0

async function cleanExpiredRecords (force = false) {
  // 节流：默认 1 小时内不重复全表扫描（查询接口每次都会调用）
  const now = Date.now()
  if (!force && now - lastExpireCleanupAt < 3600000) return 0
  lastExpireCleanupAt = now

  try {
    const cfg = getConfig()
    const expireTimestamp = Math.floor(Date.now() / 1000) - cfg.expireDays * 86400
    const all = await Store.getAllRecords()
    const expired = all.filter(r => r.time < expireTimestamp)
    if (expired.length === 0) return 0

    const files = []
    for (const row of expired) files.push(...collectImagesFromRecord(row, dataDir))

    const deleted = await Store.deleteRecordsByUids(expired.map(r => r.unique_id))
    await Store.purgeOrphanUnread()
    await Store.purgeOrphanTrigger()

    const { count, bytes } = await deleteImageFiles(files)
    dropAfterTasks(deleted)

    logger.info(
      `[Atme-Plugin] 清理了 ${deleted.length} 条过期记录、${count} 张图片（${(bytes / 1024).toFixed(1)} KB）`
    )
    return deleted.length
  } catch (err) {
    logger.warn(`[Atme-Plugin] 清理过期记录失败（不影响查询）: ${err.message}`)
    return 0
  }
}

async function limitRecordsPerUser (groupId, targetQQ) {
  const cfg = getConfig()
  const rows = await Store.getAtRecords(groupId, targetQQ)
  if (rows.length <= cfg.maxRecordsPerUser) return

  // 按时间降序取超出配额的部分
  const sorted = [...rows].sort((a, b) => b.time - a.time)
  const toDelete = sorted.slice(cfg.maxRecordsPerUser)

  const files = []
  for (const row of toDelete) files.push(...collectImagesFromRecord(row, dataDir))

  const deleted = await Store.deleteRecordsByUids(toDelete.map(r => r.unique_id))
  await Store.purgeOrphanUnread()
  const { count } = await deleteImageFiles(files)
  dropAfterTasks(deleted)

  logger.info(
    `[Atme-Plugin] 清理了 ${toDelete.length} 条超量记录、${count} 张图片 (群${groupId}, QQ${targetQQ})`
  )
}

/** 孤儿图片扫描（走 lib/imageFiles.js） */
async function sweepOrphans () {
  const rows = await Store.getAllRecords()
  return sweepOrphanImages(imagesDir, dataDir, rows)
}

/**
 * 清理宿主 `temp/` 里遗留的过期图片。
 *
 * ## 为什么需要
 *
 * 出图结果以 Buffer 交给宿主的 `e.reply()`（这是最通用的做法，见 forward.js 的说明），
 * 宿主 `util.Buffer()` 在 buffer 超过 size 限制时会把它落盘成 `temp/<ulid>`，
 * 并挂一个 **60 秒后删除**的定时器。
 *
 * ⚠️ 那个定时器活在进程内存里 —— **出图后 60 秒内重启一次就永远丢**，文件永久残留。
 *    （JiuLi 的 OneBotv11 传 `size: 0`，任何图都会落盘；TRSS 传 10MB，正常图走 base64
 *      不落盘，所以这个坑只在部分框架上明显。）
 *
 * ## 为什么判据是「ulid 文件名 + 超过 24 小时」
 *
 * `temp/` 是**宿主与所有插件共用**的目录，混着别人的出图。单看文件名或图片尺寸
 * 都分不清归属，按那些判据删有误删风险。时间判据最安全：宿主本该 60 秒就删，
 * 超过 24 小时（它的 1440 倍）还留着的，只可能是重启漏下来的死文件。
 */
const LEGACY_HOST_TEMP_MS = 24 * 3600 * 1000

/** 清理宿主 temp 下遗留的过期图片 */
async function cleanHostTempFiles () {
  let count = 0
  let bytes = 0

  try {
    const hostTempDir = resolve(process.cwd(), 'temp')
    const deadline = Date.now() - LEGACY_HOST_TEMP_MS
    for (const name of await fs.readdir(hostTempDir)) {
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)) continue
      const abs = resolve(hostTempDir, name)
      try {
        const stat = await fs.stat(abs)
        if (!stat.isFile()) continue
        if (stat.mtimeMs > deadline) continue
        await fs.unlink(abs)
        count++
        bytes += stat.size || 0
      } catch (err) {
        logger.debug(`[Atme-Plugin] 清理宿主遗留文件失败 ${name}: ${err.message}`)
      }
    }
  } catch { /* 没有这个目录就算了 */ }

  if (count > 0) {
    logger.info(`[Atme-Plugin] 清理了 ${count} 个临时图（${(bytes / 1024 / 1024).toFixed(1)} MB）`)
  }
  return { count, bytes }
}

function schedulePeriodicCleanup () {
  function msToNextCleanup () {
    const now = new Date()
    const target = new Date(now)
    target.setHours(4, 0, 0, 0)
    if (target <= now) {
      target.setDate(target.getDate() + 1)
      target.setHours(4, 0, 0, 0)
    }
    return target.getTime() - now.getTime()
  }

  async function performCleanup () {
    const startedAt = Date.now()
    try {
      const expired = await cleanExpiredRecords(true)
      const groups = await Store.getAllGroupTargets()
      for (const { group_id, target_qq } of groups) {
        await limitRecordsPerUser(group_id, target_qq)
      }
      await Store.purgeOrphanUnread()
      await Store.purgeOrphanTrigger()
      const orphan = await sweepOrphans()
      const hostTemp = await cleanHostTempFiles()
      logger.info(
        `[Atme-Plugin] 清理任务完成：过期 ${expired} 条，孤儿图片 ${orphan.count} 张` +
        `（${(orphan.bytes / 1024).toFixed(1)} KB），宿主临时图 ${hostTemp.count} 个` +
        `，耗时 ${Date.now() - startedAt}ms`
      )
    } catch (err) {
      logger.error('[Atme-Plugin] 定时清理失败:', err)
    }

    const next = msToNextCleanup()
    const timer = setTimeout(performCleanup, next)
    timer.unref?.()
    logger.info(`[Atme-Plugin] 下次清理将在 ${new Date(Date.now() + next).toLocaleString()} 执行`)
  }

  // 启动后先跑一次，避免首次清理要等到第二天凌晨 4 点
  const startupTimer = setTimeout(performCleanup, 60000)
  startupTimer.unref?.()
}

// 进程级唯一：插件若被热重载（模块重新实例化），不能出现第二个每日清理循环
const CLEANUP_LOOP_KEY = Symbol.for('atme-plugin:periodicCleanup')
if (!globalThis[CLEANUP_LOOP_KEY]) {
  globalThis[CLEANUP_LOOP_KEY] = true
  schedulePeriodicCleanup()
}

// ---------- 记录读写 ----------

async function saveAtRecord (payload) {
  let processedQuoted = payload.quotedContent
  if (processedQuoted?.images?.length) {
    // 引用消息里的图也要落到本地（否则对方撤回/过期后引用就是破图）
    processedQuoted = {
      ...processedQuoted,
      images: await downloadAll(processedQuoted.images, imagesDir, dataDir)
    }
  }
  return Store.saveAtRecord({ ...payload, quotedContent: processedQuoted })
}

export async function getAtRecords (groupId, targetQQ) {
  await cleanExpiredRecords()
  const rows = await Store.getAtRecords(groupId, targetQQ)
  return rows.map(row => ({
    ...row,
    images: Array.isArray(row.images) ? row.images : [],
    face_id: Array.isArray(row.face_id) ? row.face_id : [],
    before_msg: Array.isArray(row.before_msg) ? row.before_msg : [],
    after_msg: Array.isArray(row.after_msg) ? row.after_msg : [],
    quoted_msg: row.quoted_msg ?? null,
    is_context: !!row.is_context
  }))
}

/**
 * 删除某人在某群的全部艾特记录
 * 同时删除：记录引用的全部图片 + 提醒模块关联的未读行 / 触发时间 + 内存待补全任务
 */
async function deleteUserRecords (groupId, targetQQ) {
  const rows = await Store.getAtRecords(groupId, String(targetQQ))
  if (rows.length === 0) return { records: 0, images: 0, bytes: 0 }

  const files = []
  for (const row of rows) files.push(...collectImagesFromRecord(row, dataDir))

  const deleted = await Store.deleteRecordsByUids(rows.map(r => r.unique_id))
  await Store.clearUnread(groupId, String(targetQQ))
  await Store.purgeOrphanUnread()
  await Store.purgeOrphanTrigger()

  const { count, bytes } = await deleteImageFiles(files)
  dropAfterTasks(deleted)

  logger.info(
    `[Atme-Plugin] 清除个人记录：群${groupId} QQ${targetQQ}，${rows.length} 条记录 / ${count} 张图片`
  )
  return { records: rows.length, images: count, bytes }
}

/** 清空全部艾特（含图片与提醒侧关联数据） */
async function deleteAllRecords () {
  const rows = await Store.getAllRecords()

  const files = []
  for (const row of rows) files.push(...collectImagesFromRecord(row, dataDir))

  // 上下文缓存里可能持有刚下载、尚未落库的图片，先收集再清空缓存
  for (const [, cache] of beforeCache) {
    for (const ctx of cache) {
      if (ctx && Array.isArray(ctx.image)) {
        for (const p of ctx.image) {
          if (typeof p === 'string' && p.startsWith('images/')) files.push(resolve(dataDir, p))
        }
      }
    }
  }

  await Store.deleteAllRecords()
  await Store.clearUnreadAll()
  await Store.clearTriggerAll()
  await Store.clearAtAll()

  const { count, bytes } = await deleteImageFiles(files)
  afterTasks.clear()
  beforeCache.clear()

  // 兜底：整目录扫一遍，确保不留残图
  const remain = await fs.readdir(imagesDir).catch(() => [])
  for (const file of remain) {
    try {
      await fs.unlink(resolve(imagesDir, file))
    } catch (err) {
      logger.debug(`[Atme-Plugin] 删除残留图片失败 ${file}: ${err.message}`)
    }
  }

  logger.info(`[Atme-Plugin] 清除全部记录：${rows.length} 条记录 / ${count} 张图片`)
  return { records: rows.length, images: count, bytes }
}

async function resetDatabase () {
  const files = await fs.readdir(imagesDir).catch(() => [])
  for (const file of files) {
    try {
      await fs.unlink(resolve(imagesDir, file))
    } catch (err) {
      logger.debug(`[Atme-Plugin] 删除图片失败 ${file}: ${err.message}`)
    }
  }

  // 数据表全部清空（含群/个人开关与上下文配置），回到默认状态
  await Store.resetAll()

  afterTasks.clear()
  beforeCache.clear()

  logger.mark('[Atme-Plugin] 数据已重置')
}

async function getContextEnabled (groupId) {
  const v = await Store.getContextEnabled(groupId)
  const cfg = getConfig()
  return v === null ? cfg.defaultContext : v
}

async function setContextEnabled (groupId, enabled) {
  await Store.setContextEnabled(groupId, enabled)
}

async function updateAfterMsg (uniqueId, afterMsg) {
  await Store.updateAfterMsg(uniqueId, afterMsg)
}

// ---------- 临时文件清理 ----------
async function cleanTempFiles () {
  const oneHourAgo = Date.now() - 3600000
  let cleaned = 0

  const files = await fs.readdir(tempDir).catch(() => [])
  for (const file of files) {
    const filePath = resolve(tempDir, file)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) continue
      if (stat.mtimeMs < oneHourAgo) {
        await fs.unlink(filePath)
        cleaned++
      }
    } catch (err) {
      logger.debug(`[Atme-Plugin] 清理临时文件失败: ${err.message}`)
    }
  }

  if (cleaned > 0) logger.info(`[Atme-Plugin] 清理了 ${cleaned} 个临时文件`)
}

/**
 * 启动临时文件清理定时器，并保证全进程只有一个。
 *
 * ⚠️ 不能把 setInterval 写进构造函数：Yunzai 的 loader 是
 * `Object.assign(new i.class(e), { e }).accept(e)`，**每条消息都会 new 一次插件类**。
 * 那样每条消息都会多一个永不回收的定时器。
 */
const TEMP_CLEANER_KEY = Symbol.for('atme-plugin:tempCleaner')
function ensureTempCleaner () {
  if (globalThis[TEMP_CLEANER_KEY]) return
  const timer = setInterval(() => {
    cleanTempFiles().catch(err => logger.debug(`[Atme-Plugin] 清理临时文件失败: ${err.message}`))
  }, 3600000)
  timer.unref?.()
  globalThis[TEMP_CLEANER_KEY] = timer
  cleanTempFiles().catch(err => logger.debug(`[Atme-Plugin] 清理临时文件失败: ${err.message}`))
}

// ---------- 录制主链路 ----------

/** 从事件里取一段干净的正文（去掉 CQ 码标记） */
function plainText (e) {
  return cleanMessageSegments((e.raw_message || '').replace(/\[.*?\]/g, '').trim())
}

/**
 * 录制一条群消息里的艾特。
 *
 * 返回待标记未读列表 [{ groupId, targetQQ, recordId }]：
 *   未读标记属于提醒模块（apps/atme_reminder.js），为避免 components 反向依赖 apps，
 *   这里只负责落库，由调用方拿到返回值后逐条 saveUnreadAt。
 */
async function recordAtMessage (e) {
  const groupId = String(e.group_id)
  const contextOn = await getContextEnabled(groupId)

  // @ 目标与 @全体 的判定统统走适配层（ncqq / icqq / 其它框架都能用）
  const { targets: atTargets, atAll, atBot } = extractAt(e)
  const imgUrls = extractImages(e)
  const faceId = extractFaces(e)

  const cfg = getConfig()
  const groupCard = e.sender?.card || e.sender?.nickname || e.nickname || ''
  const nick = groupCard || String(e.user_id)

  // @全体 记录：@all 本身不作为「被艾特的人」，但要看开关决定要不要单独记一条
  const recordAtAll = atAll && cfg.enableAtAll

  if (atAll) {
    logger.info(`[Atme-Plugin] 群 ${groupId} 全体艾特，全体部分${cfg.enableAtAll ? '照常记录' : '不记录'}`)
  }

  // ========== 主消息图片下载 ==========
  // 只有确实要用（记录艾特 / 记录上下文）才下载。
  // 原逻辑是无条件下载：群里每一张图都会走一次下载 + ffmpeg 转码，
  // 既浪费带宽和 CPU，又会在没人引用时直接变成孤儿文件
  let localImages = []
  if (atTargets.length > 0 || recordAtAll || contextOn) {
    localImages = await downloadAll(imgUrls, imagesDir, dataDir)
  }

  // ========== 上下文：本条消息补进已有的「下文」任务 ==========
  let currentMsgForContext = null
  if (contextOn) {
    currentMsgForContext = {
      User: e.user_id,
      message: plainText(e),
      image: localImages,
      name: nick,
      time: e.time
    }

    const tasks = afterTasks.get(groupId) || []
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i]
      const rec = await Store.getRecordByUid(task.uniqueId)
      if (rec) {
        const after = Array.isArray(rec.after_msg) ? rec.after_msg : []
        after.push(currentMsgForContext)
        await updateAfterMsg(task.uniqueId, after)
      }
      task.count++
      if (task.count >= 5) tasks.splice(i, 1)
    }
    afterTasks.set(groupId, tasks)
  }

  // ========== 引用消息 ==========
  // ⚠️ 只在真要落库时才去取引用：
  //    e.getReply() 是一次 get_msg 网络往返，而 recordAtMessage 是**每条群消息**都会进的。
  //    无条件调用会让每句话都多打一次 API —— 群里说话越热闹，机器人越卡。
  //    （e.source 是同步挂在事件上的，不用白不用，所以先看它。）
  let quotedRaw = null
  if (atTargets.length || recordAtAll) {
    quotedRaw = await extractQuoted(e)
  } else if (e.source && (e.source.message || e.source.msg)) {
    quotedRaw = await extractQuoted(e)
  }
  const quotedContent = quotedRaw
    ? { text: quotedRaw.text, images: quotedRaw.images, sender: quotedRaw.sender }
    : null

  const savedUnread = []

  // ---- @全体（轻量独立存储，不进 records/未读主链路） ----
  if (recordAtAll) {
    const trimmed = await Store.saveAtAll(groupId, {
      userId: e.user_id,
      message: plainText(e),
      images: localImages,
      name: nick,
      time: e.time,
      quotedContent
    }, {
      maxCount: cfg.atAll?.maxCount ?? 10,
      maxAgeSeconds: (cfg.expireDays ?? 5) * 86400
    })
    const orphanFiles = []
    for (const t of trimmed) {
      for (const p of (t.images || [])) {
        if (typeof p === 'string' && p.startsWith('images/')) orphanFiles.push(resolve(dataDir, p))
      }
    }
    if (orphanFiles.length) await deleteImageFiles(orphanFiles)
  }

  // ---- 普通 @ 目标 ----
  if (atTargets.length) {
    const rawMsg = plainText(e)
    const beforeMessages = contextOn ? (beforeCache.get(groupId) || []) : []

    for (const targetQQ of atTargets) {
      const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const recordId = await saveAtRecord({
        uniqueId,
        groupId,
        targetQQ,
        userId: e.user_id,
        message: rawMsg,
        images: localImages,
        faceId,
        name: nick,
        time: e.time,
        messageId: quotedRaw?.messageId || '',
        isContext: contextOn,
        before: beforeMessages,
        after: [],
        quotedContent
      })
      if (recordId) {
        savedUnread.push({ groupId, targetQQ: String(targetQQ), recordId })
      }
      if (contextOn) {
        const tasks = afterTasks.get(groupId) || []
        tasks.push({ uniqueId, count: 0 })
        afterTasks.set(groupId, tasks)
      }
    }
  }

  // ========== 本条消息进「上文」缓存 ==========
  if (contextOn && currentMsgForContext) {
    const cache = beforeCache.get(groupId) || []
    cache.push(currentMsgForContext)
    if (cache.length > 5) cache.shift()
    beforeCache.set(groupId, cache)
  }

  return savedUnread
}

// 导出面：只暴露外部实际消费的符号
//   query.js  → getConfig / getAtRecords / cleanTempFiles / dataDir
//   atme.js   → ensureTempCleaner / recordAtMessage / deleteUserRecords /
//               deleteAllRecords / resetDatabase / setContextEnabled / beforeCache / afterTasks
//   stats.js  → imagesDir
//   help.js   → （不用）
// dataDir / imagesDir 在文件上方就地导出了，这里不再重复列。
export {
  beforeCache, afterTasks,
  deleteUserRecords, deleteAllRecords, resetDatabase,
  getContextEnabled, setContextEnabled,
  cleanTempFiles, ensureTempCleaner,
  recordAtMessage
}
