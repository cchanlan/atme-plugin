// apps/atme_reminder.js —— 艾特被动提醒
//
// 行为：有人 @ 你 → 记一条未读；你下次在群里发言时，把这段时间的艾特记录出图 @ 你。
//
// ⚠️ 与旧版的差别（主人 2026-10-11 明确）：
//   **群与个人提醒默认都是开启的**，不用任何人去设置。
//   收到**第一次**提醒时附带一句「不想接收就发 #关闭我的艾特提醒」，
//   之后再提醒就不带这句了，不啰嗦。
//   （旧版是双层默认关闭，需要主人开群开关 + 每个人开个人开关，等于默认没人用。）

import plugin from '../../../lib/plugins/plugin.js'
import * as Render from '../components/render.js'
import { sendImages } from '../components/forward.js'
import * as Store from '../components/store.js'
import { getMemberMap, findMember, memberName, getSegmentFactory, atMessage, botIdentity } from '../lib/messageAdapter.js'
import { getConfig } from '../components/record.js'
import { isEnabledGroup } from '../components/groupEnable.js'
import { applyGroupGate } from '../lib/pluginKit.js'
import { dataDir as dataDirPath } from '../components/paths.js'

const dataDir = dataDirPath

// 默认值都在这里，配置文件里改了就以配置文件为准
const DEFAULTS = {
  EXPIRE_HOURS: 24,
  MAX_REMIND_COUNT: 30,
  AUTO_CLEAR_AFTER_SEND: true,
  REMIND_COOLDOWN_MINUTES: 60,
  SKIP_RECORD_DURING_COOLDOWN: true,
  AUTO_RECALL_SECONDS: 60,
  SILENT_SECONDS: 600,
  DEBUG: false
}

/** 提醒参数（yaml 改了即时生效，每次用之前现读） */
function cfg () {
  const c = getConfig()?.reminder || {}
  const pick = (k, fallback) => (c[k] === undefined || c[k] === null ? fallback : c[k])
  return {
    EXPIRE_HOURS: pick('expireHours', DEFAULTS.EXPIRE_HOURS),
    MAX_REMIND_COUNT: Math.max(1, Number(pick('maxRemindCount', DEFAULTS.MAX_REMIND_COUNT)) || DEFAULTS.MAX_REMIND_COUNT),
    AUTO_CLEAR_AFTER_SEND: !!pick('autoClearAfterSend', DEFAULTS.AUTO_CLEAR_AFTER_SEND),
    REMIND_COOLDOWN_MINUTES: pick('cooldownMinutes', DEFAULTS.REMIND_COOLDOWN_MINUTES),
    SKIP_RECORD_DURING_COOLDOWN: !!pick('skipRecordDuringCooldown', DEFAULTS.SKIP_RECORD_DURING_COOLDOWN),
    AUTO_RECALL_SECONDS: pick('autoRecallSeconds', DEFAULTS.AUTO_RECALL_SECONDS),
    SILENT_SECONDS: pick('silentSeconds', DEFAULTS.SILENT_SECONDS),
    DEBUG: !!pick('debug', DEFAULTS.DEBUG)
  }
}

// ---------- 防重复触发锁 ----------
// ⚠️ 这里踩过坑：锁的 TTL 一度固定 5 秒，而**出图 + 发图是浮动耗时的**
//    （渲染一页几百毫秒到几秒，合并转发更慢）。实测出现过：用户连发两条消息，
//    第一次处理花了 4.4 秒才发完，锁在 5 秒时过期，第二条消息直接闯进来，
//    于是同一批未读被提醒了两遍、图也发了两张。
//
//    所以锁的语义改成「**处理期间一直持有，处理完才释放**」：
//      · 正常路径 → 函数末尾的 releaseLock 释放
//      · 异常路径 → finally 里的 releaseLock 释放
//      · 进程/逻辑卡死 → TTL 兜底（给足余量，宁多锁一会儿也不能重复发）
//    这个 TTL 只是"防死锁"，不是"防重复"的主力。
const processingLock = new Map()
const LOCK_STALE_MS = 120000   // 兜底上限：正常绝不会占用这么久

