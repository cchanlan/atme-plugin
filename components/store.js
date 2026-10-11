/**
 * atme-plugin SQLite 存储层
 * ---------------------------------------------------------------
 * 全部数据落在 data/atme/atme.db（WAL 模式），不依赖 Redis / 不依赖 Yunzai 的宿主存储。
 *
 * 表结构（9 张 + meta）：
 *   records           艾特记录主表（unique_id 主键）
 *   unread            未读提醒（按 群+人 分桶）
 *   trigger           该(群,人)最近一次被艾特的时间
 *   cooldown          该(群,人)最近一次提醒的时间
 *   atall             全体艾特（轻量，每群只留最近 N 条）
 *   group_record_ctx  记录层上下文开关（#开启/关闭艾特上下文）
 *   group_remind      群提醒开关（#开启/关闭本群艾特提醒）
 *   user_remind       个人提醒开关（#开启/关闭我的艾特提醒）
 *   group_remind_ctx  提醒上下文配置（#开启/关闭/设置本群提醒上下文）
 *   meta              杂项键值（配置合并快照等）
 *
 * ⚠️ 「记录层上下文开关」与「提醒上下文开关」是**两个独立开关**，各占一张表：
 *    前者决定艾特前后的聊天要不要入库，后者决定提醒截图要不要画上下文。
 *    旧版在 Redis 里也是两个键（group:{gid}:contextEnabled 与 group:{gid}:ctx），
 *    合并成一张表会让「关掉记录」顺带把「提醒上下文」也关掉。
 *
 * 三态语义：**表里没有这一行 = 没单独设置过 = 跟随默认**，
 * 所以 get*Enabled 一律返回 null 表示"没设置过"，由调用方决定默认值。
 * 「#重置艾特插件」删行即可回到默认，不用把默认值写进存储层。
 *
 * ⚠️ 本文件不依赖具体业务常量，默认值一律由调用方（apps/*）传入。
 */

import { SqliteDB } from '../lib/sqlite.js'
import { resolve } from 'node:path'
import { dataDir } from './paths.js'

const dbFile = resolve(dataDir, 'atme.db')

let db = null

/** 取数据库句柄 */
function d () {
  if (!db) throw new Error('[Atme-Plugin] SQLite 尚未初始化，请先调用 initDB()')
  return db
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  unique_id   TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  target_qq   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  images      TEXT NOT NULL DEFAULT '[]',
  face_id     TEXT NOT NULL DEFAULT '[]',
  name        TEXT NOT NULL DEFAULT '',
  time        INTEGER NOT NULL,
  message_id  TEXT NOT NULL DEFAULT '',
  is_context  INTEGER NOT NULL DEFAULT 0,
  before_msg  TEXT NOT NULL DEFAULT '[]',
  after_msg   TEXT NOT NULL DEFAULT '[]',
  quoted_msg  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_gt ON records (group_id, target_qq, time);
CREATE INDEX IF NOT EXISTS idx_records_time ON records (time);

CREATE TABLE IF NOT EXISTS unread (
  group_id   TEXT NOT NULL,
  target_qq  TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  reminded   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, target_qq, record_id)
);
CREATE INDEX IF NOT EXISTS idx_unread_record ON unread (record_id);

CREATE TABLE IF NOT EXISTS trigger (
  group_id  TEXT NOT NULL,
  target_qq TEXT NOT NULL,
  at_time   INTEGER NOT NULL,
  PRIMARY KEY (group_id, target_qq)
);

CREATE TABLE IF NOT EXISTS cooldown (
  group_id  TEXT NOT NULL,
  target_qq TEXT NOT NULL,
  at_time   INTEGER NOT NULL,
  PRIMARY KEY (group_id, target_qq)
);

