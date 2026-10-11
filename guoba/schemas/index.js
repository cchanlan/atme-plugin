import { Config, YamlReader, Plugin_Path } from "../../components/index.js"
import * as Store from "../../components/store.js"

// ===== 群级开关（锅巴可视化，与命令同源） =====
// 单一数据源是 components/store.js 的三张表：
//   group_record_ctx  —— 记录层上下文开关（#开启/关闭艾特上下文）
//   group_remind      —— 本群艾特提醒（#开启/关闭本群艾特提醒）
//   group_remind_ctx  —— 提醒上下文（#开启/关闭/设置本群提醒上下文）
// 三态语义：表里没有这一行 = 未单独设置 = 跟随默认模板
const TRI_STATE = [
  { label: '跟随默认', value: 'default' },
  { label: '开启', value: '1' },
  { label: '关闭', value: '0' }
]

const isNil = (v) => v === null || v === undefined

/**
 * 读取所有已单独设置过的群开关，转成 GSubForm 条目。
 * 缺失的显示为「跟随默认」；ctxBefore/ctxAfter 用 yaml 新群默认模板兜底显示。
 */
async function readGroupOverrides (yamlCfg) {
  try {
    const rows = await Store.listGroupSwitches()
    return rows.map(r => ({
      group: r.group,
      remind: r.remind,
      contextEnabled: r.contextEnabled,
      // 提醒上下文开关的表里没行时用 'default'，有行时用 1/0
      ctxMode: r.ctxMode ?? 'default',
      ctxBefore: isNil(r.ctxBefore) ? (yamlCfg?.reminderContext?.beforeCount ?? 1) : r.ctxBefore,
      ctxAfter: isNil(r.ctxAfter) ? (yamlCfg?.reminderContext?.afterCount ?? 1) : r.ctxAfter
    }))
  } catch (e) {
    // 存储还没就绪（面板先于插件加载）时给空列表，别让面板整个崩掉
    logger.debug(`[Atme-Plugin][配置中心] 读取群组开关失败：${e.message}`)
    return []
  }
}

