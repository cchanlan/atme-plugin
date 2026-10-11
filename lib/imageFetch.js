// lib/imageFetch.js —— 图片下载与转码
//
// 从 record.js 抽出的通用 IO：拉取远程图片 → ffmpeg 转 webp → 落盘 → 复核产物。
// 这部分跟存储层（Redis / SQLite）完全无关，纯粹是"把网图变成本地文件"。
//
// ⚠️ 一律用 execFile + 参数数组，不用 exec 拼字符串：
//    源文件名里只要出现引号 / & / 空格，拼进 shell 就会变成另一条命令。
//    同时必须带 timeout，否则 ffmpeg 卡住时子进程会永远挂在系统里。

import fs from 'fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify as promisifyCb } from 'node:util'
import { MAX_IMAGE_BYTES } from './imageFiles.js'

const execFileAsync = promisifyCb(execFile)

/** 单次转码/探测的超时（毫秒） */
export const FFMPEG_TIMEOUT_MS = 20000

/** 单张图下载超时（毫秒） */
const FETCH_TIMEOUT_MS = 10000

/** 探测图片的真实编码格式（判断要不要取 gif 首帧） */
export async function detectImageFormat (filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true })
    return stdout.trim().toLowerCase() || null
  } catch (err) {
    logger.debug(`[Atme-Plugin] ffprobe 检测失败: ${err.message}`)
    return null
  }
}

/** 转成 webp；gif 取首帧（-vframes 1），静态图无副作用 */
export async function transcodeToWebp (inputPath, outputPath) {
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vframes', '1',
      '-vf', "scale='min(800,iw)':-1",
      '-lossless', '0',
      '-compression_level', '6',
      outputPath
    ], { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true })
    return true
  } catch (err) {
    logger.debug(`[Atme-Plugin] 转码失败: ${err.message}`)
    return false
  }
}

/** 带重试的 HTTP GET（边收边算大小，超限立刻中断，不把内存打满） */
export async function fetchWithRetry (url, options = {}, maxRetries = 2) {
  const client = url.startsWith('https') ? https : http

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = client.get(url, options, (res) => {
          const chunks = []
          let received = 0
          let aborted = false

          res.on('data', (chunk) => {
            if (aborted) return
            received += chunk.length
            if (received > MAX_IMAGE_BYTES) {
              aborted = true
              res.destroy()
              reject(new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节上限，已中断下载`))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            if (aborted) return
            resolve({ statusCode: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) })
          })
        })

        req.on('error', reject)
        req.setTimeout(FETCH_TIMEOUT_MS, () => {
          req.destroy()
          reject(new Error(`请求超时 (${url})`))
        })
      })
    } catch (err) {
      if (attempt === maxRetries) throw err
      logger.debug(`[Atme-Plugin] 请求失败，第${attempt}次重试: ${err.message}`)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
    }
  }
}

/**
 * 下载一张图并缓存到本地（正常转成 webp；没装 ffmpeg 时按原格式缓存）。
 *
 * 文件名统一以 .webp 结尾是**有意的**：渲染时靠这个后缀拼路径，
 * 而浏览器识别图片看的是文件头而不是后缀，所以即使里面装的是 jpg/png
 * 也能正常显示。改了后缀反而会让渲染找不到文件。
 *
 * @param {string} url
 * @param {string} imagesDir 存放目录（data/atme/images）
 * @param {string} dataDir   data/atme（临时文件放这）
 * @returns {Promise<string|null>} 相对路径 `images/xxx.webp`；失败返回 null（调用方回落原始 URL）
 */
export async function downloadImageToLocal (url, imagesDir, dataDir) {
  if (!url) return null

  const timestamp = Date.now()
  const randomStr = Math.random().toString(36).slice(2, 10)
  const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8)
  const fileName = `${timestamp}_${randomStr}_${urlHash}.webp`
  const filePath = resolve(imagesDir, fileName)
  const relativePath = `images/${fileName}`
  const tempPath = resolve(dataDir, `temp_${timestamp}_${randomStr}`)

  try {
    const response = await fetchWithRetry(url, {}, 2)
    if (response.statusCode !== 200) {
      logger.debug(`[Atme-Plugin] 下载图片失败 ${url}: HTTP ${response.statusCode}`)
      return null
    }

    await fs.writeFile(tempPath, response.data)
    let converted = await transcodeToWebp(tempPath, filePath)

    // 转码没成功（用户机器没装 ffmpeg / 超时 / 源图格式怪）时，
    // **别浪费已经下下来的原图** —— 直接把它按原样存成缓存文件。
    // 否则只能退回远程 URL，而 QQ 的图片 URL 有时效，过一会儿就是破图。
    // 浏览器认得 jpg/png/gif，渲染时照样能显示。
    if (!converted) {
      converted = await keepAsIs(tempPath, filePath)
      if (converted) {
        logger.debug(`[Atme-Plugin] 未转码，按原图缓存（多半是没装 ffmpeg）: ${url}`)
      }
    }

    try {
      await fs.unlink(tempPath)
    } catch (err) {
      logger.debug(`[Atme-Plugin] 清理临时文件失败: ${err.message}`)
    }

    // 转码可能压根没成功（机器没装 ffmpeg / 超时 / 源图损坏）。
    // 这时 filePath 根本不存在，照样返回相对路径渲染出来就是破图，
    // 必须复核产物确实落盘且非空，否则返回 null 让调用方退回原始 URL。
    if (!converted) {
      logger.debug(`[Atme-Plugin] 图片缓存失败，回退原始URL: ${url}`)
      return null
    }
    try {
      const st = await fs.stat(filePath)
      if (!st || st.size === 0) {
        await fs.unlink(filePath).catch(() => {})
        logger.debug(`[Atme-Plugin] 缓存产物为空，回退原始URL: ${url}`)
        return null
      }
    } catch (err) {
      logger.debug(`[Atme-Plugin] 缓存产物缺失，回退原始URL ${url}: ${err.message}`)
      return null
    }

    return relativePath
  } catch (err) {
    logger.debug(`[Atme-Plugin] 处理图片失败: ${err.message}`)
    try {
      if (existsSync(tempPath)) await fs.unlink(tempPath)
    } catch (cleanupErr) {
      logger.debug(`[Atme-Plugin] 清理临时文件失败: ${cleanupErr.message}`)
    }
    return null
  }
}

/** 转码不可用时，把原图直接搬成缓存文件（浏览器能认 jpg/png/gif） */
async function keepAsIs (tempPath, filePath) {
  try {
    await fs.copyFile(tempPath, filePath)
    return true
  } catch (err) {
    logger.debug(`[Atme-Plugin] 原图拷贝失败: ${err.message}`)
    return false
  }
}

/**
 * 批量下载，失败项保留原始 URL（渲染时能直接加载网络图）。
 */
export async function downloadAll (urls, imagesDir, dataDir) {
  const out = []
  for (const url of urls) {
    const local = await downloadImageToLocal(url, imagesDir, dataDir)
    out.push(local || url)
  }
  return out
}

export default {
  FFMPEG_TIMEOUT_MS,
  detectImageFormat,
  transcodeToWebp,
  fetchWithRetry,
  downloadImageToLocal,
  downloadAll
}
