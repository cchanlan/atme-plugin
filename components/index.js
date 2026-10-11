import Config from './Config.js'
export { default as YamlReader } from "./YamlReader.js"
// Plugin_Path 以 Config.js 里那份为准（由 import.meta.url 推导，跟着插件实际位置走）。
// 这里原先另算了一份 `${process.cwd()}/plugins/atme-plugin`，一旦插件目录改名或
// 宿主 cwd 不在宿主根目录，两处就会指向不同地方。
export { Plugin_Path } from './Config.js'

export { Config }
