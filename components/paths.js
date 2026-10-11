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
  helpCacheDir,
  uiIconDir
}
