// lib/guobaUpload.js —— 给锅巴面板「聊天背景 → 背景图片」用的图片上传接口。
//
// 锅巴（guoba-plugin-next）会扫插件根目录的 index.js，发现导出的 init(ctx) 就调它，
// ctx.registerApi 能把一个后端接口挂到 `/api/custom/<插件名><route>` 下，鉴权由锅巴统一处理。
//
// 面板里的上传控件（GUpload）把文件 POST 到这个接口（字段名固定 `file`，锅巴全局 multer
// 已落盘到 data/upload_tmp/），响应里给出图片地址就回填进配置。它本身不暴露「存到哪个目录」，
// 所以存储目录由本接口自己定：直接收进插件的 resources/bg/，配置里只存文件名，
// 出图时 background.js 的 resolveBareName 按 resources/bg 找即可。

import fs from 'node:fs'
import path from 'node:path'
import { bgDir } from '../components/background.js'

/** 背景图上限：面板背景再大也用不到这么大，主要别让磁盘写爆 */
const MAX_SIZE = 20 * 1024 * 1024
const ACCEPT_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

/** 清掉文件名里的路径分隔符和开头的点，防 ../ 越界覆盖插件外文件 */
function sanitizeName (name) {
  return String(name || '').replace(/[\\/]/g, '_').replace(/^\.+/, '').trim()
}

async function moveInto (srcPath, target) {
  try {
    await fs.promises.rename(srcPath, target)
  } catch {
    // 跨文件系统时 rename 会失败，退回复制 + 删临时
    await fs.promises.copyFile(srcPath, target)
    await fs.promises.unlink(srcPath).catch(() => {})
  }
}

export function registerGuobaUpload (ctx) {
  ctx.registerApi('post', '/upload', async (req, res) => {
    const files = Array.isArray(req.files)
      ? req.files
      : Object.values(req.files ?? {}).flat()
    const file = files[0]
    if (!file?.path) {
      res.status(400).json({ code: 400, message: '没有收到文件' })
      return
    }

    const cleanup = () => fs.promises.unlink(file.path).catch(() => {})
    const ext = path.extname(file.originalname || '').slice(1).toLowerCase()
    if (!ACCEPT_EXTS.includes(ext)) {
      await cleanup()
      res.status(400).json({ code: 400, message: `只支持 ${ACCEPT_EXTS.join(' / ')} 格式的图片` })
      return
    }
    if (Number(file.size ?? 0) > MAX_SIZE) {
      await cleanup()
      res.status(400).json({ code: 400, message: `图片过大（上限 ${MAX_SIZE / 1024 / 1024}MB）` })
      return
    }

    fs.mkdirSync(bgDir, { recursive: true })
    const safe = sanitizeName(file.originalname) || `bg.${ext}`
    const base = path.basename(safe, path.extname(safe))
    let name = safe
    let target = path.join(bgDir, name)
    if (fs.existsSync(target)) {
      // 重名自动加后缀，别覆盖已有背景
      name = `${base}-${Date.now().toString(36)}.${ext}`
      target = path.join(bgDir, name)
    }
    await moveInto(file.path, target)
    ctx.logger?.info?.(`[Atme-Plugin] 背景图已上传：${target}`)
    // GUpload 从 url / path 字段取回填值；只存文件名，出图时按 resources/bg 找
    res.json({ url: name })
  })
}
