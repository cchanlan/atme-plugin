import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs/promises'
import * as Store from '../components/store.js'
import { imagesDir } from '../components/record.js'
import { formatBytes } from '../components/render.js'
import { applyGroupGate } from '../lib/pluginKit.js'
import { scanImageDir } from '../lib/imageFiles.js'

export class atmeStats extends plugin {
  constructor () {
    super({
      name: 'Atme-Plugin 数据统计',
      dsc: '统计已存储的艾特消息',
      event: 'message',
      priority: 500,
      rule: [
        { reg: /^#?艾特统计$/i, fnc: 'statistics' }
      ]
    })

    applyGroupGate(this)
  }

  async statistics (e) {
    try {
      const msgCount = await Store.countRecords()

      // 图片数量 + 占用大小（统计 images 目录下的实际文件）
      const { count: imageCount, bytes: imageBytes } = await scanImageDir(imagesDir)

      // 数据库文件体积（含 WAL）
      let dbBytes = 0
      const dbFile = Store.dbPath()
      for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
        try {
          dbBytes += (await fs.stat(f)).size || 0
        } catch { /* 文件可能还没生成 */ }
      }

      const totalBytes = imageBytes + dbBytes

      e.reply(
        `📊 艾特数据存储统计\n` +
        `━━━━━━━━━━\n` +
        `艾特消息：${msgCount} 条\n` +
        `图片文件：${imageCount} 张\n` +
        `图片占用：${formatBytes(imageBytes)}\n` +
        `数据库占用：${formatBytes(dbBytes)}\n` +
        `合计占用：${formatBytes(totalBytes)}`,
        true
      )
      return true
    } catch (err) {
      logger.error('[Atme-Plugin] 统计失败:', err)
      e.reply('❌ 统计失败，请稍后再试')
      return true
    }
  }
}

export { atmeStats as plugin }
