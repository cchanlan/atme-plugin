// lib/imageFiles.js —— 图片文件的扫描与回收
//
// 从 record.js / stats.js 里抽出来的公共部分：
//   统计目录用量、按记录收集引用、批量删除、孤儿扫描。
// 这几件事都只跟文件和记录结构有关，跟存储层是 Redis 还是 SQLite 无关。

import fs from 'fs/promises'
import { resolve, dirname } from 'node:path'

/** 单张图片的下载上限（防对方发大文件把内存打满） */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function parseJsonSafe (value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

/**
 * 统计一个目录里所有文件的个数量与总字节（单文件异常跳过，不中断整轮统计）。
 * @returns {Promise<{count:number, bytes:number}>}
 */
export async function scanImageDir (dir) {
  let count = 0
  let bytes = 0
  try {
    const files = await fs.readdir(dir)
    for (const f of files) {
      try {
        const st = await fs.stat(resolve(dir, f))
        if (st.isFile()) {
          count++
          bytes += st.size || 0
        }
      } catch { /* 跳过单个文件的瞬时异常 */ }
    }
  } catch (err) {
    logger.debug(`[Atme-Plugin] 读取图片目录失败: ${err.message}`)
  }
  return { count, bytes }
}

/**
 * 收集一条记录引用的全部本地图片（绝对路径，已去重）。
 *
 * 覆盖 4 个写入位置：
 *   1. images              主消息图
 *   2. quoted_msg.images   引用消息图
 *   3. before_msg[].image  上文图
 *   4. after_msg[].image   下文图
 * 只认以 `images/` 开头的相对路径 —— 下载失败时存的是原始 URL，不该删。
 *
 * @param {object} record 记录行
 * @param {string} dataDir data/atme 的绝对路径
 */
export function collectImagesFromRecord (record, dataDir) {
  if (!record) return []
  const relPaths = []
  const push = (v) => {
    if (typeof v === 'string' && v.startsWith('images/')) relPaths.push(v)
  }

  const images = parseJsonSafe(record.images, [])
  if (Array.isArray(images)) images.forEach(push)

  if (record.quoted_msg) {
    const quoted = parseJsonSafe(record.quoted_msg, null)
    if (quoted && Array.isArray(quoted.images)) quoted.images.forEach(push)
  }

  for (const key of ['before_msg', 'after_msg']) {
    const list = parseJsonSafe(record[key], [])
    if (Array.isArray(list)) {
      for (const ctx of list) {
        if (ctx && Array.isArray(ctx.image)) ctx.image.forEach(push)
      }
    }
  }

  return [...new Set(relPaths)].map(p => resolve(dataDir, p))
}

/**
 * 批量删除图片文件。
 * @returns {Promise<{count:number, bytes:number}>} 删除数量与释放字节数
 */
export async function deleteImageFiles (absPaths) {
  let count = 0
  let bytes = 0
  for (const p of [...new Set(absPaths)]) {
    try {
      const stat = await fs.stat(p)
      await fs.unlink(p)
      count++
      bytes += stat.size || 0
    } catch (err) {
      logger.debug(`[Atme-Plugin] 删除图片失败 ${p}: ${err.message}`)
    }
  }
  return { count, bytes }
}

/**
 * 孤儿图片扫描：删掉磁盘上存在、但库里已无任何引用的图片。
 * 保护期内的文件跳过，避免误删"刚下载还没入库"的图片。
 *
 * @param {string} imagesDir
 * @param {string} dataDir
 * @param {object[]} allRecords 全部记录（调用方先取好）
 * @param {number} protectMs 保护期（毫秒）
 */
export async function sweepOrphanImages (imagesDir, dataDir, allRecords, protectMs = 2 * 3600 * 1000) {
  const referenced = new Set()
  for (const row of allRecords) {
    for (const abs of collectImagesFromRecord(row, dataDir)) referenced.add(abs)
  }

  const files = await fs.readdir(imagesDir).catch(() => [])
  const deadline = Date.now() - protectMs
  let count = 0
  let bytes = 0

  for (const file of files) {
    const abs = resolve(imagesDir, file)
    if (referenced.has(abs)) continue
    try {
      const stat = await fs.stat(abs)
      if (stat.mtimeMs > deadline) continue
      await fs.unlink(abs)
      count++
      bytes += stat.size || 0
    } catch (err) {
      logger.debug(`[Atme-Plugin] 孤儿扫描删除失败 ${file}: ${err.message}`)
    }
  }

  if (count > 0) {
    logger.info(`[Atme-Plugin] 孤儿扫描清理了 ${count} 张图片（${(bytes / 1024).toFixed(1)} KB）`)
  }
  return { count, bytes }
}

export default {
  MAX_IMAGE_BYTES,
  scanImageDir,
  collectImagesFromRecord,
  deleteImageFiles,
  sweepOrphanImages
}
