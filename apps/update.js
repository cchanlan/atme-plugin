import { update as YzUpdate } from "../../other/update.js";

export class Update extends plugin {
    constructor() {
        super({
            name: "Atme-Plugin 更新",
            event: "message",
            priority: -Infinity,
            rule: [
                {
                    reg: /^#*(atme|at|@|艾特)(插件)?(强制)?更新$/i,
                    fnc: "update",
                },
            ],
        });
    }

    async update(e = this.e) {
        e.msg = `#${e.msg.includes("强制") ? "强制" : ""}更新atme-plugin`;
        const up = new YzUpdate(e);
        up.e = e;
        return up.update();
    }
}

export { Update as plugin }