CREATE TABLE IF NOT EXISTS atall (
  uid      TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  payload  TEXT NOT NULL,
  time     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_atall_g ON atall (group_id, time);

CREATE TABLE IF NOT EXISTS group_record_ctx (
  group_id TEXT PRIMARY KEY,
  enabled  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_remind (
  group_id TEXT PRIMARY KEY,
  enabled  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_remind (
  group_id  TEXT NOT NULL,
  target_qq TEXT NOT NULL,
  enabled   INTEGER NOT NULL,
  PRIMARY KEY (group_id, target_qq)
);

CREATE TABLE IF NOT EXISTS group_remind_ctx (
  group_id     TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL,
  before_count INTEGER NOT NULL DEFAULT 0,
  after_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/**
 * 旧版遗留的表名。
 *
 * 上游老版本往**同一个 atme.db** 里建过一批表（那时用的是自增 id + 多表拆分），
 * 本版换了表结构，直接建新表。同一个文件里旧表会一直躺着占空间、也让
 * 「用什么表」变得没法一眼看清 —— 启动时顺手 DROP 掉。
 *
 * ⚠️ 只在确认表确实存在时才删，且不碰任何本版在用的表名。
 */
const LEGACY_TABLES = [
  'atme_records',            // 旧记录主表
  'atme_trigger_time',       // 旧触发时间
  'unread_atme',             // 旧未读
  'group_config',            // 旧群配置
  'remind_context_config',   // 旧提醒上下文
  'remind_cooldown',         // 旧冷却
  'remind_group_config',     // 旧群提醒开关
  'remind_user_config'       // 旧个人提醒开关
]
// 注：sqlite_sequence 是 SQLite 内部表（自增列用），**不允许 DROP**，不要加进来。

/** 清理上游遗留表（幂等；表不存在就跳过） */
function dropLegacyTables () {
  const dropped = []
  for (const t of LEGACY_TABLES) {
    const exists = d().get(
      "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?",
      [t]
    )
    if (!exists) continue
    d().run(`DROP TABLE IF EXISTS ${t}`)   // 表名来自上面的常量，无注入面
    dropped.push(t)
  }
  if (dropped.length) {
    logger.mark(`[Atme-Plugin] 已清理旧版遗留表 ${dropped.length} 张：${dropped.join(', ')}`)
  }
}

/**
 * 初始化数据库（建表 + 清旧表）。返回数据库文件路径。
 * 幂等：重复调用只跑一次。
 */
export async function initDB () {
  if (!db) {
    db = await SqliteDB.open(dbFile)
    db.exec(SCHEMA)
    try {
      dropLegacyTables()
    } catch (err) {
      // 清旧表失败不影响使用，下次启动再试
      logger.debug(`[Atme-Plugin] 清理旧表失败: ${err.message}`)
    }
    logger.mark(`[Atme-Plugin] SQLite 存储就绪（${db.driver}）: ${dbFile}`)
  }
  return dbFile
}

export async function checkDBHealth () {
  try {
    d().get('SELECT 1 AS ok')
    return true
  } catch {
    return false
  }
}

/** 连接失效时尝试重建 */
export async function reinitReminderDB () {
  try {
    d().get('SELECT 1 AS ok')
    return true
  } catch { /* 连接坏了，往下重建 */ }
  try { db?.close() } catch { /* 已经关了 */ }
  db = null
  await initDB()
  return true
}

export function dbPath () { return dbFile }

// ---------- 解析工具 ----------

function asArray (v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? p : []
    } catch { return [] }
  }
  return []
}

function asObj (v) {
  if (v == null) return null
  if (typeof v === 'object') return v
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return null }
  }
  return null
}

/** 数据库行 → 业务对象（字段名与旧 Redis 版保持一致，调用方零改动） */
function rowToRecord (row) {
  if (!row) return null
  return {
    unique_id: row.unique_id,
    group_id: row.group_id,
    target_qq: row.target_qq,
    user_id: row.user_id,
    message: row.message ?? '',
    images: asArray(row.images),
    face_id: asArray(row.face_id),
    name: row.name ?? '',
    time: row.time,
    message_id: row.message_id ?? '',
    is_context: !!row.is_context,
    before_msg: asArray(row.before_msg),
    after_msg: asArray(row.after_msg),
    quoted_msg: asObj(row.quoted_msg),
    created_at: row.created_at
  }
}

const clampCount = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(5, Math.max(0, Math.trunc(n))) : 0
}

// ==================== 艾特记录 ====================

/**
 * 保存一条艾特记录。
 * @returns {string} 该记录的 unique_id
 */
