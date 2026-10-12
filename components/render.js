/**
 * 出图渲染层
 * ---------------------------------------------------------------
 * 「谁艾特我」（apps/atme.js）和「艾特被动提醒」（apps/atme_reminder.js）共用这一份：
 *   - 文本 / 数值 / 路径工具
 *   - 单条消息的 HTML（QQ 风格左右分栏气泡、图片、引用、上下文标签）
 *   - 消息列表去重与排序
 *   - 整页骨架（真实手机外观：状态栏 + 群名栏 + 聊天区 + 底部导航）
 *   - puppeteer 出图循环（分页 → 临时 HTML → 截图 → 清理 → 释放浏览器）
 *
 * 版式照手机 QQ 群聊界面来：
 *   顶部是状态栏（时间 / 信号 / 电量），下面是群名导航栏，
 *   别人的消息靠左（浅色气泡），**被查询/被提醒的那个人自己发的消息靠右**（蓝粉渐变气泡），
 *   底部是输入栏，最下面再加一条手机的系统手势条。
 *
 * 主题色：**浅蓝 → 浅紫 → 浅粉**，整体比初版淡一档。
 */

import fs from 'fs/promises'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pup from '../lib/puppeteer_local.js'
import { resourcesDir, uiIconDir } from './paths.js'
import { getImgType } from './imageType.js'
import { backgroundStyle, minHeightPx } from './background.js'

const iconDir = resolve(resourcesDir, 'icon')

/** 每页最多几条消息 */
export const CHUNK_SIZE = 10

/** 主题色（浅蓝 → 浅紫 → 浅粉） */
export const THEME = {
  blue: '#7cb2ff',
  violet: '#bda6ff',
  pink: '#ffa8d4',
  grad: 'linear-gradient(135deg, #7cb2ff 0%, #bda6ff 52%, #ffa8d4 100%)',
  gradSoft: 'linear-gradient(135deg, rgba(124,178,255,.12) 0%, rgba(189,166,255,.10) 50%, rgba(255,168,212,.12) 100%)'
}

// ---------- 文本 / 数值工具 ----------

/**
 * 清理消息里的内部标记
 * 移除 video:...、{image:...}、{at:...} 等内部标记，保留 @昵称 显示文本
 */
export function cleanMessageSegments (message) {
  if (!message || typeof message !== 'string') return ''
  return message
    .replace(/\{?video:[^}]+\}?/g, '')
    .replace(/\{?image:[^}]+\}?/g, '')
    .replace(/\{at:\d+\}/g, '')
    .replace(/\{face:[^}]+\}/g, '')
    .replace(/\{reply:[^}]+\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * HTML 转义。
 *
 * 除了常规的 `&<>"'`，还**必须转义 `{`**（转成 `&#123;`）：
 * 出图有个降级路径会把整页 HTML 交给宿主的渲染服务，而宿主那套会用
 * **art-template** 再过一遍（`lib/core/render/Renderer.js` 的 `dealTpl`）。
 * art-template 认 `{{ }}` 和 `<%% %>` 做表达式求值 —— 昵称里只要出现 `{{`，
 * 轻则渲染报错，重则被当模板执行。`<` 本来就被转掉了，`{` 补上就堵死了。
 *
 * `&#123;` 在 HTML 里显示出来就是 `{`，正文和属性值都正常还原，不影响观感。
 */
export function escapeHtml (str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/[&<>"'{]/g, (m) => {
    if (m === '&') return '&amp;'
    if (m === '<') return '&lt;'
    if (m === '>') return '&gt;'
    if (m === '"') return '&quot;'
    if (m === '{') return '&#123;'
    return '&#39;'
  })
}

export function formatBytes (bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 上下文条数收敛到 0~5 */
export function clampCtxCount (n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(5, Math.floor(v)))
}

