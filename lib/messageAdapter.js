// lib/messageAdapter.js —— 消息段适配层（ncqq / icqq / 其它云崽衍生框架）
//
// 各框架把同一条消息交给插件时，段的形态并不一样，这里集中收口：
//
//   形态 A（OneBotv11 / NapCat / ncqq，标准云崽）
//     段是 { type:'image', data:{ url:'...' } }
//   —— 但 JiuLi 的 OneBotv11 适配器 parseMsg() 会把 data 平铺，变成 { type:'image', url:'...' }
//
//   形态 B（icqq / oicq）
//     段是 { type:'image', file:'...', url:'...' }
//
//   形态 C（老式字符串段）
//     '纯文本' 或 CQ 码字符串
//
// 所以凡是要读段的地方，一律走这里的 readType / readField，
// 不要在业务代码里写 seg.data?.xxx —— 那样换框架就静默拿到 undefined。
//
// ⚠️ 「@全体成员」也在这里收口：
//    OneBotv11 的 @全体 是 { type:'at', data:{ qq:'all' } }，
//    而 Yunzai 系的 loader 只把 i.qq == self_id 记成 atBot、其余记进 e.at，
//    **不会设置 e.atall**（JiuLi 内核 loader.js 实测如此）。
//    旧代码全程只看 e.atall，所以「全体艾特」功能在原平台上从未生效过。
//    这里改成：框架有 e.atall 就用，没有就自己扫段，两条路都通。

// ---------- 段读取 ----------

/** 段类型 */
export function readType (seg) {
  if (seg == null) return ''
  if (typeof seg === 'string') return 'text'
  return String(seg.type || '')
}

/** 段的数据本体：兼容「平铺」与「data 包装」两种形态 */
export function readData (seg) {
  if (seg == null || typeof seg !== 'object') return {}
  return seg.data && typeof seg.data === 'object' ? seg.data : seg
}

/** 读段上的某个字段，平铺 / data 包装都能取到 */
export function readField (seg, key) {
  if (seg == null || typeof seg !== 'object') return undefined
  if (seg[key] !== undefined) return seg[key]
  if (seg.data && typeof seg.data === 'object') return seg.data[key]
  return undefined
}

/** 段的纯文本（只有 text 段有） */
export function readText (seg) {
  if (typeof seg === 'string') return seg
  const t = readField(seg, 'text')
  return typeof t === 'string' ? t : ''
}

/** 段的图片 URL：url 字段优先，icqq 有时只给 file */
export function readImageUrl (seg) {
  const url = readField(seg, 'url')
  if (typeof url === 'string' && url) return url
  const file = readField(seg, 'file')
  if (typeof file === 'string' && /^https?:/i.test(file)) return file
  return null
}

/** 消息对象（e.message / reply.message）统一成数组 */
export function toSegmentArray (message) {
  if (message == null) return []
  if (Array.isArray(message)) return message
  if (typeof message === 'string') return [{ type: 'text', text: message }]
  if (typeof message === 'object') {
    // icqq 的 { msg: [...] } 包装
    if (Array.isArray(message.msg)) return message.msg
    return [message]
  }
  return []
}

// ---------- 从事件里取各类内容 ----------

const AT_ALL_VALUES = new Set(['all', 'everyone', '全体成员'])

/**
 * 取出本条消息里的 @ 目标。
 *
 * @returns {{targets: string[], atAll: boolean, atBot: boolean}}
 *   targets —— 被 @ 的普通成员 QQ（去重、字符串）
 *   atAll   —— 是否 @全体成员
 *   atBot   —— 是否 @了机器人自己
 */
