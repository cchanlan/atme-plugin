import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginApplications = path.join(__dirname, 'apps')

const files = fs.readdirSync(pluginApplications).filter((file) => file.endsWith('.js'))

let ret = []

files.forEach((file) => {
    ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
    let name = files[i].replace('.js', '')

    if (ret[i].status !== 'fulfilled') {
        logger.error(`载入插件错误：${logger.red(name)}`)
        logger.error(ret[i].reason)
        continue
    }

    // ---------- 约定每个 app 模块统一导出名为 plugin 的类 ----------
    const mod = ret[i].value
    if (!mod.plugin) {
        logger.error(`插件 ${name} 未导出 plugin，跳过`)
        continue
    }
    apps[name] = mod.plugin
}

logger.mark('Atme-Plugin Apps 插件载入完毕')
export { apps }