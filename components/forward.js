// components/forward.js —— 截图发送
//
// 单张直发；多张按 FORWARD_MAX_NODES 拆成多条合并转发，避免单条消息节点过多导致失败；
// 合并转发不可用（部分适配器/协议不支持）时自动降级为逐张直发。
//
// ⚠️ 一律传 **Buffer**，不要自己落盘成 `file://` 路径（踩过坑）：
//
//   传 `file:///D:/...` 在 TRSS 下会被 `Bot.Buffer` 剥掉前缀得到 `/D:/...` ——
//   **Windows 上这不是合法路径**，读不到就把原始 URL 原样丢给协议端，
//   NapCat 报「路径不存在」，整条合并转发发不出去。
//
//   传 Buffer 则由宿主统一转换，而且**各框架的 size 阈值不一样**：
//     · TRSS 的 OneBotv11 传 size=10MB → 正常大小的图**保持 base64**，连临时文件都不产生
//     · JiuLi 的 OneBotv11 传 size=0   → 任何非空 buffer 都落盘成 `temp/<id>` + `file://`
//   Buffer 在两边都能走到正确分支，路径形式交给宿主决定最省心。
//
//   （JiuLi 那种落盘由宿主挂了 60 秒删除定时器，重启会丢、需要兜底清理 ——
//     见 components/record.js 的 cleanHostTempFiles。）

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

  const toMsg = (buf) => ({ type: 'image', file: buf })

  if (buffs.length === 1) {
    collect(await e.reply(toMsg(buffs[0])))
    return { sent: 1, groups: 1, usedForward: false, results, messageIds }
  }

  const groups = []
  for (let i = 0; i < buffs.length; i += maxNodes) {
    groups.push(buffs.slice(i, i + maxNodes))
  }

  let usedForward = true

  for (let i = 0; i < groups.length; i++) {
    const nodes = groups[i].map(buf => ({
      message: toMsg(buf),
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

    /** 逐张直发（合并转发不可用时的降级） */
    const sendOneByOne = async (list) => {
      usedForward = false
      for (const buf of list) {
        try {
          collect(await e.reply(toMsg(buf)))
        } catch (err) {
          logger.error('[Atme-Plugin] 图片发送失败:', err)
        }
      }
    }

    try {
      if (fwd) collect(await e.reply(fwd))
      else await sendOneByOne(groups[i])
    } catch (err) {
      logger.error('[Atme-Plugin] 合并转发发送失败，改为逐张:', err)
      await sendOneByOne(groups[i])
    }

    if (i < groups.length - 1 && gapMs > 0) await sleep(gapMs)
  }

  return { sent: buffs.length, groups: groups.length, usedForward, results, messageIds }
}

export default { sendImages, FORWARD_MAX_NODES }
