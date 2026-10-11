// components/forward.js —— 截图发送
//
// 单张直发；多张按 FORWARD_MAX_NODES 拆成多条合并转发，避免单条消息节点过多导致失败；
// 合并转发不可用（部分适配器/协议不支持）时自动降级为逐张直发。
//
// ⚠️ 一律传 Buffer 而不是本地路径：
//    宿主把本地路径转成 file:// 或 base64 的行为各框架不同，
//    而 Buffer 走的是"统一转 base64"这条最通用的路，
//    机器人本体和协议端不在同一台机器时也不会因为读不到路径而发空图。


// 单次合并转发的最大节点数（节点过多会导致消息体过大、上传超时、客户端渲染异常）
export const FORWARD_MAX_NODES = 15

// 分片之间的发送间隔，避免瞬间刷屏触发风控
const CHUNK_GAP_MS = 600

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * 发送多张截图。
 * @param {Object} e 消息事件
 * @param {Buffer[]} buffs 图片 buffer 数组
 * @param {Object} opts { maxNodes, gapMs, nickname, uin }
 * @returns {Promise<{sent:number, groups:number, usedForward:boolean, results:Array, messageIds:Array}>}
 */
export async function sendImages (e, buffs, opts = {}) {
  if (!buffs || buffs.length === 0) {
    return { sent: 0, groups: 0, usedForward: false, results: [], messageIds: [] }
  }

  const maxNodes = opts.maxNodes || FORWARD_MAX_NODES
  const gapMs = opts.gapMs ?? CHUNK_GAP_MS
  const results = []
  const messageIds = []

  /** 收下宿主返回的消息对象，把 message_id 统统记下来（供自动撤回） */
  const collect = (res) => {
    results.push(res)
    if (!res) return
    if (res.message_id) messageIds.push(res.message_id)
    if (Array.isArray(res.message_id)) messageIds.push(...res.message_id)
  }

  if (buffs.length === 1) {
    collect(await e.reply({ type: 'image', file: buffs[0] }))
    return { sent: 1, groups: 1, usedForward: false, results, messageIds }
  }

  const groups = []
  for (let i = 0; i < buffs.length; i += maxNodes) {
    groups.push(buffs.slice(i, i + maxNodes))
  }

  let usedForward = true

  for (let i = 0; i < groups.length; i++) {
    const nodes = groups[i].map(buf => ({
      message: { type: 'image', file: buf },
      nickname: opts.nickname || 'Bot',
      user_id: opts.uin || ''
    }))

    let fwd = null
    try {
      // 群聊走群接口；私聊（没有 e.group）走宿主通用实现
      if (e.group?.makeForwardMsg) fwd = await e.group.makeForwardMsg(nodes)
      else if (typeof Bot !== 'undefined' && Bot.makeForwardMsg) fwd = await Bot.makeForwardMsg(nodes)
    } catch (err) {
      logger.debug('[Atme-Plugin] 构建合并转发失败', err)
    }

    try {
      if (fwd) {
        collect(await e.reply(fwd))
      } else {
        // 降级：逐张直发
        usedForward = false
        for (const buf of groups[i]) {
          try {
            collect(await e.reply({ type: 'image', file: buf }))
          } catch (err) {
            logger.error('[Atme-Plugin] 图片发送失败:', err)
          }
        }
      }
    } catch (err) {
      logger.error('[Atme-Plugin] 合并转发发送失败:', err)
      // 合并转发发不出去时也退回逐张，别让这批图直接丢掉
      usedForward = false
      for (const buf of groups[i]) {
        try {
          collect(await e.reply({ type: 'image', file: buf }))
        } catch (err2) {
          logger.error('[Atme-Plugin] 图片发送失败:', err2)
        }
      }
    }

    if (i < groups.length - 1 && gapMs > 0) await sleep(gapMs)
  }

  return { sent: buffs.length, groups: groups.length, usedForward, results, messageIds }
}

export default { sendImages, FORWARD_MAX_NODES }