function isLocked (groupId, userId) {
  const key = `${groupId}:${userId}`
  const at = processingLock.get(key)
  if (at === undefined) return false
  // 还没到兜底上限 → 认为有人正在处理，跳过这条消息
  if (Date.now() - at < LOCK_STALE_MS) return true
  // 理论上不该到这里（正常都会走 releaseLock）；真到了说明上次处理异常中断了
  logger.warn(`[Atme-Plugin] ${key} 的处理锁超时未释放（${LOCK_STALE_MS}ms），已强制放开`)
  processingLock.delete(key)
  return false
}

function setLock (groupId, userId) {
  processingLock.set(`${groupId}:${userId}`, Date.now())
  // 兜底清扫：把卡死的残留键删掉，避免 Map 无限增长
  if (processingLock.size > 200) {
    const deadline = Date.now() - LOCK_STALE_MS
    for (const [k, t] of processingLock) {
      if (t < deadline) processingLock.delete(k)
    }
  }
}

function releaseLock (groupId, userId) {
  processingLock.delete(`${groupId}:${userId}`)
}

// ---------- 超时撤回 ----------
function scheduleRecall (e, messageIds, delaySec) {
  if (!delaySec || delaySec <= 0) return
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean)
  if (!ids.length) return
  const timer = setTimeout(() => {
    for (const id of ids) {
      try {
        e.group?.recallMsg?.(id)
      } catch (err) {
        logger.debug(`[Atme-Plugin] 撤回消息 ${id} 失败: ${err.message}`)
      }
    }
  }, delaySec * 1000)
  timer.unref?.()
}

// ==================== 存储读写（默认开启：没设置过就是开） ====================

async function getGroupRemindEnabled (groupId) {
  const v = await Store.getGroupRemindEnabled(groupId)
  return v === null ? true : v      // ← 默认开启
}

async function setGroupRemindEnabled (groupId, enabled) {
  await Store.setGroupRemindEnabled(groupId, enabled)
}

async function getUserRemindEnabled (groupId, targetQQ) {
  const v = await Store.getUserRemindEnabled(groupId, targetQQ)
  return v === null ? true : v      // ← 默认开启
}

async function setUserRemindEnabled (groupId, targetQQ, enabled) {
  await Store.setUserRemindEnabled(groupId, targetQQ, enabled)
}

/**
 * 该用户是否已经收过提醒（收过就不再附「怎么关」的提示，避免每次都啰嗦）
 * 用冷却表当"提醒过"的凭据：提醒一次就会写冷却时间。
 */
async function hasRemindedBefore (groupId, targetQQ) {
  return (await Store.getCooldownAt(groupId, targetQQ)) != null
}

/** 群提醒上下文配置：库里没设置过就用 yaml 模板 */
async function getContextConfig (groupId) {
  const stored = await Store.getContextConfig(groupId)
  if (stored !== null) return { ...stored, persisted: true }

  const rc = getConfig()?.reminderContext || {}
  return {
    enabled: rc.enabled !== false,
    beforeCount: Render.clampCtxCount(rc.beforeCount ?? 1),
    afterCount: Render.clampCtxCount(rc.afterCount ?? 1),
    persisted: false
  }
}

async function setContextConfig (groupId, patch = {}) {
  const current = await getContextConfig(groupId)
  const enabled = patch.enabled === undefined ? current.enabled : !!patch.enabled
  const beforeCount = patch.beforeCount === undefined
    ? current.beforeCount
    : Render.clampCtxCount(patch.beforeCount)
  const afterCount = patch.afterCount === undefined
    ? current.afterCount
    : Render.clampCtxCount(patch.afterCount)

  await Store.setContextConfig(groupId, { enabled, beforeCount, afterCount })
  return { enabled, beforeCount, afterCount }
}

