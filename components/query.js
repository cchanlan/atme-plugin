// components/query.js —— 「谁艾特我」查询与渲染链
//
// 职责：查询记录（含全体艾特伪记录混入）→ 上下文展开 → 去重排序 → 分页出图 → 发送。
// 依赖红线：只依赖 components/*（record / store / render / forward）与 lib/*，不依赖 apps/*。

import * as Store from './store.js'
import * as Render from './render.js'
import { sendImages } from './forward.js'
import { getConfig, getAtRecords, cleanTempFiles, dataDir } from './record.js'
import { getMemberMap, findMember, memberName, botIdentity } from '../lib/messageAdapter.js'

const cleanMessageSegments = Render.cleanMessageSegments
const clampCtxCount = Render.clampCtxCount

/**
 * 「谁艾特我 / 谁艾特他」主查询。
 * 返回值：true = 已处理（阻止后续插件接力响应）
 */
export async function queryWhoAtme (e) {
  try {
    if (!e.isGroup) return e.reply('只支持群聊使用')

    // 目标解析：
    //   e.atBot / 「它」  → 查询被艾特的机器人本人（TRSS 下 Bot.uin 是全体 bot 集合，
    //     必须用 e.self_id；loader 对 atBot 的判据就是 i.qq == e.self_id）
    //   「我」            → 查询自己
    //   其余              → 需 @ 要查询的人
    const msg = String(e.msg || '')
    let targetQQ
    if (e.atBot || msg.includes('它')) targetQQ = String(e.self_id)
    else if (msg.includes('我')) targetQQ = String(e.user_id)
    else if (e.at) targetQQ = String(e.at)
    else return e.reply('请 @ 要查询的用户，或使用"谁艾特我"查询自己')

    // ---- 目标昵称 ----
    const gm = await getMemberMap(e)
    let targetName = targetQQ
    try {
      const hit = findMember(gm, targetQQ)
      if (hit) {
        targetName = memberName(hit, targetQQ, targetQQ)
      } else {
        const member = e.group?.pickMember?.(targetQQ)
        if (member) targetName = member.card || member.nickname || targetQQ
        else {
          const info = await e.group?.getMemberInfo?.(targetQQ).catch(() => null)
          if (info) targetName = info.card || info.nickname || targetQQ
        }
      }
    } catch (err) {
      logger.debug(`[Atme-Plugin] 获取目标成员信息失败: ${targetQQ}`, err)
    }

    // ---- 取数据 ----
    const cfg = getConfig()
    const records = await getAtRecords(e.group_id, targetQQ)

    // 全体艾特独立板块（仅开启「记录全体艾特」时展示）
    const atAllCount = Math.max(1, Math.min(50, Number(cfg.atAll?.maxCount) || 10))
    const atAllRecords = cfg.enableAtAll
      ? await Store.getRecentAtAll(e.group_id, atAllCount)
      : []

    if (!records.length && !atAllRecords.length) {
      return e.reply(`目前还没有人艾特 ${targetName}`, true)
    }

    const label = msg.includes('我') ? '你' : targetName
    e.reply(`正在翻找谁艾特过${label}，稍等一下~`, true)

    const groupName = e.group_name || e.group?.name || '群聊'
    const memberCount = gm.size || 0

    // ---- 组装消息列表 ----
    const msgListRaw = []
    const ctxConfig = cfg.context || { enabled: true, beforeCount: 1, afterCount: 1 }
    const beforeCount = clampCtxCount(ctxConfig.beforeCount)
    const afterCount = clampCtxCount(ctxConfig.afterCount)

    /** 上下文消息 → 渲染对象 */
    const contextMap = (ctx) => {
      const info = findMember(gm, ctx.User) || {}
      return {
        message: cleanMessageSegments(ctx.message) || '',
        // 上下文里的图片在录制阶段已下载成相对路径
        images: ctx.image || [],
        user_id: ctx.User,
        nickname: memberName(info, ctx.User, ctx.name),
        role: info.role || 'member',
        title: info.title || '',
        level: info.level || 1,
        avatar: Render.avatarUrl(ctx.User),
        time: ctx.time,
        isAt: false,
        sortTime: ctx.time
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
        // 这条艾特的目标：自己发的消息靠右高亮时，@ 前缀要写对人
        atTarget: targetName,
        sortTime: rec.time,
        quotedMsg: rec.quoted_msg
      }

      if (rec.is_context && ctxConfig.enabled) {
        // 注意：slice(-0) 等价于 slice(0) 会返回整个数组，条数为 0 时必须单独判空
        const beforeList = beforeCount > 0 ? (rec.before_msg || []).slice(-beforeCount) : []
        const afterList = afterCount > 0 ? (rec.after_msg || []).slice(0, afterCount) : []

        beforeList.forEach((ctx, idx) => {
          const m = contextMap(ctx)
          m.sortTime = ctx.time - 0.1 - idx * 0.01
          msgListRaw.push(m)
        })
        msgListRaw.push(mainMsg)
        afterList.forEach((ctx, idx) => {
          const m = contextMap(ctx)
          m.sortTime = ctx.time + 0.1 + idx * 0.01
          msgListRaw.push(m)
        })
      } else {
        msgListRaw.push(mainMsg)
      }
    }

    // 全体艾特伪记录：与普通记录同构，role='all' 渲染为独立「全体艾特」标签
    for (const a of atAllRecords) {
      msgListRaw.push({
        message: a.message || '',
        images: a.images || [],
        user_id: a.userId,
        nickname: a.name || String(a.userId || ''),
        role: 'all', title: '', level: 1,
        avatar: a.userId ? Render.avatarUrl(a.userId) : '',
        time: a.time,
        isAt: true,
        isAtAll: true,
        sortTime: (a.time || 0) - 0.0001,
        quotedMsg: a.quotedContent
      })
    }

    const msgList = Render.dedupeAndSort(msgListRaw)
    if (msgList.length === 0) return e.reply('没有找到有效的艾特记录')

    // ---- 出图 ----
    // selfQQ：被查询的人的消息靠右显示（气泡配色与别人一致），一眼看出哪些话是"他"说的
    const buffs = await Render.renderMessages({
      msgList,
      groupName,
      memberCount,
      selfQQ: targetQQ,
      dataDir,
      tempPrefix: 'atme',
      e
    })

    await cleanTempFiles()

    const { uin, nickname } = botIdentity(e)
    const sendResult = await sendImages(e, buffs, { uin, nickname })
    if (sendResult.groups > 1) {
      logger.info(`[Atme-Plugin] 截图 ${buffs.length} 张，已拆成 ${sendResult.groups} 条合并转发发送`)
    }

    // 图已经发出去了，这条消息到此为止，别再让后面的插件接力响应一次
    return true
  } catch (err) {
    logger.error('[Atme-Plugin] whoAtme 执行出错:', err)
    e.reply('❌ 查询艾特记录时出错，请稍后再试')
    return true
  }
}

export default { queryWhoAtme }
