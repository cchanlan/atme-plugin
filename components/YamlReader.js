import fs from "node:fs"
import YAML from "yaml"
import { watch } from "node:fs"

/**
 * 读写 yaml 文件（锅巴面板保存配置用）。
 *
 * 用 YAML 的 Document API 保留注释与格式，只改键值。
 * 没用 lodash：取嵌套值那点逻辑自己写更省一层依赖。
 */
export default class YamlReader {
    static CONFIG_INTEGER_KEY = "INTEGER__"

    /**
     * @param yamlPath yaml 文件绝对路径
     * @param isWatch 是否监听文件变化
     */
    constructor(yamlPath, isWatch = false) {
        this.yamlPath = yamlPath
        this.isWatch = isWatch
        this.initYaml()
    }

    initYaml() {
        this.data = fs.readFileSync(this.yamlPath, "utf8")
        this.document = YAML.parseDocument(this.data)
        if (this.isWatch && !this.watcher && !this.ownWatcher) {
            this.watcher = watch(this.yamlPath, () => {
                if (this.isSave) {
                    this.isSave = false
                    return
                }
                this.initYaml()
            })
            this.watcher.unref?.()
            this.ownWatcher = true
        }
    }

    /** 返回读取的对象 */
    get jsonData() {
        if (!this.document) return null
        return this.document.toJSON()
    }

    has(keyPath) {
        return this.document.hasIn(keyPath.split("."))
    }

    /** 按 "a.b.c" 取嵌套值 */
    get(keyPath) {
        let cur = this.jsonData
        for (const k of String(keyPath).split(".")) {
            if (cur == null || typeof cur !== "object") return undefined
            cur = cur[k]
        }
        return cur
    }

    set(keyPath, value, comment = null) {
        keyPath = this.mapParentKeys(keyPath.split("."))
        if (!comment || this.get(keyPath.join(".")) !== undefined) {
            this.document.setIn(keyPath, value)
        } else {
            this.document.addIn(keyPath, value)
        }

        if (comment) {
            const seq = this.document.getIn(keyPath, true)
            if (seq && !seq.comment) seq.comment = comment
        }
        this.save()
    }

    /** 删除某个键 */
    delete(keyPath) {
        this.document.deleteIn(keyPath.split("."))
        this.save()
    }

    /** 数组添加数据 */
    addIn(keyPath, value) {
        this.document.addIn(keyPath.split("."), value)
        this.save()
    }

    /** 设置 document 的数据并保存（递归式） */
    setData(data) {
        this.setDataRecursion(data, [])
        this.save()
    }

    setDataRecursion(data, parentKeys) {
        if (Array.isArray(data)) {
            this.document.setIn(this.mapParentKeys(parentKeys), data)
        } else if (typeof data === "object" && data !== null) {
            for (const [key, value] of Object.entries(data)) {
                this.setDataRecursion(value, parentKeys.concat([key]))
            }
        } else {
            this.document.setIn(this.mapParentKeys(parentKeys), data)
        }
    }

    /** 将数字 key 转为 number 类型，防止出现引号 */
    mapParentKeys(parentKeys) {
        return parentKeys.map((k) => {
            if (k.startsWith(YamlReader.CONFIG_INTEGER_KEY)) {
                const numericValue = Number(k.replace(YamlReader.CONFIG_INTEGER_KEY, ""))
                if (!Number.isNaN(numericValue)) return numericValue
            }
            return k
        })
    }

    deleteKey(keyPath) {
        this.document.deleteIn(this.mapParentKeys(keyPath.split(".")))
        this.save()
    }

    save() {
        const yaml = this.document.toString()
        // 数据没变就不写盘
        if (yaml === this.data) return
        this.isSave = true
        fs.writeFileSync(this.yamlPath, yaml, "utf8")
        // 写回后同步基准，否则下一次比较会拿旧内容误判成"变了"
        this.data = yaml
    }
}