// ===== 锅巴配置分类 =====
// 三大分区：基础设置 / 提醒配置 / 其他配置（出图浏览器也归入其他配置）。
// 注：群提醒开关 / 个人提醒开关 / 上下文开关由命令维护、存于 SQLite，
// 不在 yaml 里；yaml 里的 reminderContext.* 只是"群里还没设置过"时的新群默认模板。
const schemas = [
  // ========== 基础设置 ==========
  {
    component: "SOFT_GROUP_BEGIN",
    label: "基础设置"
  },
  {
    component: 'Divider',
    label: '启用群聊'
  },
  {
    field: 'atme.enabledGroups',
    label: '启用群聊',
    helpMessage: '只在这些群里启用本插件；留空表示所有群都启用。可搜索群名 / 群号多选',
    component: 'GSelectGroup'
  },
  {
    component: 'Divider',
    label: '谁艾特我'
  },
  {
    field: 'atme.expireDays',
    label: '过期天数',
    helpMessage: "数据过期天数（超过此天数的艾特记录将被自动清理）",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 1,
      step: 1,
      placeholder: '请输入天数',
      addonAfter: "天"
    }
  },
  {
    field: 'atme.maxRecordsPerUser',
    label: '记录条数',
    helpMessage: "每个用户在单个群内最多保留的记录条数（超出时自动删除最旧的）",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 1,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },
  {
    field: 'atme.defaultContext',
    label: "上下文记录",
    bottomHelpMessage: "新群默认是否开启上下文记录（true/false）",
    component: "Switch"
  },
  {
    field: "atme.enableAtAll",
    label: "记录全体艾特",
    bottomHelpMessage: "是否记录 @全体成员 消息：开启后「谁艾特我」的查询结果会按时间混入近期全体艾特（带「全体艾特」标签；不产生未读提醒、不占用个人记录配额）",
    component: "Switch"
  },
  {
    field: 'atme.atAll.maxCount',
    label: '全体艾特条数上限',
    helpMessage: "「近期全体艾特」板块每个群最多保留的条数（超出自动删最旧）",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 1,
      max: 50,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },
  {
    component: 'Divider',
    label: '查询上下文'
  },
  {
    field: "atme.context.enabled",
    label: "显示上下文",
    bottomHelpMessage: "查询截图时是否显示艾特消息的前后上下文（不影响记录，只影响显示）",
    component: "Switch"
  },
  {
    field: 'atme.context.beforeCount',
    label: '前消息条数',
    helpMessage: "查询截图时显示艾特消息前面的多少条消息作为上下文",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 5,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },
  {
    field: 'atme.context.afterCount',
    label: '后消息条数',
    helpMessage: "查询截图时显示艾特消息后面的多少条消息作为上下文",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 5,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },

  // ========== 提醒配置 ==========
  {
    component: "SOFT_GROUP_BEGIN",
    label: "提醒配置"
  },
  {
    component: 'Divider',
    label: '群组开关（按群覆盖）'
  },
  {
    field: 'atme.groupOverrides',
    label: '群组开关',
    component: 'GSubForm',
    componentProps: {
      multiple: true,
      modalProps: { title: '群组开关配置（与命令互通、即时生效）', width: 640 },
      lengthMax: 500,
      schemas: [
        {
          field: 'group',
          label: '群聊',
          component: 'GSelectGroup',
          componentProps: { single: true },
          required: true,
          bottomHelpMessage: '要单独配置的群；可直接搜索群名 / 群号'
        },
        {
          field: 'remind',
          label: '本群艾特提醒',
          component: 'Select',
          defaultValue: 'default',
          componentProps: { options: TRI_STATE },
          bottomHelpMessage: '与「#开启/关闭本群艾特提醒」同源；未单独设置时为开启'
        },
        {
          field: 'contextEnabled',
          label: '艾特上下文记录',
          component: 'Select',
          defaultValue: 'default',
          componentProps: { options: TRI_STATE },
          bottomHelpMessage: '与「#开启/关闭艾特上下文」同源（记录层）；未单独设置时跟随「基础设置 → 谁艾特我 → 上下文记录」'
        },
        {
          field: 'ctxMode',
          label: '提醒上下文',
          component: 'Select',
          defaultValue: 'default',
          componentProps: { options: TRI_STATE },
          bottomHelpMessage: '与「#开启/关闭/设置本群提醒上下文」同源（提醒截图层）；选 开/关 时可配下方前后条数'
        },
        {
          field: 'ctxBefore',
          label: '提醒前条数',
          component: 'InputNumber',
          defaultValue: 1,
          componentProps: { min: 0, max: 5, step: 1 },
          bottomHelpMessage: '仅在「提醒上下文」选 开/关 时生效（0-5）'
        },
        {
          field: 'ctxAfter',
          label: '提醒后条数',
          component: 'InputNumber',
          defaultValue: 1,
          componentProps: { min: 0, max: 5, step: 1 },
          bottomHelpMessage: '仅在「提醒上下文」选 开/关 时生效（0-5）'
        }
      ]
    },
    bottomHelpMessage: '按群覆盖运行时开关。三态：跟随默认 = 未单独设置；删除某一行不会重置该群配置，改回「跟随默认」才会重置'
  },
  {
    component: 'Divider',
    label: '艾特被动提醒'
  },
  {
    field: 'atme.reminder.expireHours',
    label: '未读有效期',
    helpMessage: "未读艾特记录的有效期（小时），超过此时间的记录不再提醒",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 1,
      max: 168,
      step: 1,
      placeholder: '请输入小时数',
      addonAfter: "小时"
    }
  },
  {
    field: 'atme.reminder.maxRemindCount',
    label: '单次提醒上限',
    helpMessage: "单次提醒最多包含多少条艾特记录，防止截图过长或刷屏",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 1,
      max: 50,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },
  {
    field: 'atme.reminder.autoClearAfterSend',
    label: "提醒后清空",
    bottomHelpMessage: "发送提醒后是否自动清空该用户的未读记录（true=清空，false=保留但标记已提醒）",
    component: "Switch"
  },
  {
    field: 'atme.reminder.cooldownMinutes',
    label: '提醒冷却时间',
    helpMessage: "用户被提醒后，在此时间内再次发言不会触发提醒",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 1,
      max: 1440,
      step: 1,
      placeholder: '请输入分钟数',
      addonAfter: "分钟"
    }
  },
  {
    field: "atme.reminder.skipRecordDuringCooldown",
    label: "冷却期跳过记录",
    bottomHelpMessage: "冷却期间有人艾特你时，是否直接丢弃不记录（true=丢弃，false=暂存等冷却结束再提醒）",
    component: "Switch"
  },
  {
    field: 'atme.reminder.autoRecallSeconds',
    label: '自动撤回时间',
    helpMessage: "发送提醒后多少秒自动撤回，0 表示不撤回",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 300,
      step: 5,
      placeholder: '请输入秒数',
      addonAfter: "秒"
    }
  },
  {
    field: "atme.reminder.debug",
    label: "调试模式",
    bottomHelpMessage: "是否输出详细调试日志（排查问题时开启）",
    component: "Switch"
  },
  {
    field: 'atme.reminder.silentSeconds',
    label: '静默期时长',
    helpMessage: "被艾特后多少秒内，如果用户在群里发言，则不发送提醒（直接丢弃），进入冷却期",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 30000,
      step: 5,
      placeholder: '请输入秒数',
      addonAfter: "秒"
    }
  },
  {
    component: 'Divider',
    label: '提醒上下文（新群默认模板）'
  },
  {
    field: "atme.reminderContext.enabled",
    label: "显示上下文",
    bottomHelpMessage: "新群默认模板：群里没设置过时用它。群内发送 #开启/#关闭本群提醒上下文 后，以群内设置为准（永久保存）",
    component: "Switch"
  },
  {
    field: 'atme.reminderContext.beforeCount',
    label: '前消息条数',
    helpMessage: "新群默认模板：截图时显示艾特消息前面的多少条消息作为上下文",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 5,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },
  {
    field: 'atme.reminderContext.afterCount',
    label: '后消息条数',
    helpMessage: "新群默认模板：截图时显示艾特消息后面的多少条消息作为上下文",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 5,
      step: 1,
      placeholder: '请输入条数',
      addonAfter: "条"
    }
  },
  // ========== 其他配置 ==========
  {
    component: "SOFT_GROUP_BEGIN",
    label: "其他配置"
  },
  {
    field: "atme.autoMergeCfg",
    label: "配置文件合并",
    defaultValue: true,
    bottomHelpMessage: "检测到默认配置文件更新自动合并用户配置文件（只补缺失的键，不覆盖已改过的值；关闭后升级插件需手动补新配置项）",
    component: "Switch"
  },
  {
    component: 'Divider',
    label: '出图浏览器'
  },
  {
    field: 'atme.browser.idleCloseSeconds',
    label: '空闲关闭',
    helpMessage: "出图默认直接用 Yunzai 自带的浏览器，不用额外占内存。这项只在借不到它时（比如换了别的渲染后端）才有用：插件自己开的浏览器空闲多少秒后关掉，0 表示出完立刻关",
    component: "InputNumber",
    required: true,
    componentProps: {
      min: 0,
      max: 3600,
      step: 10,
      placeholder: '请输入秒数',
      addonAfter: "秒"
    }
  }
]

