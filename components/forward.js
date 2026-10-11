// components/forward.js —— 截图发送
//
// 单张直发；多张按 FORWARD_MAX_NODES 拆成多条合并转发，避免单条消息节点过多导致失败；
// 合并转发不可用（部分适配器/协议不支持）时自动降级为逐张直发。
//
// ⚠️ 图**自己写到 `temp/atme/`**，交给宿主的是 `file://` 路径，不是 Buffer。
//
// 为什么不用 Buffer（踩过坑）：
//   宿主拿到 Buffer 时会走 lib/core/util.js 的 util.Buffer，只要 buffer 超过 size 限制
//   （OneBotv11 适配器传的是 size: 0，任何非空 buffer 都超限）就把它**落盘到
//   `temp/<随机ID>`** 并挂一个 60 秒后删除的定时器。那定时器活在进程内存里 ——
//   出图后 60 秒内重启一次就永远丢，文件永久残留（实测攒了 34 个 / 318MB）。
//   传 `file://` 时宿主会直接返回这个路径、不写它自己的 temp，问题从根上消失。
//
// 自己写的文件也**自己清**：发送后延时删除（合并转发的图是异步上传的，
// 删太早会发不出去），加定时清扫兜底。

import fs from 'fs/promises'
import { resolve } from 'node:path'
import { sendTempDir } from './paths.js'

// 单次合并转发的最大节点数（节点过多会导致消息体过大、上传超时、客户端渲染异常）
export const FORWARD_MAX_NODES = 15

// 分片之间的发送间隔，避免瞬间刷屏触发风控
const CHUNK_GAP_MS = 600

// 发送后延迟多久删除临时文件。
// 合并转发的图是异步上传的，删太早会在客户端显示成裂图。
const DELETE_DELAY_MS = 120000

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** 把 buffer 落成 temp/atme 下的临时文件，返回 file:// URL 与绝对路径 */
async function bufferToFileUrl (buf, seq) {
  await fs.mkdir(sendTempDir, { recursive: true })
  const name = `${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 8)}.jpg`
  const abs = resolve(sendTempDir, name)
  await fs.writeFile(abs, buf)
  return { url: `file:///${abs.replace(/\\/g, '/')}`, abs }
}

/** 延时删除一批临时文件 */
function scheduleDelete (paths, delayMs = DELETE_DELAY_MS) {
  if (!paths?.length) return
  const timer = setTimeout(() => {
    for (const p of paths) fs.unlink(p).catch(() => {})
  }, delayMs)
  timer.unref?.()
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
  let seq = 0

  /** 收下宿主返回的消息对象，把 message_id 统统记下来（供自动撤回） */
  const collect = (res) => {
    results.push(res)
    if (!res) return
    if (res.message_id) messageIds.push(res.message_id)
    if (Array.isArray(res.message_id)) messageIds.push(...res.message_id)
  }

  // 落盘（自己写，绕开宿主的 temp）
  const files = []
  const urls = []
  for (const buf of buffs) {
    try {
      const { url, abs } = await bufferToFileUrl(buf, seq++)
      urls.push(url)
      files.push(abs)
    } catch (err) {
      logger.error('[Atme-Plugin] 图片落盘失败，跳过这张:', err)
      urls.push(null)
    }
  }
  if (!files.length) {
    return { sent: 0, groups: 0, usedForward: false, results, messageIds }
  }

  const toMsg = (url) => ({ type: 'image', file: url })

  try {
    const usable = urls.filter(Boolean)
    if (usable.length === 1) {
      collect(await e.reply(toMsg(usable[0])))
      return { sent: 1, groups: 1, usedForward: false, results, messageIds }
    }

    const groups = []
    for (let i = 0; i < usable.length; i += maxNodes) {
      groups.push(usable.slice(i, i + maxNodes))
    }

    let usedForward = true

    for (let i = 0; i < groups.length; i++) {
      const nodes = groups[i].map(url => ({
        message: toMsg(url),
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
        for (const url of list) {
          try {
            collect(await e.reply(toMsg(url)))
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

    return { sent: usable.length, groups: groups.length, usedForward, results, messageIds }
  } finally {
    // 无论成功失败都要安排删除，否则要等兜底清扫
    scheduleDelete(files)
  }
}

export default { sendImages, FORWARD_MAX_NODES }
