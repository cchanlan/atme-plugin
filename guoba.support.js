// guoba.support.js
// 锅巴 (Guoba-Plugin) 配置面板入口：锅巴扫描每个插件目录下的本文件并调用 supportGuoba()。
// 未安装 guoba-plugin 时本文件不会被加载，无副作用。
//
// 结构：
//   guoba/pluginInfo.js   插件元信息（名称/图标/描述）
//   guoba/schemas/        配置面板 schema + 读写实现
import pluginInfo from "./guoba/pluginInfo.js"
import { schemas, getConfigData, setConfigData } from "./guoba/schemas/index.js"

export function supportGuoba() {
    return {
        pluginInfo,
        configInfo: {
            schemas,
            getConfigData,
            setConfigData
        }
    }
}