export { schemas }

export async function getConfigData () {
  const atme = Config.getFile('atme')
  // 群组开关是运行数据（库里没行=跟随默认），不存 yaml；读取失败时给空列表避免面板崩
  atme.groupOverrides = await readGroupOverrides(atme)
  return { atme }
}

export async function setConfigData (data, { Result }) {
  try {
    // 群组开关是虚拟字段（运行数据），不能写进 yaml，先剥离单独处理
    const flat = { ...data }
    const overrides = flat['atme.groupOverrides']
    delete flat['atme.groupOverrides']

    let stats = null
    if (Array.isArray(overrides)) {
      stats = await Store.applyGroupSwitches(overrides)
    }

    const dataMap = convertToNestedObject(flat)
    for (const key in dataMap) {
      const path = `${Plugin_Path}/config/config/${key}.yaml`
      const y = new YamlReader(path)
      y.setData(dataMap[key])
      y.save()
    }

    const extra = stats
      ? `（群组开关：设置 ${stats.set} 项 / 重置 ${stats.del} 项，覆盖 ${stats.groups} 个群）`
      : ""
    return Result.ok({}, "保存成功辣ε(*´･ω･)з" + extra)
  } catch (e) {
    logger.error("[Atme-Plugin][配置中心] 保存异常：", e)
    return Result.error({}, `保存失败：${e.message}`)
  }
}

function convertToNestedObject (data) {
  const result = {}
  for (const key in data) {
    if (Object.hasOwn(data, key)) {
      const keys = key.split(".")
      let obj = result
      keys.forEach((k, index) => {
        if (index === keys.length - 1) {
          obj[k] = data[key]
        } else {
          obj[k] = obj[k] || {}
          obj = obj[k]
        }
      })
    }
  }
  return result
}
