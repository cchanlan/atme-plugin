// lib/sqlite.js —— Atme-Plugin 的 SQLite 驱动适配层
//
// 优先用 Node 内置的 node:sqlite（Node 22.13+ / 23.4+ 起无需启动参数），
// 拿不到时回退到用户环境里装的 better-sqlite3；两者都没有就抛一句人话提示。
//
// 两套驱动的 API 几乎一致（prepare / run / get / all / exec），差异只有三处：
//   1. 绑定参数都不接受 boolean 和 undefined —— node:sqlite 直接抛 TypeError，
//      所以这里统一规范化：true/false → 1/0，undefined/null → null。
//   2. node:sqlite 没有 transaction() 帮助函数，事务用 BEGIN/COMMIT 手写。
//   3. 无结果时 node:sqlite 的 get() 给 undefined，统一成 null。
//
// ⚠️ 两套驱动都是**同步** API：事务里不能混 await，
//    否则 BEGIN 和 COMMIT 之间被别的任务插进来，原子性就没了。

import fs from 'node:fs'
import { dirname, resolve } from 'node:path'

let driverPromise = null

/** 探测可用驱动。结果缓存，只探一次。 */
export function loadDriver () {
  if (driverPromise) return driverPromise
  driverPromise = (async () => {
    // 1) Node 内置（推荐：零依赖、无需编译）
    try {
      const mod = await import('node:sqlite')
      if (mod?.DatabaseSync) return { name: 'node:sqlite', Database: mod.DatabaseSync }
    } catch { /* 老版本 Node 没有这个模块，继续往下探 */ }

    // 2) 用户环境自装的 better-sqlite3
    try {
      const mod = await import('better-sqlite3')
      const Database = mod?.default ?? mod?.Database
      if (typeof Database === 'function') return { name: 'better-sqlite3', Database }
    } catch { /* 没装，继续 */ }

    throw new Error(
      '[Atme-Plugin] 找不到可用的 SQLite 驱动：' +
      '请把 Node 升级到 22.13 以上（内置 node:sqlite），' +
      '或在插件目录执行 pnpm add better-sqlite3 后重启'
    )
  })()
  return driverPromise
}

/** 绑定值规范化：驱动不接受 boolean / undefined */
function normalize (v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'bigint') return Number(v)
  return v
}

export class SqliteDB {
  constructor (raw, driverName) {
    this.raw = raw
    this.driver = driverName
    this._stmts = new Map()
  }

  /**
   * 打开（不存在则创建）数据库文件。
   * WAL 模式让读写不互相阻塞；synchronous=NORMAL 在 WAL 下已足够安全。
   */
  static async open (file) {
    const driver = await loadDriver()
    const abs = resolve(file)
    fs.mkdirSync(dirname(abs), { recursive: true })
    const raw = new driver.Database(abs)
    raw.exec('PRAGMA journal_mode = WAL')
    raw.exec('PRAGMA synchronous = NORMAL')
    raw.exec('PRAGMA busy_timeout = 5000')
    return new SqliteDB(raw, driver.name)
  }

  /** 缓存 prepared statement：群消息高频路径上避免反复编译同一条 SQL */
  _prep (sql) {
    let st = this._stmts.get(sql)
    if (!st) {
      st = this.raw.prepare(sql)
      this._stmts.set(sql, st)
    }
    return st
  }

  exec (sql) {
    this.raw.exec(sql)
  }

  run (sql, params = []) {
    return this._prep(sql).run(...params.map(normalize))
  }

  /** 取一行，无结果返回 null */
  get (sql, params = []) {
    return this._prep(sql).get(...params.map(normalize)) ?? null
  }

  /** 取全部行 */
  all (sql, params = []) {
    return this._prep(sql).all(...params.map(normalize)) ?? []
  }

  /**
   * 同步事务：fn 里只做同步 DB 操作，抛错自动回滚。
   * 不支持 async fn —— 见文件头说明。
   */
  tx (fn) {
    this.raw.exec('BEGIN')
    try {
      const r = fn()
      this.raw.exec('COMMIT')
      return r
    } catch (e) {
      try { this.raw.exec('ROLLBACK') } catch { /* 回滚失败时保留原始错误 */ }
      throw e
    }
  }

  close () {
    this._stmts.clear()
    try { this.raw.close() } catch { /* 已经关了 */ }
  }
}

export default { SqliteDB, loadDriver }