/** 秒级时间戳 → YYYY-MM-DD HH:mm:ss（不引 moment，省一层依赖） */
export function formatTime (sec) {
  const d = new Date((Number(sec) || 0) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 秒级时间戳 → HH:mm */
export function formatClock (sec) {
  const d = sec === undefined ? new Date() : new Date((Number(sec) || 0) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------- 资源路径 ----------

export function getIconUrl (iconName) {
  const iconPath = resolve(iconDir, `${iconName}.svg`)
  return `file:///${iconPath.replace(/\\/g, '/')}`
}

export function avatarUrl (qq) {
  return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`
}

/** 本地相对路径（images/xxx.webp）转 file:// 绝对 URL；已是 URL 的原样返回 */
export function toImgSrc (img, dataDir) {
  if (img && typeof img === 'string' && img.startsWith('images/')) {
    const absPath = resolve(dataDir, img)
    return `file:///${absPath.replace(/\\/g, '/')}`
  }
  return img
}

// ---------- 消息片段 ----------

/**
 * 角色标签（群主 / 管理员 / 群头衔 / 全体艾特）。
 * 返回空串表示不显示标签。
 */
export function roleTagHtml (role, title, level) {
  // 全体艾特（独立板块）：不受群头衔影响，固定用主题渐变
  if (role === 'all') {
    return `<span class="tag tag-all">全体艾特</span>`
  }

  let cls = 'tag-member'
  let roleText = '群员'
  if (role === 'owner') { cls = 'tag-owner'; roleText = '群主' }
  else if (role === 'admin') { cls = 'tag-admin'; roleText = '管理员' }

  // 有自定义头衔时以头衔为正文（群主/管理员仍保留其配色）
  if (title) {
    roleText = escapeHtml(title)
    if (role !== 'owner' && role !== 'admin') cls = 'tag-title'
  }

  const lv = Number(level) > 0 ? `LV${Number(level)}` : ''
  return `<span class="tag ${cls}">${lv ? `${lv} ` : ''}${roleText}</span>`
}

/** 气泡内的图片 */
export function imagesHtml (images, dataDir, fallbackIconUrl) {
  let html = ''
  for (const img of (images || [])) {
    const imgSrc = toImgSrc(img, dataDir)
    html += `<img src="${escapeHtml(imgSrc)}" class="msg-img" onerror="this.onerror=null;this.src='${fallbackIconUrl}'" />`
  }
  return html
}

/** 引用消息块（画在气泡内顶部） */
export function quotedHtml (quotedMsg, dataDir, fallbackIconUrl) {
  if (!quotedMsg) return ''
  const text = cleanMessageSegments(quotedMsg.text || '')
  const images = Array.isArray(quotedMsg.images) ? quotedMsg.images : []
  if (!text && !images.length) return ''

  let imgs = ''
  for (const img of images) {
    const src = toImgSrc(img, dataDir)
    imgs += `<img src="${escapeHtml(src)}" class="quoted-img" onerror="this.onerror=null;this.src='${fallbackIconUrl}'" />`
  }

  const sender = quotedMsg.sender ? `<span class="quoted-who">${escapeHtml(quotedMsg.sender)}</span>` : ''
  const body = text ? `<div class="quoted-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>` : ''

  return `<div class="quoted">${sender}${body}${imgs}</div>`
}

// ---------- 列表处理 ----------

/**
 * 去重 + 按 sortTime 排序。
 * 上下文消息会被多条艾特记录重复引用（同一条上下文出现在 A 的下文、B 的上文），
 * 必须按「用户+时间+内容」去重，否则同一句话会渲染两遍。
 * isAt 的消息永远保留（那是主体，不是上下文）。
 */
export function dedupeAndSort (msgListRaw, { distinguishContext = false } = {}) {
  const unique = new Map()
  for (const m of msgListRaw) {
    // distinguishContext=true 时把 sortTime 也算进 key：上文/下文可能取自同一条消息
    // （同一时间、同一内容），但一个在主消息前一个在主消息后，都要保留。
    // isAtAll 进 key：同一人同一秒既 @我 又 @全体 时，两条记录是不同板块的消息，不能互相去重掉
    const key = distinguishContext
      ? `${m.user_id}_${m.time}_${m.isAt ? '1' : '0'}_${m.sortTime.toFixed(3)}_${m.isAtAll ? 1 : 0}`
      : `${m.user_id}_${m.time}_${m.message}_${(m.images || []).join(',')}_${m.isAt}_${m.isAtAll ? 1 : 0}`
    if (!unique.has(key) || m.isAt) unique.set(key, m)
  }
  const list = Array.from(unique.values())
  list.sort((a, b) => a.sortTime - b.sortTime)
  return list
}

/** 按 CHUNK_SIZE 切成若干页 */
export function chunkMessages (msgList, chunkSize = CHUNK_SIZE) {
  const chunks = []
  for (let i = 0; i < msgList.length; i += chunkSize) chunks.push(msgList.slice(i, i + chunkSize))
  return chunks
}

// ---------- 单条消息 HTML ----------

/**
 * 渲染一条消息（手机 QQ 风格）。
 * @param {Object} m 消息对象
 * @param {Object} o  { dataDir, fallbackIconUrl, selfQQ, showName }
 */
export function messageHtml (m, { dataDir, fallbackIconUrl, selfQQ = null, showName = true } = {}) {
  const isSelf = selfQQ != null && String(m.user_id) === String(selfQQ)

  const tagHtml = roleTagHtml(m.role, m.title, m.level)
  const mediaHtml = imagesHtml(m.images, dataDir, fallbackIconUrl)
  const quoted = quotedHtml(m.quotedMsg, dataDir, fallbackIconUrl)
  const safeText = escapeHtml(cleanMessageSegments(m.message)).replace(/\n/g, '<br>')

  // @ 目标的高亮前缀：被艾特的那条消息开头补一个 @某某
  const atPrefix = m.isAt && m.atTarget
    ? `<span class="at-text">@${escapeHtml(m.atTarget)}</span> `
    : ''

  const textHtml = (safeText || atPrefix)
    ? `<div class="bubble-text">${atPrefix}${safeText}</div>`
    : ''

  const body = `${quoted}${textHtml}${mediaHtml}`
  if (!body) return ''

  // 上下文标签（提醒图才有）
  let ctxLabel = ''
  if (!m.isAt && m.contextType === 'before') ctxLabel = '<span class="ctx-tag">上文</span>'
  else if (!m.isAt && m.contextType === 'after') ctxLabel = '<span class="ctx-tag">下文</span>'

  const nameHtml = `<div class="who${isSelf ? ' who-self' : ''}">${tagHtml}${ctxLabel}${
    showName ? `<span class="name">${escapeHtml(m.nickname)}</span>` : ''
  }<span class="time">${escapeHtml(formatTime(m.time))}</span></div>`

  // 头像：没给 URL 时直接上占位图。
  // ⚠️ 不能留 src="" —— 空 src 在浏览器里不会触发 onerror，会渲染成破图
  const avatarSrc = m.avatar ? escapeHtml(m.avatar) : fallbackIconUrl
  const avatar = `<img class="avatar${m.isAt ? '' : ' dim'}" src="${avatarSrc}" onerror="this.onerror=null;this.src='${fallbackIconUrl}'" />`

  const cls = [
    'msg',
    isSelf ? 'self' : 'other',
    m.isAt ? 'is-at' : 'ctx',
    m.isAtAll ? 'is-all' : ''
  ].filter(Boolean).join(' ')

  // 自己的消息：气泡靠右（头像在右）；别人的靠左
  const col = `<div class="col">${nameHtml}<div class="bubble">${body}</div></div>`

  return `
    <div class="${cls}">
      ${isSelf ? `${col}${avatar}` : `${avatar}${col}`}
    </div>
  `
}

/** 一组消息 → HTML */
export function messagesHtml (msgList, opts) {
  return msgList.map(m => messageHtml(m, opts)).join('')
}

// ---------- 页面骨架 ----------

/**
 * UI 图标：直接从参考截图里抠出来的真图标（resources/images/ui/），
 * 比手画 SVG 像得多。缺失时返回空串，调用方自行降级。
 */
function uiIcon (name) {
  const p = resolve(uiIconDir, `${name}.png`)
  try {
    if (!statSync(p).isFile()) return ''
  } catch {
    return ''
  }
  return `file:///${p.replace(/\\/g, '/')}`
}

/**
 * 组装一页完整 HTML。
 * @param {Object} o
 * @param {string} o.msgsHtml   消息列表 HTML
 * @param {string} o.groupName  群名
 * @param {number} o.memberCount 群人数
 * @param {number} o.pageIndex  当前页下标（从 0 开始）
 * @param {number} o.totalPages 总页数
 * @param {string} [o.bannerHtml] 顶部横幅（提醒用，查询时留空）
 * @param {string} [o.extraCss]  附加样式
 * @param {string} [o.timeStr]   状态栏时间，默认当前 HH:mm
 */
export function buildPageHtml ({
  msgsHtml,
  groupName,
  memberCount,
  pageIndex,
  totalPages,
  bannerHtml = '',
  extraCss = '',
  timeStr = null,
  viewportWidth = 600
}) {
  const clock = timeStr || formatClock()
  const count = Number(memberCount) > 0 ? `(${memberCount})` : ''

  // 自定义聊天背景：图铺在 .phone 上，聊天区盖一层白色遮罩保证文字清楚。
  // 铺背景时额外把手机撑成「屏幕比例」—— 否则消息少时容器很宽，
  // cover 会疯狂放大把人物裁掉（详见 background.js 的说明）。
  const bgStyle = backgroundStyle()
  const minH = minHeightPx(viewportWidth)
  const phoneStyle = bgStyle + (minH ? `min-height:${minH}px;` : '')

  const img = (n) => {
    const u = uiIcon(n)
    return u ? `<img class="ui-ic" src="${u}" alt="" />` : ''
  }
  // 状态栏：左边 时间+闹钟+投屏，右边 5G+信号+WiFi+电量（全部来自参考图）
  // 状态栏素材整组从参考截图抠的（音乐+时钟 / 灵动岛 / 5G+WiFi+电量）
  const sbLeft = img('st-icons-left')
  const sbIsland = img('st-island')
  const sbRight = img('st-icons-right')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${PAGE_CSS}${extraCss}</style></head>
<body>
<div class="phone${bgStyle ? ' has-bg' : ''}" id="container"${phoneStyle ? ` style="${phoneStyle}"` : ''}>
  <!-- 状态栏（中间是灵动岛） -->
  <div class="statusbar">
    <span class="sb-left"><span class="sb-time">${escapeHtml(clock)}</span>${sbLeft}</span>
    <span class="sb-island">${sbIsland}</span>
    <span class="sb-icons">${sbRight}</span>
  </div>

  <!-- 群名导航栏 -->
  <div class="nav">
    <div class="nav-side"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></div>
    <div class="nav-title">${escapeHtml(groupName)}${count}</div>
    <div class="nav-side nav-right">
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </div>
  </div>

  ${bannerHtml}
  <div class="chat">${msgsHtml}</div>
  <div class="foot">${totalPages > 1 ? `<div class="pager">— 第 ${pageIndex + 1} / ${totalPages} 页 —</div>` : ''}</div>

  <!-- 底部输入栏 -->
  <div class="inputbar">
    <div class="ib-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3"/></svg></div>
    <div class="ib-input">说点什么…</div>
    <div class="ib-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg></div>
    <div class="ib-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div>
  </div>
  <!-- 系统手势条 -->
  <div class="homebar"><span></span></div>
</div>
</body>
</html>`
}

const PAGE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#eef1f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei","Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .phone{width:600px;min-height:200px;background:#f7f8fc;display:flex;flex-direction:column;overflow:hidden;position:relative}
  /* 自定义背景的白色遮罩：盖住**整个手机**（含页脚、输入栏上方），
     不然那些没被 .chat 覆盖的缝隙会直接露出原图，一条生硬的色带。
     内容抬到遮罩之上；导航栏/输入栏本身是不透明的，不受影响。 */
  .phone.has-bg::before{content:'';position:absolute;inset:0;background:rgba(255,255,255,var(--veil,.72));pointer-events:none;z-index:0}
  .phone.has-bg>*{position:relative;z-index:1}

  /* ---- 状态栏 ---- */
  .statusbar{display:flex;align-items:center;justify-content:space-between;padding:9px 18px;background:#fff;color:#2a2f3d;flex:none;position:relative;min-height:66px}
  /* 灵动岛：直接贴参考截图里抠出来的真图（黑胶囊 + 专辑封面 + 声波）。
     绝对定位居中，不吃左右两侧的空间 */
  .sb-island{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);flex:none}
  .sb-island .ui-ic{height:48px;width:auto;display:block}
  .sb-left{display:flex;align-items:center;gap:9px}
  .sb-time{font-size:16px;font-weight:600;letter-spacing:.2px}
  .sb-icons{display:flex;align-items:center;gap:6px}
  .statusbar .ui-ic{width:auto;display:block}
  /* 图标都是 3x 高清图，这里按实际显示尺寸缩下来，保证锐利 */
  /* 左右两组图标是从参考截图整块抠的（白底保留 —— 白色容器本身就是图标的一部分，
     抠成透明会把音乐图标的白圆、时钟的白方块一起抹掉），所以状态栏底色统一用纯白 */
  .sb-left .ui-ic{height:28px}
  .sb-icons .ui-ic{height:33px}

  /* ---- 群名导航栏：浅蓝粉渐变 ---- */
  .nav{background:linear-gradient(135deg,#7cb2ff 0%,#bda6ff 52%,#ffa8d4 100%);color:#fff;padding:11px 14px;display:flex;align-items:center;gap:6px;flex:none}
  .nav-title{font-size:18px;font-weight:600;letter-spacing:.2px;flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nav-side{width:30px;height:30px;flex:none;display:flex;align-items:center;justify-content:center;opacity:.95}
  .nav-side svg{width:19px;height:19px}
  .nav-right{width:56px;gap:2px;display:flex}
  .nav-right svg{width:17px;height:17px}

  /* ---- 提醒横幅 ---- */
  .banner{margin:13px 16px 0;padding:10px 14px;border-radius:11px;font-size:13.5px;font-weight:600;color:#5a5080;
    background:linear-gradient(135deg,rgba(124,178,255,.14),rgba(189,166,255,.14) 52%,rgba(255,168,212,.16));
    border:1px solid rgba(189,166,255,.26);display:flex;align-items:center;gap:8px;flex:none}
  .banner .dot{width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,#7cb2ff,#ffa8d4);flex:none}

  .chat{padding:16px 16px 6px;flex:1}

  /* ---- 消息行 ---- */
  .msg{display:flex;gap:10px;align-items:flex-start;margin-top:11px}
  .msg.self{flex-direction:row;justify-content:flex-end}
  .msg .col{max-width:76%;display:flex;flex-direction:column}
  .msg.self .col{align-items:flex-end}
  .avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none;background:#e3e8f2}
  .avatar.dim{opacity:.72}
  .who{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px;color:#9099ac;max-width:100%}
  .who-self{justify-content:flex-end}
  .name{font-size:12px;color:#9099ac;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .time{font-size:11px;color:#bcc2d2;flex:none}
  /* 铺了自定义背景时：名字/时间直接压在花哨底图上会看不清，
     加深字色 + 加一圈白色描边，比一味加大遮罩有效 */
  .phone.has-bg .name{color:#5a6172}
  .phone.has-bg .time{color:#7c8394}
  .phone.has-bg .who{text-shadow:0 1px 2px rgba(255,255,255,.95),0 0 6px rgba(255,255,255,.85)}
  .phone.has-bg .pager{color:#7c8394}

  /* ---- 标签 ---- */
  .tag{display:inline-flex;align-items:center;border-radius:5px;padding:1.5px 6px;font-size:10px;font-weight:700;color:#fff;flex:none;letter-spacing:.2px}
  .tag-owner{background:linear-gradient(135deg,#f9b45f,#f79463)}
  .tag-admin{background:linear-gradient(135deg,#6ad9bb,#5fbfe0)}
  .tag-title{background:linear-gradient(135deg,#bda6ff,#ffa8d4)}
  .tag-member{background:#cbd1de}
  .tag-all{background:linear-gradient(135deg,#7cb2ff,#ffa8d4)}
  .ctx-tag{display:inline-flex;border-radius:5px;padding:1.5px 6px;font-size:10px;font-weight:700;color:#fff;background:#c2c8d6;flex:none}

  /* ---- 气泡 ---- */
  .bubble{display:inline-block;padding:10px 14px;border-radius:16px;font-size:16px;line-height:1.45;color:#252a36;
    background:#fff;box-shadow:0 1px 2px rgba(30,35,55,.05);word-wrap:break-word;overflow-wrap:anywhere;max-width:100%}
  .msg.other .bubble{border-top-left-radius:5px}
  .msg.self .bubble{background:linear-gradient(135deg,#7cb2ff 0%,#bda6ff 52%,#ffa8d4 100%);color:#fff;border-top-right-radius:5px;
    box-shadow:0 2px 8px rgba(150,155,220,.22)}
  .msg.is-at .bubble{box-shadow:0 2px 10px rgba(124,178,255,.18)}
  .msg.self.is-at .bubble{box-shadow:0 2px 12px rgba(150,155,220,.28)}
  /* 全体艾特：左侧气泡也带一层主题色描边，跟普通上下文区分开 */
  .msg.is-all .bubble{border:1.5px solid rgba(189,166,255,.42);background:linear-gradient(135deg,rgba(124,178,255,.06),rgba(255,168,212,.08))}
  .msg.self.is-all .bubble{border:none}
  .msg.ctx .bubble{font-size:15px}
  .bubble-text{word-wrap:break-word;overflow-wrap:anywhere}
  .at-text{color:#5b93ff;font-weight:600}
  .msg.self .at-text{color:#fff}

  /* ---- 引用块 ---- */
  .quoted{margin-bottom:8px;padding:7px 10px;border-radius:9px;font-size:13px;line-height:1.35;
    background:rgba(130,140,165,.09);border-left:3px solid rgba(130,140,165,.34);color:#767e94}
  .quoted-who{display:block;font-weight:700;margin-bottom:2px;color:#666e86}
  .quoted-text{word-break:break-word}
  .msg.self .quoted{background:rgba(255,255,255,.24);border-left-color:rgba(255,255,255,.7);color:rgba(255,255,255,.94)}
  .msg.self .quoted-who{color:#fff}

  /* ---- 图片 ---- */
  .msg-img{max-width:100%;border-radius:10px;margin-top:8px;display:block}
  .quoted-img{max-width:100%;border-radius:7px;margin-top:5px;display:block}

  /* ---- 页码 ---- */
  .foot{padding:8px 0 12px;flex:none}
  .pager{text-align:center;font-size:12px;color:#a2a9ba;letter-spacing:.5px}

  /* ---- 底部输入栏 ---- */
  .inputbar{display:flex;align-items:center;gap:10px;padding:8px 14px 10px;background:#fff;border-top:1px solid rgba(120,135,170,.13);flex:none}
  .ib-ic{width:26px;height:26px;flex:none;color:#8c94a8;display:flex;align-items:center;justify-content:center}
  .ib-ic svg{width:23px;height:23px}
  .ib-input{flex:1;height:34px;border-radius:17px;background:#f1f3f8;color:#a8b0c0;font-size:13.5px;display:flex;align-items:center;padding:0 15px}

  /* ---- 系统手势条 ---- */
  .homebar{background:#fff;display:flex;justify-content:center;padding:0 0 7px;flex:none}
  .homebar span{width:132px;height:4.5px;border-radius:3px;background:#20242e;opacity:.85}
`

// ---------- puppeteer 出图 ----------

/**
 * 等页面里的图片全部落定，并把加载失败的记一条日志。
 * 网络图（头像、未缓存的原图）可能很慢，每张单独给 5 秒上限，
 * 不能让一张图把整页截图拖住。
 */
async function waitImages (page) {
  const failed = await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('img'))
    const bad = []
    await Promise.all(imgs.map(img => {
      if (img.complete) {
        if (img.naturalWidth === 0 && img.src) bad.push(img.src)
        return Promise.resolve()
      }
      return new Promise((done) => {
        img.onload = () => done()
        img.onerror = () => { if (img.src) bad.push(img.src); done() }
        setTimeout(() => {
          if (img.src && !img.complete) bad.push(img.src + '(超时)')
          done()
        }, 5000)
      })
    }))
    return bad
  })

  if (failed?.length) {
    const list = failed.slice(0, 5).map(u => u.substring(0, 80) + (u.length > 80 ? '...' : ''))
    logger.warn(`[Atme-Plugin] 图片加载失败 ${failed.length} 张（可能已过期），示例: ${list.join('; ')}`)
  }
}

/**
 * 把若干页 HTML 渲染成图片 buffer 数组。
 *
 * 浏览器一律向 lib/puppeteer_local.js 借（宿主实例优先），用完 releaseBrowser()
 * 归还；每张图结束都会删掉临时 HTML 并关闭 page，不留垃圾。
 *
 * deviceScaleFactor 默认 2：等于 2 倍超采样，文字和图标在手机上才不糊
 * （1 倍出来的 600px 图，QQ 里会被放大显示，边缘发虚）。
 */
export async function renderPageBuffers ({
  pages,
  tempPrefix = 'atme',
  viewportWidth = 600,
  deviceScaleFactor = 2,
  screenshotSelector = '.phone',
  imgType = 'jpeg',
  quality = 88,
  e = null
}) {
  const buffs = []

  for (let p = 0; p < pages.length; p++) {
    buffs.push(await renderOnePage(pages[p], {
      tempPrefix, viewportWidth, deviceScaleFactor, screenshotSelector, imgType, quality
    }, e))
  }

  return buffs
}

/**
 * 渲染一页。三级策略，从「最省事、最能兼容各家配置」往下退：
 *
 *   ① `e.runtime.render` —— **框架自带的出图入口**，走宿主配好的渲染后端。
 *      这是 xhh-TL / 王者等插件通用的做法，外置渲染、远程浏览器、换别的渲染后端
 *      都由宿主自己处理，插件不用操心浏览器从哪来。
 *   ② 自己的 puppeteer 管线 —— 借宿主浏览器 / 自启动兜底。
 *      比 ① 灵活（能等图、能控 2x 超采样），所以 ① 不可用时用它。
 *   ③ 直接调宿主的渲染服务 —— ① 的底层，① 不可用但服务还在时的兜底。
 *
 * ⚠️ ③ 存在的意义：实测有用户的机器上宿主浏览器起不来
 *    （`Could not find chrome-headless-shell`），自己 launch 也因为宿主的
 *    `puppeteer-core` 从不自带浏览器而失败 —— 那种机器上只有「把活交给宿主」
 *    这条路，硬去碰浏览器一定崩。
 */
async function renderOnePage (html, opts, e) {
  try {
    const viaRuntime = await renderViaRuntime(e, html, opts)
    if (viaRuntime) return viaRuntime
  } catch (err) {
    logger.warn(`[Atme-Plugin] 宿主出图入口不可用（${err.message}），改用插件自带管线`)
  }

  try {
    return await renderWithOwnPipeline(html, opts)
  } catch (err) {
    logger.warn(`[Atme-Plugin] 插件自带管线不可用（${err.message}），改用宿主渲染服务`)
  }

  const viaHost = await renderViaHostService(html, opts)
  if (viaHost) return viaHost

  throw new Error(
    '出图失败：宿主渲染服务与插件自带管线都不可用。' +
    '请在机器人上的锅巴面板检查渲染设置，' +
    '或安装浏览器：npx puppeteer browsers install chrome'
  )
}

/**
 * ① 走框架自带的 `e.runtime.render(plugin, tpl, data, cfg)`。
 *
 * 这是各插件通用的出图入口（xhh-TL / 王者都这么走），好处是**不用自己碰浏览器**：
 * 用本地 chromium、外置渲染、远程浏览器都行，插件端代码完全一样。
 *
 * 模板用我们自己生成的整页 HTML：写到一个临时文件，再用 `beforeRender`
 * 把 `tplFile` 覆盖成它的绝对路径（xhh-TL 也这么干，用于把模板放到 resources 之外）。
 *
 * 返回 Buffer；`e.runtime.render` 不可用时返回 null（交给下一级）。
 */
async function renderViaRuntime (e, html, { tempPrefix, imgType, quality }) {
  const runtime = e?.runtime
  if (typeof runtime?.render !== 'function') return null

  const tplDir = resolve(process.cwd(), 'temp', 'atme-tpl')
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const tplFile = resolve(tplDir, `${tempPrefix}_${stamp}.html`)
  await fs.mkdir(tplDir, { recursive: true })
  await fs.writeFile(tplFile, html, 'utf-8')

  try {
    const result = await runtime.render('atme-plugin', `${tempPrefix}/${stamp}`, {}, {
      retType: 'base64',
      imgType,
      quality,
      beforeRender: ({ data }) => ({ ...data, tplFile, saveId: `atme_${stamp}` })
    })
    return extractRenderBuffer(result)
  } finally {
    try { await fs.unlink(tplFile) } catch { /* 已经没了 */ }
  }
}

/**
 * 从各家渲染入口的返回值里抠出图片 Buffer。
 * 返回形态各家不一：Buffer / base64 串 / `data:` URL / `{file}` 对象 / 本地路径。
 * （与 xhh-TL 的 extractRenderBuffer 同样的思路。）
 */
function extractRenderBuffer (result) {
  if (!result) return null
  if (Buffer.isBuffer(result)) return result
  if (Buffer.isBuffer(result.image)) return result.image
  if (Buffer.isBuffer(result.buffer)) return result.buffer

  const value = result.file ?? result
  if (Buffer.isBuffer(value)) return value
  if (typeof value !== 'string') return null

  if (value.startsWith('base64://')) return Buffer.from(value.slice(9), 'base64')
  if (value.startsWith('data:image')) {
    const comma = value.indexOf(',')
    if (comma >= 0) return Buffer.from(value.slice(comma + 1), 'base64')
  }
  // 裸 base64：够长且只含 base64 字符集
  if (value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    try { return Buffer.from(value, 'base64') } catch { /* 不是 base64 */ }
  }
  // 本地路径
  const file = value.replace(/^file:\/\//, '')
  try {
    if (existsSync(file)) return readFileSync(file)
  } catch { /* 读不到就算了 */ }
  return null
}

/** ① 自己的管线：借宿主浏览器（优先）或自启动，然后按选择器截图 */
async function renderWithOwnPipeline (html, { tempPrefix, viewportWidth, deviceScaleFactor, screenshotSelector, imgType, quality }) {
  let page = null
  let tempHtmlPath = null
  let retry = false
  do {
    retry = false
    try {
      const browser = await pup.ensureBrowser()
      if (!browser) throw new Error('拿不到浏览器实例')
      page = await browser.newPage()
      await page.setViewport({ width: viewportWidth, height: 800, deviceScaleFactor })

      const tempDirHtml = resolve(process.cwd(), 'temp', 'puppeteer')
      await fs.mkdir(tempDirHtml, { recursive: true })
      tempHtmlPath = resolve(tempDirHtml, `${tempPrefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.html`)
      await fs.writeFile(tempHtmlPath, html, 'utf-8')

      await page.goto(`file:///${tempHtmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0', timeout: 15000 })
      await waitImages(page)
      await page.evaluateHandle('document.fonts.ready')
      await new Promise(r => setTimeout(r, 250))

      const bodyHeight = await page.evaluate(() => document.body.scrollHeight)
      await page.setViewport({ width: viewportWidth, height: bodyHeight + 40, deviceScaleFactor })
      const element = await page.$(screenshotSelector)
      if (!element) throw new Error(`找不到截图目标 ${screenshotSelector}`)
      // png 不接受 quality 参数（puppeteer 会直接抛错）；jpeg 和 webp 都认，
      // 与宿主的 renderers/puppeteer 行为保持一致。
      const shotOpts = imgType === 'png' ? { type: 'png' } : { type: imgType, quality }
      return await element.screenshot(shotOpts)
    } catch (err) {
      // 宿主浏览器重启期间会拿到 "Connection closed"，重连一次再试
      if (err.message?.includes('Connection closed') && !retry) {
        logger.warn('[Atme-Plugin] 浏览器连接断开，尝试重新初始化并重试...')
        await pup.browserInit()
        retry = true
        continue
      }
      throw err
    } finally {
      if (tempHtmlPath) {
        try { await fs.unlink(tempHtmlPath) } catch (err) {
          logger.debug(`[Atme-Plugin] 清理临时HTML失败: ${err.message}`)
        }
      }
      if (page) {
        try { await page.close() } catch (err) {
          logger.debug(`[Atme-Plugin] 关闭页面失败: ${err.message}`)
        }
      }
      // 与 ensureBrowser() 配对：出图结束，宿主/自启动实例按空闲策略回收
      pup.releaseBrowser()
    }
  } while (retry)
}

/**
 * ② 交给宿主的通用渲染服务。
 *
 * 宿主那套的做法和我们的管线其实一致（`#container` 或 `body` 元素截图，
 * 见 renderers/puppeteer），所以页面里把手机容器同时挂了 `id="container"`，
 * 两边截的是同一个元素，版式不会变。
 *
 * 注意：宿主会把模板文件用 art-template 再过一遍，所以 escapeHtml 里
 * 连 `{` 一起转掉了（见该函数注释）。
 */
async function renderViaHostService (html, { tempPrefix, imgType, quality }) {
  const svc = pup.hostRenderService
  if (!svc) return null

  const tplDir = resolve(process.cwd(), 'temp', 'atme-tpl')
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const tplFile = resolve(tplDir, `${tempPrefix}_${stamp}.html`)
  try {
    await fs.mkdir(tplDir, { recursive: true })
    await fs.writeFile(tplFile, html, 'utf-8')

    // 用 render 而不是 screenshot：render 直接把后端的原始产物（Buffer）返回，
    // 不会包成 segment。
    const res = await svc.render('atme-plugin', {
      tplFile,
      saveId: `atme_${stamp}`,
      imgType,
      quality
    })
    if (Buffer.isBuffer(res)) return res
    if (Buffer.isBuffer(res?.file)) return res.file
    if (Buffer.isBuffer(res?.data)) return res.data
    logger.warn('[Atme-Plugin] 宿主渲染服务返回了非图片结果')
    return null
  } catch (err) {
    logger.warn(`[Atme-Plugin] 宿主渲染服务出图失败：${err.message}`)
    return null
  } finally {
    try { await fs.unlink(tplFile) } catch { /* 已经没了 */ }
  }
}

/**
 * 「消息列表 → 出图」的一站式入口，两个 app 都走这里。
 * @returns {Promise<Buffer[]>}
 */
/**
 * 「消息列表 → 出图」的一站式入口，两个 app 都走这里。
 *
 * 输出 PNG：JPEG 在文字/图标边缘会有可见的压缩噪点，
 * 聊天截图这种大色块+小字的图尤其明显（看着就是"糊"）。
 * PNG 大一些，但发出去的观感差很多。
 *
 * @returns {Promise<Buffer[]>}
 */
export async function renderMessages ({
  msgList,
  groupName,
  memberCount,
  selfQQ = null,
  dataDir,
  bannerHtml = '',
  tempPrefix = 'atme',
  e = null
}) {
  if (!msgList?.length) return []
  const fallbackIconUrl = getIconUrl('images')
  const chunks = chunkMessages(msgList)
  const totalPages = chunks.length

  const pages = chunks.map((chunk, p) => buildPageHtml({
    msgsHtml: messagesHtml(chunk, { dataDir, fallbackIconUrl, selfQQ }),
    groupName,
    memberCount,
    pageIndex: p,
    totalPages,
    bannerHtml,
    timeStr: formatClock()
  }))

  return renderPageBuffers({ pages, tempPrefix, imgType: getImgType(), e })
}

export default {
  CHUNK_SIZE,
  THEME,
  cleanMessageSegments,
  escapeHtml,
  formatBytes,
  clampCtxCount,
  formatTime,
  formatClock,
  getIconUrl,
  avatarUrl,
  toImgSrc,
  roleTagHtml,
  imagesHtml,
  quotedHtml,
  dedupeAndSort,
  chunkMessages,
  messageHtml,
  messagesHtml,
  buildPageHtml,
  renderPageBuffers,
  renderMessages
}