export async function saveAtRecord (rec) {
  d().run(
    `INSERT OR REPLACE INTO records
      (unique_id, group_id, target_qq, user_id, message, images, face_id, name,
       time, message_id, is_context, before_msg, after_msg, quoted_msg, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      rec.uniqueId,
      String(rec.groupId),
      String(rec.targetQQ),
      String(rec.userId),
      rec.message ?? '',
      JSON.stringify(rec.images ?? []),
      JSON.stringify(rec.faceId ?? []),
      rec.name ?? '',
      rec.time,
      rec.messageId ?? '',
      rec.isContext ? 1 : 0,
      JSON.stringify(rec.before ?? []),
      JSON.stringify(rec.after ?? []),
      rec.quotedContent ? JSON.stringify(rec.quotedContent) : null,
      Math.floor(Date.now() / 1000)
    ]
  )
  return rec.uniqueId
}

export async function getRecordByUid (uid) {
  return rowToRecord(d().get('SELECT * FROM records WHERE unique_id = ?', [uid]))
}

/** 取某(群,人)的全部记录，按时间升序 */
export async function getAtRecords (groupId, targetQQ) {
  return d()
    .all(
      'SELECT * FROM records WHERE group_id = ? AND target_qq = ? ORDER BY time ASC',
      [String(groupId), String(targetQQ)]
    )
    .map(rowToRecord)
}

/** 按 uid 批量取原始行（内部用） */
function getRawRowsByUids (uids) {
  if (!uids || !uids.length) return []
  const out = []
  const BATCH = 500 // SQLite 变量上限默认 999，留足余量
  for (let i = 0; i < uids.length; i += BATCH) {
    const part = uids.slice(i, i + BATCH).map(String)
    const ph = part.map(() => '?').join(',')
    out.push(...d().all(`SELECT * FROM records WHERE unique_id IN (${ph})`, part))
  }
  return out
}

/** 追加「下文」消息（读-改-写） */
export async function updateAfterMsg (uniqueId, afterMsg) {
  d().run('UPDATE records SET after_msg = ? WHERE unique_id = ?', [
    JSON.stringify(afterMsg ?? []),
    uniqueId
  ])
}

/**
 * 删除若干记录，并同步清掉指向它们的未读条目。
 * @returns {Array} 被删记录的解析对象（用于回收图片）
 */
export async function deleteRecordsByUids (uids) {
  if (!uids || !uids.length) return []
  const rows = getRawRowsByUids(uids)
  if (!rows.length) return []
  const ids = rows.map(r => r.unique_id)
  d().tx(() => {
    const BATCH = 500
    for (let i = 0; i < ids.length; i += BATCH) {
      const part = ids.slice(i, i + BATCH)
      const ph = part.map(() => '?').join(',')
      d().run(`DELETE FROM records WHERE unique_id IN (${ph})`, part)
      d().run(`DELETE FROM unread WHERE record_id IN (${ph})`, part)
    }
  })
  return rows.map(rowToRecord)
}

export async function getAllRecords () {
  return d().all('SELECT * FROM records').map(rowToRecord)
}

/** 取全量 (group_id, target_qq) 组合（逐用户超限清理用） */
export async function getAllGroupTargets () {
  return d().all('SELECT DISTINCT group_id, target_qq FROM records')
}

export async function countRecords () {
  return Number(d().get('SELECT COUNT(*) AS c FROM records')?.c ?? 0)
}

// ==================== 配置：记录层上下文开关 ====================
// null = 该群没单独设置过，由调用方回退到默认值

export async function getContextEnabled (groupId) {
  const row = d().get('SELECT enabled FROM group_record_ctx WHERE group_id = ?', [String(groupId)])
  return row ? !!row.enabled : null
}

export async function setContextEnabled (groupId, enabled) {
  d().run(
    `INSERT INTO group_record_ctx (group_id, enabled) VALUES (?,?)
     ON CONFLICT(group_id) DO UPDATE SET enabled = excluded.enabled`,
    [String(groupId), enabled ? 1 : 0]
  )
}

// ==================== 提醒：群/人 开关 ====================

export async function getGroupRemindEnabled (groupId) {
  const row = d().get('SELECT enabled FROM group_remind WHERE group_id = ?', [String(groupId)])
  return row ? !!row.enabled : null
}

export async function setGroupRemindEnabled (groupId, enabled) {
  d().run(
    `INSERT INTO group_remind (group_id, enabled) VALUES (?,?)
     ON CONFLICT(group_id) DO UPDATE SET enabled = excluded.enabled`,
    [String(groupId), enabled ? 1 : 0]
  )
}

export async function getUserRemindEnabled (groupId, targetQQ) {
  const row = d().get('SELECT enabled FROM user_remind WHERE group_id = ? AND target_qq = ?', [
    String(groupId),
    String(targetQQ)
  ])
  return row ? !!row.enabled : null
}

export async function setUserRemindEnabled (groupId, targetQQ, enabled) {
  d().run(
    `INSERT INTO user_remind (group_id, target_qq, enabled) VALUES (?,?,?)
     ON CONFLICT(group_id, target_qq) DO UPDATE SET enabled = excluded.enabled`,
    [String(groupId), String(targetQQ), enabled ? 1 : 0]
  )
}

/** 锅巴面板：列出所有单独设置过的群开关（三张表合并去重） */
export async function listGroupSwitches () {
  const gids = new Set()
  for (const t of ['group_record_ctx', 'group_remind', 'group_remind_ctx']) {
    for (const row of d().all(`SELECT group_id FROM ${t}`)) gids.add(row.group_id)
  }
  const out = []
  for (const gid of gids) {
    const rec = d().get('SELECT enabled FROM group_record_ctx WHERE group_id = ?', [gid])
    const rem = d().get('SELECT enabled FROM group_remind WHERE group_id = ?', [gid])
    const ctx = d().get('SELECT * FROM group_remind_ctx WHERE group_id = ?', [gid])
    out.push({
      group: gid,
      // 'default' = 未单独设置（前端三态下拉的第三档，写回时删行）
      contextEnabled: rec ? (rec.enabled ? '1' : '0') : 'default',
      remind: rem ? (rem.enabled ? '1' : '0') : 'default',
      ctxMode: ctx ? (ctx.enabled ? '1' : '0') : 'default',
      ctxBefore: ctx ? Number(ctx.before_count) : 0,
      ctxAfter: ctx ? Number(ctx.after_count) : 0
    })
  }
  return out
}

/** 锅巴面板：把开关写回（'default' = 删行回到未设置；字段缺失 = 不动） */
export async function applyGroupSwitches (items = []) {
  const list = Array.isArray(items) ? items : []
  const map = new Map()
  for (const it of list) {
    if (it == null || it.group == null || it.group === '') continue
    map.set(String(it.group), it) // 同群多行取最后一行
  }
  let set = 0
  let del = 0

  for (const [gid, it] of map) {
    for (const [field, table, apply] of [
      ['contextEnabled', 'group_record_ctx', setContextEnabled],
      ['remind', 'group_remind', setGroupRemindEnabled]
    ]) {
      const v = it[field]
      if (v === '1' || v === '0' || v === true || v === false) {
        await apply(gid, v === '1' || v === true)
        set++
      } else if (v === 'default') {
        const r = d().run(`DELETE FROM ${table} WHERE group_id = ?`, [gid])
        if (Number(r.changes ?? 0) > 0) del++
      }
      // 其他值（undefined 等前端漏字段）：跳过不动，防误重置
    }

    const mode = it.ctxMode
    if (mode === '1' || mode === '0') {
      await setContextConfig(gid, {
        enabled: mode === '1',
        beforeCount: clampCount(it.ctxBefore),
        afterCount: clampCount(it.ctxAfter)
      })
      set++
    } else if (mode === 'default') {
      const r = d().run('DELETE FROM group_remind_ctx WHERE group_id = ?', [gid])
      if (Number(r.changes ?? 0) > 0) del++
    }
  }
  return { groups: map.size, set, del }
}

// ==================== 提醒：上下文配置 ====================

export async function getContextConfig (groupId) {
  const row = d().get('SELECT * FROM group_remind_ctx WHERE group_id = ?', [String(groupId)])
  if (!row) return null
  return {
    enabled: !!row.enabled,
    beforeCount: Number(row.before_count) || 0,
    afterCount: Number(row.after_count) || 0
  }
}

export async function setContextConfig (groupId, patch) {
  const gid = String(groupId)
  const current = await getContextConfig(gid)

  // 未指定的字段沿用当前值（current 为 null 表示该群还没设置过，用兜底值）
  const base = current || { enabled: false, beforeCount: 0, afterCount: 0 }
  const enabled = patch.enabled === undefined ? base.enabled : !!patch.enabled
  const beforeCount = patch.beforeCount === undefined ? base.beforeCount : clampCount(patch.beforeCount)
  const afterCount = patch.afterCount === undefined ? base.afterCount : clampCount(patch.afterCount)

  d().run(
    `INSERT INTO group_remind_ctx (group_id, enabled, before_count, after_count) VALUES (?,?,?,?)
     ON CONFLICT(group_id) DO UPDATE SET
       enabled = excluded.enabled,
       before_count = excluded.before_count,
       after_count = excluded.after_count`,
    [gid, enabled ? 1 : 0, beforeCount, afterCount]
  )
  return { enabled, beforeCount, afterCount }
}

// ==================== 触发时间 / 冷却 ====================

export async function recordAtTriggerTime (groupId, targetQQ) {
  d().run(
    `INSERT INTO trigger (group_id, target_qq, at_time) VALUES (?,?,?)
     ON CONFLICT(group_id, target_qq) DO UPDATE SET at_time = excluded.at_time`,
    [String(groupId), String(targetQQ), Math.floor(Date.now() / 1000)]
  )
}

export async function clearAtTriggerTime (groupId, targetQQ) {
  d().run('DELETE FROM trigger WHERE group_id = ? AND target_qq = ?', [
    String(groupId),
    String(targetQQ)
  ])
}

export async function getTriggerAt (groupId, targetQQ) {
  const row = d().get('SELECT at_time FROM trigger WHERE group_id = ? AND target_qq = ?', [
    String(groupId),
    String(targetQQ)
  ])
  return row ? Number(row.at_time) : null
}

export async function updateCooldown (groupId, targetQQ) {
  d().run(
    `INSERT INTO cooldown (group_id, target_qq, at_time) VALUES (?,?,?)
     ON CONFLICT(group_id, target_qq) DO UPDATE SET at_time = excluded.at_time`,
    [String(groupId), String(targetQQ), Math.floor(Date.now() / 1000)]
  )
}

export async function getCooldownAt (groupId, targetQQ) {
  const row = d().get('SELECT at_time FROM cooldown WHERE group_id = ? AND target_qq = ?', [
    String(groupId),
    String(targetQQ)
  ])
  return row ? Number(row.at_time) : null
}

// ==================== 未读提醒 ====================

export async function saveUnreadAt (groupId, targetQQ, uid) {
  d().run(
    `INSERT INTO unread (group_id, target_qq, record_id, reminded, created_at)
     VALUES (?,?,?,0,?)
     ON CONFLICT(group_id, target_qq, record_id) DO UPDATE SET reminded = 0`,
    [String(groupId), String(targetQQ), String(uid), Math.floor(Date.now() / 1000)]
  )
}

/**
 * 取某(群,人)的未读记录（JOIN 主表解析），按时间升序，最多 limit 条。
 * @param {number} expireTimestamp 只返回 time > 该值的记录
 */
export async function getUnreadRecords (groupId, targetQQ, expireTimestamp, limit) {
  const rows = d().all(
    `SELECT r.* FROM unread u
       JOIN records r ON r.unique_id = u.record_id
      WHERE u.group_id = ? AND u.target_qq = ? AND u.reminded = 0 AND r.time > ?
      ORDER BY r.time ASC
      LIMIT ?`,
    [String(groupId), String(targetQQ), expireTimestamp, limit]
  )
  return rows.map(rowToRecord)
}

export async function clearUnread (groupId, targetQQ) {
  d().run('DELETE FROM unread WHERE group_id = ? AND target_qq = ?', [
    String(groupId),
    String(targetQQ)
  ])
}

/** 把已提醒的未读行标记为 reminded=1 */
export async function markReminded (groupId, targetQQ, uids) {
  if (!uids || !uids.length) return
  const gid = String(groupId)
  const qq = String(targetQQ)
  d().tx(() => {
    for (const uid of uids) {
      d().run(
        'UPDATE unread SET reminded = 1 WHERE group_id = ? AND target_qq = ? AND record_id = ?',
        [gid, qq, String(uid)]
      )
    }
  })
}

/** 清掉指向已删除记录的孤儿未读行 */
export async function purgeOrphanUnread () {
  const r = d().run('DELETE FROM unread WHERE record_id NOT IN (SELECT unique_id FROM records)')
  return Number(r.changes ?? 0)
}

/** 清掉「该(群,人)已无任何记录」的孤儿触发时间 */
export async function purgeOrphanTrigger () {
  const r = d().run(`
    DELETE FROM trigger
     WHERE NOT EXISTS (
       SELECT 1 FROM records
        WHERE records.group_id = trigger.group_id AND records.target_qq = trigger.target_qq
     )
  `)
  return Number(r.changes ?? 0)
}

// ==================== 全量清空 ====================

export async function deleteAllRecords () {
  const n = await countRecords()
  d().run('DELETE FROM records')
  return n
}

export async function clearUnreadAll () {
  d().run('DELETE FROM unread')
}

export async function clearTriggerAll () {
  d().run('DELETE FROM trigger')
}

export async function resetAll () {
  d().tx(() => {
    for (const t of [
      'records', 'unread', 'trigger', 'cooldown', 'atall',
      'group_record_ctx', 'group_remind', 'user_remind', 'group_remind_ctx'
    ]) {
      d().run(`DELETE FROM ${t}`)
    }
  })
  // DELETE 不会让文件立刻变小，VACUUM 把空间还给系统
  try { d().exec('VACUUM') } catch (err) {
    logger.debug(`[Atme-Plugin] VACUUM 失败（不影响使用）: ${err.message}`)
  }
}

// ==================== 全体艾特（轻量，每群有界） ====================

/**
 * 保存一条全体艾特，并按条数/时长裁剪。
 * @returns {Promise<Array>} 本次被裁剪的记录（供调用方回收图片）
 */
export async function saveAtAll (groupId, data, { maxCount = 10, maxAgeSeconds = 0 } = {}) {
  const gid = String(groupId)
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const trimmed = []
  const parse = (raw) => { try { return JSON.parse(raw) } catch { return null } }

  d().tx(() => {
    d().run('INSERT INTO atall (uid, group_id, payload, time) VALUES (?,?,?,?)', [
      uid,
      gid,
      JSON.stringify({ ...data, uid }),
      data.time
    ])

    if (maxAgeSeconds > 0) {
      const cutoff = Number(data.time) - maxAgeSeconds
      const expired = d().all('SELECT payload FROM atall WHERE group_id = ? AND time <= ?', [gid, cutoff])
      d().run('DELETE FROM atall WHERE group_id = ? AND time <= ?', [gid, cutoff])
      for (const row of expired) {
        const obj = parse(row.payload)
        if (obj) trimmed.push(obj)
      }
    }

    const total = Number(d().get('SELECT COUNT(*) AS c FROM atall WHERE group_id = ?', [gid])?.c ?? 0)
    const overflow = total - maxCount
    if (overflow > 0) {
      const old = d().all(
        'SELECT payload FROM atall WHERE group_id = ? ORDER BY time ASC LIMIT ?',
        [gid, overflow]
      )
      d().run(
        `DELETE FROM atall WHERE uid IN (
           SELECT uid FROM atall WHERE group_id = ? ORDER BY time ASC LIMIT ?
         )`,
        [gid, overflow]
      )
      for (const row of old) {
        const obj = parse(row.payload)
        if (obj) trimmed.push(obj)
      }
    }
  })

  return trimmed
}

/** 读某群最近的全体艾特（返回时间升序） */
export async function getRecentAtAll (groupId, count = 10) {
  if (!count || count <= 0) return []
  const rows = d().all(
    'SELECT payload FROM atall WHERE group_id = ? ORDER BY time DESC LIMIT ?',
    [String(groupId), count]
  )
  const out = []
  for (const row of rows) {
    try { out.push(JSON.parse(row.payload)) } catch { /* 坏行跳过 */ }
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0))
  return out
}

export async function clearAtAll (groupId = null) {
  if (groupId != null) d().run('DELETE FROM atall WHERE group_id = ?', [String(groupId)])
  else d().run('DELETE FROM atall')
}

// ==================== meta（配置合并快照等） ====================

export async function getMeta (key) {
  const row = d().get('SELECT value FROM meta WHERE key = ?', [String(key)])
  return row ? row.value : null
}

export async function setMeta (key, value) {
  d().run(
    `INSERT INTO meta (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(key), value == null ? null : String(value)]
  )
}

// 全部以具名导出对外提供（调用方一律 `import * as Store from './store.js'`）。
// 这里不再额外挂一份 default 清单 —— 那只是把导出的名字抄第二遍，
// 加一个函数要改两处，还平白多一段和旧版一模一样的死代码。