export async function isInCooldown (groupId, targetQQ) {
  const last = await Store.getCooldownAt(groupId, targetQQ)
  if (last == null) return false
  const cooldownSec = cfg().REMIND_COOLDOWN_MINUTES * 60
  const elapsed = Math.floor(Date.now() / 1000) - last
  return elapsed < cooldownSec
}

/** 被艾特时调用：登记未读（由 apps/atme.js 的录制链路回调） */
export async function saveUnreadAt (groupId, targetQQ, recordId) {
  const c = cfg()
  try {
    // 群/个人开关都没关才记录
    if (!(await getGroupRemindEnabled(groupId))) return
    if (!(await getUserRemindEnabled(groupId, targetQQ))) return

    if (c.SKIP_RECORD_DURING_COOLDOWN && await isInCooldown(groupId, targetQQ)) {
      if (c.DEBUG) logger.mark(`[Atme-Plugin] ${targetQQ} 在冷却中，跳过记录未读艾特`)
      return
    }

    // 先记触发时间，再存未读，避免静默期判定读到旧的 trigger
    await Store.recordAtTriggerTime(groupId, targetQQ)
    await Store.saveUnreadAt(groupId, targetQQ, recordId)
  } catch (err) {
    logger.error(`[Atme-Plugin] 保存未读艾特失败: ${err.message}`)
  }
}

export async function reinitReminderDB () {
  return Store.reinitReminderDB()
}

/**
 * 存储健康检查（带 30 秒节流）。
 * accept() 是**每条群消息**都会进的，没必要每次都 ping。
 */
let lastHealthCheckAt = 0
let lastHealthOk = true
async function checkDBHealth () {
  const now = Date.now()
  if (now - lastHealthCheckAt < 30000) return lastHealthOk
  lastHealthCheckAt = now
  lastHealthOk = await Store.checkDBHealth()
  return lastHealthOk
}

// ==================== 出图 ====================

async function renderReminderImage (e, records, targetQQ, groupName, memberCount) {
  if (!records.length) return []

  const ctxCfg = await getContextConfig(e.group_id)
  const gm = await getMemberMap(e)

  // 被提醒者的昵称：每条艾特 @ 的都是同一个人（targetQQ），@ 前缀共用一个名字。
  // 取法与查询图一致——群名片优先，拿不到 memberName 会回落 QQ 号。
  const targetInfo = findMember(gm, targetQQ) || {}
  const targetName = memberName(targetInfo, targetQQ, '')

  const msgListRaw = []

  const contextMap = (ctx, isBefore, index) => {
    const info = findMember(gm, ctx.User) || {}
    return {
      message: Render.cleanMessageSegments(ctx.message) || '',
      images: ctx.image || [],
      user_id: ctx.User,
      nickname: memberName(info, ctx.User, ctx.name),
      role: info.role || 'member',
      title: info.title || '',
      level: info.level || 1,
      avatar: Render.avatarUrl(ctx.User),
      time: ctx.time,
      isAt: false,
      contextType: isBefore ? 'before' : 'after',
      sortTime: isBefore ? ctx.time - 0.1 - index * 0.01 : ctx.time + 0.1 + index * 0.01
    }
  }

  for (const rec of records) {
    const senderId = rec.user_id
    const info = findMember(gm, senderId) || {}
    const mainMsg = {
      message: rec.message || '',
      images: rec.images || [],
      user_id: senderId,
      nickname: memberName(info, senderId, rec.name),
      role: info.role || 'member',
      title: info.title || '',
      level: info.level || 1,
      avatar: Render.avatarUrl(senderId),
      time: rec.time,
      isAt: true,
      // 提醒图也要补 @ 前缀：与查询图一致，显示「@被艾特的那个人」。
      // 提醒图里所有主消息 @ 的都是同一个人，共用一个名字。
      atTarget: targetName,
      sortTime: rec.time,
      quotedMsg: rec.quoted_msg
    }

    if (rec.is_context && ctxCfg.enabled) {
      const beforeList = ctxCfg.beforeCount > 0 ? (rec.before_msg || []).slice(-ctxCfg.beforeCount) : []
      const afterList = ctxCfg.afterCount > 0 ? (rec.after_msg || []).slice(0, ctxCfg.afterCount) : []

      beforeList.forEach((ctx, idx) => msgListRaw.push(contextMap(ctx, true, idx)))
      msgListRaw.push(mainMsg)
      afterList.forEach((ctx, idx) => msgListRaw.push(contextMap(ctx, false, idx)))
    } else {
      msgListRaw.push(mainMsg)
    }
  }

  // 提醒图要区分上文/下文，所以带上 sortTime 参与去重
  const msgList = Render.dedupeAndSort(msgListRaw, { distinguishContext: true })
  if (!msgList.length) return []

  const bannerHtml = `<div class="banner"><span class="dot"></span>你不在的时候，有人艾特过你</div>`

  // selfQQ = 被提醒的人：他自己的发言靠右显示（气泡配色与别人一致）
  return Render.renderMessages({
    msgList,
    groupName,
    memberCount,
    selfQQ: targetQQ,
    dataDir,
    bannerHtml,
    tempPrefix: 'atme_reminder',
    e
  })
}

