import { Config } from './index.js'

/**
 * 群聊启用开关（参考 message-plugin 的「按群配置」思路，但适配 atme 自身结构，不照搬）。
 *
 * 规则：
 * - atme.enabledGroups 为空（默认）→ 所有群聊均启用
 * - atme.enabledGroups 非空      → 仅列表内的群启用，列表外的群完全不响应
 * - 私聊（!e.isGroup）始终启用，方便主人在私聊使用 #艾特帮助 / #艾特统计 等
 *
 * 数据来源：锅巴面板写入的 config/config/atme.yaml 里的 enabledGroups（数组，群号）。
 * Config.getFile 为同步读取，适合在每条消息的 accept / 命令入口高频调用。
 *
 * 注意：本文件放在 components/ 而不是 apps/。
 * index.js 会把 apps/ 下每个 .js 都当作插件载入并要求导出 plugin，
 * 所以纯工具模块必须放 components/，否则启动会报「未导出 plugin，跳过」。
 *
 * @param {object} e Yunzai 消息对象
 * @returns {boolean} 该群是否允许 atme 运行
 */
export function isEnabledGroup(e) {
  let enabled = []
  try {
    const cfg = Config.getFile('atme')
    if (cfg && Array.isArray(cfg.enabledGroups)) {
      enabled = cfg.enabledGroups
    }
  } catch (err) {
    // 读取失败时按「全部启用」处理，避免误伤
    return true
  }

  // 未配置启用群列表 → 全部群启用
  if (enabled.length === 0) return true
  // 私聊始终启用
  if (!e.isGroup) return true
  // 仅列表内的群启用
  return enabled.some(g => String(g) === String(e.group_id))
}
