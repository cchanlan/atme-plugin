// apps/atme.js —— Atme-Plugin 命令壳
//
// 只保留插件类、命令注册与命令方法；录制、查询、清理、删除等实现分别在：
//   components/record.js —— 录制主链路（recordAtMessage）/ 图片下载转码 / 清理 / 删除 / 配置
//   components/query.js  —— 「谁艾特我」查询与渲染链（queryWhoAtme）
//
// 本文件与 components 模块保持单向依赖（apps → components），无循环引用。
// 未读标记（saveUnreadAt）与存储重连（reinitReminderDB）属于提醒模块职责，
// 因此留在 apps 层：recordAtMessage 返回待标记列表、resetDatabase 后在此重连。

import plugin from '../../../lib/plugins/plugin.js'
import { formatBytes } from '../components/render.js'
import * as Record from '../components/record.js'
import { queryWhoAtme } from '../components/query.js'
import { saveUnreadAt, reinitReminderDB } from './atme_reminder.js'
import { isEnabledGroup } from '../components/groupEnable.js'
import { applyGroupGate } from '../lib/pluginKit.js'

// ---------- 插件类 ----------
export class whoAtme extends plugin {
  constructor () {
    super({
      name: 'Atme-Plugin 艾特记录查询',
      dsc: '查看谁艾特过你',
      event: 'message',
      priority: -114514,
      rule: [
        { reg: /^(谁(艾特|@|at)(我|他|她|它))$/i, fnc: 'whoAtme' },
        { reg: /^#?清空我的艾特$/i, fnc: 'clearAt' },
        { reg: /^#?清空全部艾特$/i, fnc: 'clearAll', permission: 'master' },
        { reg: /^#?重置艾特插件$/i, fnc: 'resetData', permission: 'master' },
        { reg: /^#?开启艾特上下文$/i, fnc: 'onContext', permission: 'master' },
        { reg: /^#?(关闭)(艾特|at)上下文$/i, fnc: 'offContext', permission: 'master' }
      ]
    })

    applyGroupGate(this)

    // 只注册一次（见 components/record.js ensureTempCleaner 的说明）
    Record.ensureTempCleaner()
  }

  async accept (e) {
    if (!e.isGroup) return
    if (!isEnabledGroup(e)) return

    // 录制主链路在 components/record.js；返回值 = 待标记未读列表
    // （未读标记属提醒模块，由本层逐条调用，避免 components 反向依赖 apps）
    const saved = await Record.recordAtMessage(e)
    for (const s of saved) {
      await saveUnreadAt(s.groupId, s.targetQQ, s.recordId)
    }
  }

  async whoAtme (e) {
    return queryWhoAtme(e)
  }

  async clearAt (e) {
    if (!e.isGroup) return e.reply('只支持群聊', true)
    const { records, images, bytes } = await Record.deleteUserRecords(e.group_id, String(e.user_id))
    if (records === 0) return e.reply('你在当前群没有可清空的艾特记录', true)
    e.reply(
      `✅ 已清空你在本群的艾特记录\n` +
      `记录 ${records} 条 · 图片 ${images} 张 · 释放 ${formatBytes(bytes)}`,
      true
    )
    return true
  }

  async clearAll (e) {
    const { records, images, bytes } = await Record.deleteAllRecords()
    e.reply(
      `✅ 已清空全部艾特\n` +
      `记录 ${records} 条 · 图片 ${images} 张 · 释放 ${formatBytes(bytes)}\n` +
      `（群/个人提醒开关与上下文配置均未改动）`
    )
    return true
  }

  async resetData (e) {
    await Record.resetDatabase()

    // 清库后确认存储连接可用
    try {
      await reinitReminderDB()
    } catch (err) {
      logger.warn(`[Atme-Plugin] 重建存储连接失败: ${err.message}`)
    }

    e.reply('✅ 艾特数据已重置，所有记录与开关配置已还原为默认（提醒默认开启）')
  }

  async onContext (e) {
    if (!e.isGroup) return false
    if (!e.isMaster) {
      return e.reply('只有Bot主人可以操作')
    }
    await Record.setContextEnabled(e.group_id, true)
    e.reply('已开启本群艾特上下文记录')
    return true
  }

  async offContext (e) {
    if (!e.isGroup) return false
    if (!e.isMaster) {
      return e.reply('只有Bot主人可以操作')
    }
    await Record.setContextEnabled(e.group_id, false)
    Record.beforeCache.delete(e.group_id)
    Record.afterTasks.delete(e.group_id)
    e.reply('已关闭本群艾特上下文记录')
    return true
  }
}

export { whoAtme as plugin }
