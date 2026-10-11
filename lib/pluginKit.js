// lib/pluginKit.js —— 插件类的公共脚手架
//
// 四个 app（atme / atme_reminder / help / stats）的插件类都在重复同一件事：
//   把每个 fnc 包一层「群聊启用开关」过滤。
// 这段以前是每个文件各抄一份 8 行循环，改一处要改四处。
// 这里收口成一个函数；指令表本身留在各自文件（那是各插件的契约，不是重复）。

import { isEnabledGroup } from '../components/groupEnable.js'

/**
 * 给指令方法套上「群聊启用开关」过滤。
 *
 * 规则：锅巴里配了 enabledGroups 就只在这些群响应；没配（空数组）则全部群可用；
 * 私聊始终放行，方便主人在私聊用 #艾特帮助 / #艾特统计。
 *
 * ⚠️ 必须在构造函数里、super() 之后调用：它要改的是 this 上的方法。
 *    注意 Yunzai 的 loader 是每条消息都 new 一次插件类，
 *    所以这里每次都重新包一层，不能用模块级缓存。
 *
 * @param {object} instance 插件实例（this）
 * @returns {object} 同一个实例，方便链式写
 */
export function applyGroupGate (instance) {
  if (!Array.isArray(instance?.rule)) return instance
  for (const r of instance.rule) {
    if (!r?.fnc || typeof instance[r.fnc] !== 'function') continue
    const orig = instance[r.fnc].bind(instance)
    instance[r.fnc] = (e) => (isEnabledGroup(e) ? orig(e) : false)
  }
  return instance
}

export default { applyGroupGate }
