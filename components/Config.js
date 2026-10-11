import YAML from "yaml";
import fs from "node:fs";
import { watch } from "node:fs";
import path from "node:path";
import { pluginRoot } from "./paths.js";

export const Log_Prefix = "[Atme-Plugin]";

// 路径统一由 components/paths.js 提供（全插件唯一出处）
const Plugin_Path = pluginRoot;

class Config {
    constructor() {
        this._config = {};
        this.other = {};
        // 先给默认值再 initCfg：copyDir 在 initCfg 里就要读它
        this.other.autoMergeCfg = true;
        this.initCfg();
        // 用户配置里可关：guoba「其他配置 → 配置文件合并」（atme.autoMergeCfg）
        this.other.autoMergeCfg = this.readMergeToggle();
        // 独立监听用户 yaml 热刷新合并开关（guoba / 手动改文件都生效）
        this.watchMergeToggle();
    }

    get config() {
        return this._config;
    }

    set config(value) {
        this._config = value;
    }

    initCfg() {
        const configPath = `${Plugin_Path}/config/config/`;
        const defaultPath = `${Plugin_Path}/config/default_config/`;

        if (!fs.existsSync(configPath)) {
            fs.mkdirSync(configPath, { recursive: true });
        }

        // 默认配置唯一来源是仓库自带的 config/default_config/atme.yaml（不再内置应急模板，
        // 避免出现第二份残缺默认值）；缺失时只告警，运行时由各模块的默认值兜底
        if (!fs.existsSync(path.join(defaultPath, 'atme.yaml'))) {
            logger.warn(`${Log_Prefix}[默认配置] config/default_config/atme.yaml 不存在，请更新插件补齐文件`);
        }

        this.copyDir(defaultPath, configPath);
    }

    copyDir(src, dest) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        const files = fs.readdirSync(src);

        for (const file of files) {
            const srcPath = path.join(src, file);
            const destPath = path.join(dest, file);
            const stats = fs.statSync(srcPath);

            if (stats.isDirectory()) {
                this.copyDir(srcPath, destPath);
            } else if (!fs.existsSync(destPath)) {
                fs.copyFileSync(srcPath, destPath);
            } else if (this.other.autoMergeCfg) {
                // fire-and-forget，但必须接住异常：写库抖动不能变成 unhandledRejection
                this.mergeCfg(destPath, srcPath, file)
                    .catch(e => logger.error(`${Log_Prefix}[合并配置][${file}] 失败: ${e.message}`));
            }
        }
    }

    /**
     * 读取用户配置里的「配置文件合并」开关（atme.autoMergeCfg）
     * 键缺失或文件不存在时默认开启（与旧版硬编码 true 行为一致）
     * @returns {boolean}
     */
    readMergeToggle() {
        try {
            const file = `${Plugin_Path}/config/config/atme.yaml`;
            if (!fs.existsSync(file)) return true;
            const cfg = YAML.parse(fs.readFileSync(file, "utf8"));
            return cfg?.autoMergeCfg !== false;
        } catch (e) {
            // yaml 语法错误时按开启兜底，但要留痕——静默吞掉会让"关了却还在合并"无从排查
            logger.error(`${Log_Prefix}[合并开关] 读取失败，按开启处理: ${e.message}`);
            return true;
        }
    }

    /** 常驻监听用户 yaml（仅合并开关用途，文件不存在时等它出现） */
    watchMergeToggle() {
        try {
            const file = `${Plugin_Path}/config/config/atme.yaml`;
            const watcher = watch(file, () => this.change_atme());
            watcher.unref?.();
        } catch (e) {
            logger.error(`${Log_Prefix}[合并开关] 监听失败: ${e.message}`);
        }
    }

    /**
     * 用户 yaml 被改（含锅巴保存）时热刷新合并开关，
     * 下一次插件更新重启时按新开关决定是否合并默认配置
     */
    change_atme() {
        const prev = this.other.autoMergeCfg;
        this.other.autoMergeCfg = this.readMergeToggle();
        // 值没变化（如锅巴保存其他字段）不打日志，避免噪音
        if (prev !== this.other.autoMergeCfg) {
            logger.mark(`${Log_Prefix}[配置更新][配置文件合并=${this.other.autoMergeCfg ? '开' : '关'}]`);
        }
    }

    /**
     * 把默认配置里新增的键合并进用户配置。
     *
     * 快照（"上次见过的默认文件"）存在 SQLite 的 meta 表里 ——
     * 以前放 Redis，现在整个插件都不依赖 Redis 了，跟数据放一起。
     * import 放在函数内部：Config 在模块加载期就实例化了，
     * 那时 store.js 可能还没建好表（两者初始化顺序不保证）。
     */
    async mergeCfg(cfgPath, defPath, name) {
        const defData = fs.readFileSync(defPath, "utf8");
        const key = `mergeCfg:${name}`;

        let Store
        try {
            Store = await import("./store.js");
            // ⚠️ 必须自己先确保库就绪：Config 是在模块 import 链上实例化的，
            //    此时 record.js 里的 initDB() 多半还没跑到（它也是被 import 的一环）。
            //    少了这一句，合并配置会撞上"SQLite 尚未初始化"。
            await Store.initDB();
        } catch (e) {
            // 存储实在起不来时跳过本轮合并（下次启动会再试），不能因此打断插件加载
            logger.debug(`${Log_Prefix}[合并配置] 存储未就绪，跳过本轮: ${e.message}`);
            return;
        }

        const snap = await Store.getMeta(key);
        if (defData === snap) return;
        await Store.setMeta(key, defData);

        const userDoc = YAML.parseDocument(fs.readFileSync(cfgPath, "utf8"));
        const defDoc = YAML.parseDocument(defData);
        let isUpdate = false;

        const merge = (user, def) => {
            if (!user?.items || !def?.items) return;
            const existingKeys = new Map();
            for (const item of user.items) {
                if (item?.key?.value !== undefined) existingKeys.set(item.key.value, item.value);
            }
            for (const item of def.items) {
                if (item?.key?.commentBefore?.includes?.("noMerge")) continue;
                if (!existingKeys.has(item.key.value)) {
                    logger.info(`${Log_Prefix}[合并配置][${name}][${item.key.value}]`);
                    user.push(item);
                    isUpdate = true;
                } else if (YAML.isMap(item.value) && YAML.isMap(existingKeys.get(item.key.value))) {
                    merge(existingKeys.get(item.key.value), item.value);
                }
            }
        };
        merge(userDoc.contents, defDoc.contents);
        if (isUpdate) fs.writeFileSync(cfgPath, userDoc.toString(), "utf8");
    }

    getFile(fileName) {
        const file = `${Plugin_Path}/config/config/${fileName}.yaml`;
        if (!fs.existsSync(file)) return {};
        try {
            return YAML.parse(fs.readFileSync(file, 'utf8')) || {};
        } catch (e) {
            logger.error(`${Log_Prefix}[配置] ${fileName}.yaml 解析失败: ${e.message}`);
            return {};
        }
    }
}

export default new Config();
export { default as YamlReader } from "./YamlReader.js";
export { Plugin_Path };