export function extractAt (e) {
  const targets = []
  let atAll = false
  let atBot = false

  // 框架若已给出字段，先用上。
  // ⚠️ ICQQ 的 parser 会设 atall=1 / atme=1（数字），而 OneBotv11 两者都不设
  //    —— 所以下面扫消息段那一步才是主力，这里只是有就顺手用。
  if (e?.atall) atAll = true
  if (e?.atBot || e?.atme) atBot = true

  for (const seg of toSegmentArray(e?.message)) {
    if (readType(seg) !== 'at') continue
    const qq = readField(seg, 'qq')
    if (qq == null) continue
    const s = String(qq)
    if (!s || s === 'undefined') continue
    // ⚠️ qq=0 是 ICQQ parser 的占位值：@ 元素存在但没解出 QQ（见 Model/parser.js
    //    的 `i = {type:'at', qq:0, text:s}`）。当目标记下来会存进一条 target_qq='0'
    //    的垃圾记录，谁查都查不到，还白占配额。
    if (s === '0') continue
    if (AT_ALL_VALUES.has(s)) { atAll = true; continue }
    // 机器人自己被 @ 不算"被艾特的目标"，但要把 atBot 记下来
    if (String(e?.self_id) === s) { atBot = true; continue }
    targets.push(s)
  }

  // 段里没扫到，但框架给了单值 e.at（TRSS 系对 @全体 也可能塞 'all' 进来）
  if (targets.length === 0 && e?.at != null) {
    const s = String(e.at)
    if (AT_ALL_VALUES.has(s)) atAll = true
    else if (s && s !== 'undefined') targets.push(s)
  }

  return { targets: [...new Set(targets)], atAll, atBot }
}

/** 本条消息里的图片 URL */
export function extractImages (e) {
  const urls = []
  for (const seg of toSegmentArray(e?.message)) {
    if (readType(seg) !== 'image') continue
    const url = readImageUrl(seg)
    if (url) urls.push(url)
  }
  return urls
}

/** 本条消息里的表情（face）ID */
export function extractFaces (e) {
  const ids = []
  for (const seg of toSegmentArray(e?.message)) {
    if (readType(seg) !== 'face') continue
    const id = readField(seg, 'id')
    if (id != null) ids.push(String(id))
  }
  return ids
}

/**
 * 取本条消息引用的那条消息。
 *
 * 两条路：
 *   1. e.source —— icqq 类框架同步挂在事件上
 *   2. e.getReply() —— 云崽通用异步接口（JiuLi 的 loader 有 reply 段时注入）
 *
 * 返回统一结构：{ text, images, sender, senderId, messageId } 或 null
 */
export async function extractQuoted (e) {
  let raw = null

  if (e?.source && (e.source.message || e.source.msg)) {
    raw = e.source
  } else if (typeof e?.getReply === 'function') {
    try {
      raw = await e.getReply()
    } catch (err) {
      logger.debug(`[Atme-Plugin] 获取引用消息失败: ${err.message}`)
    }
  }
  if (!raw) return null

  const segs = toSegmentArray(raw.message ?? raw.msg)
  const textParts = []
  const images = []
  for (const seg of segs) {
    const type = readType(seg)
    if (type === 'text') {
      const t = readText(seg)
      if (t) textParts.push(t)
    } else if (type === 'image') {
      const url = readImageUrl(seg)
      if (url) images.push(url)
    } else if (type === 'xml' || type === 'json') {
      // 卡片消息（分享 / 小程序）：取个短摘要就够了，别把整包 JSON 塞进记录
      const brief = briefCard(seg)
      if (brief) textParts.push(brief)
    }
  }

  const text = textParts.join('').trim()
  if (!text && images.length === 0) return null

  return {
    text,
    images,
    sender: String(
      raw.sender?.card || raw.sender?.nickname || raw.nickname || raw.user_name || ''
    ),
    senderId: raw.sender?.user_id ?? raw.user_id ?? '',
    messageId: raw.message_id ?? raw.messageId ?? ''
  }
}