// ==================== 插件类 ====================

export class atmeReminder extends plugin {
  constructor () {
    super({
      name: 'Atme-Plugin 艾特被动提醒',
      dsc: '用户被艾特后，下次发言时主动提醒（默认开启）',
      event: 'message',
      priority: -114513,
      rule: [
        // ===== 群提醒开关 =====
        // 注意：这里不用 (本群)? 这种可选写法，否则「#开启艾特提醒」会同时命中群规则和个人规则
        { reg: /^#?开启本群艾特提醒$/i, fnc: 'onGroupRemind', permission: 'master' },
        { reg: /^#?关闭本群艾特提醒$/i, fnc: 'offGroupRemind', permission: 'master' },
        { reg: /^#?本群艾特提醒状态$/i, fnc: 'groupRemindStatus', permission: 'master' },
        { reg: /^#?开启本群提醒上下文$/i, fnc: 'onContext', permission: 'master' },
        { reg: /^#?关闭本群提醒上下文$/i, fnc: 'offContext', permission: 'master' },
        { reg: /^#?设置本群提醒上下文\s+(\d+)\s+(\d+)$/i, fnc: 'setContextCount', permission: 'master' },

        // ===== 个人提醒开关：所有人可用，仅对自己生效 =====
        { reg: /^#?开启我的艾特提醒$/i, fnc: 'onUserRemind' },
        { reg: /^#?关闭我的艾特提醒$/i, fnc: 'offUserRemind' },
        { reg: /^#?我的艾特提醒状态$/i, fnc: 'userRemindStatus' }
      ]
    })

    // 群聊启用开关：按锅巴 atme.enabledGroups 过滤，空=全部群，私聊始终启用
    applyGroupGate(this)
  }

  async accept (e) {
    if (!e.isGroup || !e.user_id) return
    if (!isEnabledGroup(e)) return

    const userId = String(e.user_id)
    const groupId = String(e.group_id)
    const c = cfg()

    // Bot 自己发的消息不处理（不能用全局 Bot.uin 兜底：TRSS 下它是全体 bot 的集合）
    const selfId = String(e.self_id || e.bot?.uin || '')
    if (userId === selfId) return

    // 5 秒内同一用户只处理一次
    if (isLocked(groupId, userId)) return
    setLock(groupId, userId)

    try {
      if (!(await getGroupRemindEnabled(groupId))) return
      if (!(await getUserRemindEnabled(groupId, userId))) return

      if (!(await checkDBHealth())) {
        try { await Store.initDB() } catch (err) {
          logger.error(`[Atme-Plugin] 重新连接存储失败: ${err.message}`)
          return
        }
      }

      // 刚被艾特时 unread 可能还没写完，稍等片刻
      const triggerAt = await Store.getTriggerAt(groupId, userId)
      if (triggerAt != null && Math.floor(Date.now() / 1000) - triggerAt < c.SILENT_SECONDS + 5) {
        await new Promise(r => setTimeout(r, 500))
      }

      const expireTimestamp = Math.floor(Date.now() / 1000) - c.EXPIRE_HOURS * 3600
      const unread = await Store.getUnreadRecords(groupId, userId, expireTimestamp, c.MAX_REMIND_COUNT)
      if (!unread.length) return

      // ---- 静默期：刚被艾特就冒泡，说明他还在场，不打扰 ----
      const lastAtTime = Math.max(...unread.map(r => r.time))
      const silentElapsed = Math.floor(Date.now() / 1000) - lastAtTime
      if (silentElapsed < c.SILENT_SECONDS) {
        if (c.DEBUG) logger.mark(`[Atme-Plugin] ${userId} 在静默期内发言（${silentElapsed}/${c.SILENT_SECONDS}秒）`)
        await Store.clearUnread(groupId, userId)
        await Store.updateCooldown(groupId, userId)
        await Store.clearAtTriggerTime(groupId, userId)
        return
      }

      // ---- 冷却期：提醒太频繁会被嫌烦 ----
      if (await isInCooldown(groupId, userId)) {
        if (c.DEBUG) logger.mark(`[Atme-Plugin] ${userId} 在冷却中，跳过`)
        return
      }

      const firstTime = !(await hasRemindedBefore(groupId, userId))

      let groupName = e.group_name || e.group?.name || '群聊'
      let memberCount = 0
      try {
        const gm = await getMemberMap(e)
        memberCount = gm.size || 0
      } catch { /* 拿不到就不显示人数 */ }

      // ⚠️ 先"占住"这批未读，再出图发送。
      //
      // 顺序很重要：出图 + 发图是**浮动耗时**的（几百毫秒到几秒），
      // 如果在发送成功之后才清未读，这段窗口里用户再发一条消息，
      // accept() 就会读到同一批未读 → 又提醒一遍（实测踩到：同一条提醒发了两次、图也两张）。
      //
      // 现在的策略是"先清后发"：一旦判定该提醒，就立刻把这批未读处理掉
      // （按配置要么清空、要么标记已提醒），后面出图失败也只是少发一次提醒，
      // 不会重复打扰。两条消息几乎同时到达时，第二条会看到空未读直接退出。
      const remindedIds = unread.map(r => r.unique_id)
      await Store.updateCooldown(groupId, userId)
      if (c.AUTO_CLEAR_AFTER_SEND) {
        await Store.clearUnread(groupId, userId)
      } else {
        // 保留记录但标记已提醒，否则冷却期一过会重复提醒同一批艾特
        await Store.markReminded(groupId, userId, remindedIds)
      }
      await Store.clearAtTriggerTime(groupId, userId)

      const buffs = await renderReminderImage(e, unread, userId, groupName, memberCount)
      if (!buffs.length) return

      // ---- 发送：先 @ 一句提示，再发图（多张走合并转发） ----
      const seg = getSegmentFactory(e)
      const countText = `你不在的时候有 ${unread.length} 条艾特记录`
      // 第一次提醒时附上关闭方式，之后再提醒就不啰嗦了
      const tipText = firstTime
        ? `\n${countText}，不想接收就发 #关闭我的艾特提醒`
        : buffs.length > 1
          ? `\n${countText}，请查看合并消息~`
          : `\n${countText}~`

      const tipRes = await e.reply(atMessage(seg, userId, tipText))
      const tipIds = []
      if (tipRes?.message_id) tipIds.push(tipRes.message_id)

      const { uin, nickname } = botIdentity(e)
      const sendResult = await sendImages(e, buffs, { uin, nickname })
      if (sendResult.groups > 1) {
        logger.info(`[Atme-Plugin] 提醒截图 ${buffs.length} 张，已拆成 ${sendResult.groups} 条合并转发发送`)
      }

      scheduleRecall(e, [...tipIds, ...sendResult.messageIds], c.AUTO_RECALL_SECONDS)
    } catch (err) {
      logger.error('[Atme-Plugin] 发送提醒失败:', err)
    } finally {
      releaseLock(groupId, userId)
    }
  }

  // ---------- 群开关 ----------

  async onGroupRemind (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    await setGroupRemindEnabled(e.group_id, true)
    e.reply('✅ 已开启本群艾特提醒', true)
    return true
  }

  async offGroupRemind (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    await setGroupRemindEnabled(e.group_id, false)
    e.reply('❌ 已关闭本群艾特提醒', true)
    return true
  }

  async groupRemindStatus (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    const enabled = await getGroupRemindEnabled(e.group_id)
    const ctx = await getContextConfig(e.group_id)

    e.reply(
      `本群艾特提醒：${enabled ? '✅ 已开启（默认）' : '❌ 已关闭'}\n` +
      `提醒上下文：${ctx.enabled ? `✅ 已开启（前 ${ctx.beforeCount} 条 / 后 ${ctx.afterCount} 条）` : '❌ 已关闭'}\n\n` +
      `群命令（仅主人）：\n` +
      `#开启本群艾特提醒\n` +
      `#关闭本群艾特提醒\n` +
      `#开启本群提醒上下文\n` +
      `#关闭本群提醒上下文\n` +
      `#设置本群提醒上下文 前条数 后条数（0~5）`,
      true
    )
    return true
  }

  // ---------- 个人开关 ----------

  async onUserRemind (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    await setUserRemindEnabled(e.group_id, String(e.user_id), true)
    e.reply('✅ 已开启你的艾特提醒', true)
    return true
  }

  async offUserRemind (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    await setUserRemindEnabled(e.group_id, String(e.user_id), false)
    e.reply('❌ 已关闭你的艾特提醒', true)
    return true
  }

  async userRemindStatus (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    const userId = String(e.user_id)
    const groupEnabled = await getGroupRemindEnabled(e.group_id)
    const userEnabled = await getUserRemindEnabled(e.group_id, userId)

    let statusText
    if (!groupEnabled) statusText = '⚠️ 本群艾特提醒已关闭'
    else statusText = userEnabled ? '✅ 你的艾特提醒已开启（默认）' : '❌ 你的艾特提醒已关闭'

    e.reply(`${statusText}\n\n个人命令：\n#开启我的艾特提醒\n#关闭我的艾特提醒\n#我的艾特提醒状态`, true)
    return true
  }

  // ---------- 上下文 ----------

  async onContext (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    const c = await setContextConfig(e.group_id, { enabled: true })
    e.reply(
      `✅ 已开启本群提醒上下文\n提醒截图会显示艾特消息的前后消息（当前：前 ${c.beforeCount} 条 / 后 ${c.afterCount} 条）`,
      true
    )
    return true
  }

  async offContext (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)
    await setContextConfig(e.group_id, { enabled: false })
    e.reply('❌ 已关闭本群提醒上下文\n提醒截图只显示艾特消息本身', true)
    return true
  }

  async setContextCount (e) {
    if (!e.isGroup) return e.reply('只支持群聊使用', true)

    const match = String(e.msg).match(/(\d+)\s+(\d+)/)
    if (!match) {
      return e.reply('格式错误，请使用：#设置本群提醒上下文 前条数 后条数\n例如：#设置本群提醒上下文 3 2', true)
    }

    const rawBefore = parseInt(match[1], 10)
    const rawAfter = parseInt(match[2], 10)
    const c = await setContextConfig(e.group_id, { enabled: true, beforeCount: rawBefore, afterCount: rawAfter })

    const clamped = (rawBefore !== c.beforeCount) || (rawAfter !== c.afterCount)
    e.reply(
      `✅ 已设置本群提醒上下文：前 ${c.beforeCount} 条，后 ${c.afterCount} 条` +
      `${clamped ? '（已自动收敛到 0~5 范围）' : ''}`,
      true
    )
    return true
  }
}

export { atmeReminder as plugin }
