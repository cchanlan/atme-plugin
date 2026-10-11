import { fileURLToPath } from 'url';
import path from 'path';

// 获取当前文件所在目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    name: "Atme-Plugin",
    title: "Atme-Plugin",
    author: "Anyliew",
    authorLink: "https://gitcode.com/anyliew/atme-plugin",
    link: "https://gitcode.com/anyliew/atme-plugin",
    isV3: true,
    isV2: false,
    description: "查询群内提及你的消息记录",
    iconPath: path.join(__dirname, 'icon.svg'),
};