// components/paths.js —— 全插件唯一的路径定义处
//
// 数据目录、图片目录、临时目录、配置目录都在这里算一次，其它文件 import 即可。
// 以前 record.js / Config.js / help.js 各算一套（`resolve(__dirname,'..')`、
// `${process.cwd()}/plugins/atme-plugin` 两种写法混用），插件目录一改名就会互相打架。

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 插件根目录（atme-plugin/） */
export const pluginRoot = resolve(__dirname, '..')

/** 用户配置目录（config/config） */
export const configDir = resolve(pluginRoot, 'config', 'config')

/** 默认配置目录（config/default_config） */
export const defaultConfigDir = resolve(pluginRoot, 'config', 'default_config')

/** 用户配置文件绝对路径 */
export const userConfigPath = resolve(configDir, 'atme.yaml')

/** 资源目录 */
export const resourcesDir = resolve(pluginRoot, 'resources')

/** 数据根目录（宿主根下的 data/atme） */
export const dataDir = resolve(process.cwd(), 'data', 'atme')

/** 图片缓存目录 */
export const imagesDir = resolve(dataDir, 'images')

/** 临时文件目录（插件自己收发用的临时文件） */
export const tempDir = resolve(dataDir, 'temp')

/**
 * 出图发送用的临时目录 —— 故意放在**宿主的 temp 下**、带插件名前缀。
 *
 * 为什么不像其它目录那样放 data/atme 下：
 *   出图结果要给宿主的 `e.reply()` 发送。宿主拿到 Buffer 时（见 lib/core/util.js
 *   的 util.Buffer），只要 buffer 超过 size 限制（OneBotv11 适配器传的是 size:0，
 *   即任何非空 buffer 都超限）就会把它**落盘到 `temp/<随机ID>` 并挂 60 秒删除定时器**。
 *   那个定时器活在进程内存里 —— 出图后 60 秒内重启一次就永远丢，文件永久残留
 *   （实测攒过 34 个 / 318MB）。
 *
 *   所以我们改成**自己落盘、把 file:// 路径交给宿主**：宿主拿到已存在的 file://
 *   会直接返回、不再写它自己的 temp。放这个位置的用意是让它和宿主其它临时文件
 *   待在一起（都在 temp 下），但**有独立的目录名**，一眼能看出归属、清理也精准。
 */
export const sendTempDir = resolve(process.cwd(), 'temp', 'atme')

/** 帮助图缓存目录 */
export const helpCacheDir = resolve(dataDir, 'help')

/** 插件自带的 UI 图标目录 */
export const uiIconDir = resolve(resourcesDir, 'images', 'ui')

export default {
  pluginRoot,
  configDir,
  defaultConfigDir,
  userConfigPath,
  resourcesDir,
  dataDir,
  imagesDir,
  tempDir,
  sendTempDir,
  helpCacheDir,
  uiIconDir
}