/** 卡片消息摘要：优先标题字段，其次截断原文 */
function briefCard (seg) {
  const data = readField(seg, 'data') ?? readField(seg, 'text')
  if (typeof data !== 'string' || !data) return ''
  // XML 卡片：抓 <title> 里的内容
  const m = /<title[^>]*>([\s\S]{0,80}?)<\/title>/i.exec(data)
  if (m) return `[卡片] ${m[1].trim()}`
  // JSON 卡片
  try {
    const obj = JSON.parse(data)
    const title = obj?.meta?.detail_1?.title || obj?.prompt || obj?.meta?.news?.title
    if (title) return `[卡片] ${String(title).slice(0, 60)}`
  } catch { /* 不是 JSON */ }
  return '[卡片消息]'
}

// ---------- 发送 ----------

/**
 * 取 segment 工厂。
 *
 * 顺序：宿主注入的全局 → 事件自带的 → 手搓结构。
 * 最后那层保证「一个都没有」时也能发出纯文本 + at + image，
 * 结构就是云崽通用的段格式，OneBotv11 适配器的 makeMsg 认得。
 *
 * 注：这里**不**去 require('icqq') —— 插件跑在宿主的 ESM 环境里，
 * 模块解析路径由宿主决定，硬 require 既不可靠也没必要：
 * 宿主本身就会把 icqq 的元素补进 globalThis.segment（见内核 extendSegment）。
 */
export function getSegmentFactory (e) {
  if (globalThis.segment?.image) return globalThis.segment
  if (e?.segment?.image) return e.segment
  return {
    at: (qq, name) => ({ type: 'at', qq: String(qq), ...(name ? { name } : {}) }),
    image: (file, name) => ({ type: 'image', file, ...(name ? { name } : {}) }),
    text: (text) => ({ type: 'text', text }),
    face: (id) => ({ type: 'face', id })
  }
}

/** 构造一条 @某人 + 文本 的消息 */
export function atMessage (seg, qq, text = '') {
  const out = []
  if (seg?.at) out.push(seg.at(String(qq)))
  else out.push({ type: 'at', qq: String(qq) })
  if (text) {
    if (seg?.text) out.push(seg.text(text))
    else out.push({ type: 'text', text })
  }
  return out
}

/** 构造单张图片消息 */
export function imageMessage (seg, file) {
  if (seg?.image) return seg.image(file)
  return { type: 'image', file }
}

// ---------- 机器人身份 ----------

/**
 * 取机器人自身身份。
 * ⚠️ 一律以 e.self_id 为准：TRSS 下全局 Bot.uin 是全体 bot 的集合对象，
 *    Number(集合) 会得到 NaN。
 */
export function botIdentity (e) {
  const uin = Number(e?.self_id || e?.bot?.uin || 0)
  const nickname =
    (typeof Bot !== 'undefined' && Bot.nickname) ||
    e?.bot?.nickname ||
    String(uin || 'Bot')
  return { uin, nickname }
}

// ---------- 群成员信息 ----------

/**
 * 取群成员表（Map），失败给空 Map。
 * 各框架都是 e.group.getMemberMap()，但没有时不要炸。
 */
export async function getMemberMap (e) {
  try {
    const gm = await e?.group?.getMemberMap?.()
    if (gm instanceof Map) return gm
  } catch (err) {
    logger.debug(`[Atme-Plugin] 获取群成员表失败: ${err.message}`)
  }
  return new Map()
}

/** Map 里按数字/字符串两种 key 找成员 */
export function findMember (gm, qq) {
  if (!gm || !gm.size) return null
  return gm.get(Number(qq)) || gm.get(String(qq)) || null
}

/** 取成员昵称：群名片优先，其次群昵称，最后回落 QQ 号 */
export function memberName (member, qq, fallback = '') {
  return member?.card || member?.nickname || fallback || String(qq)
}

export default {
  readType, readData, readField, readText, readImageUrl, toSegmentArray,
  extractAt, extractImages, extractFaces, extractQuoted,
  getSegmentFactory, atMessage, imageMessage,
  botIdentity, getMemberMap, findMember, memberName
}
