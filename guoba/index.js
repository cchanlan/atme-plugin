// guoba/index.js —— 锅巴（guoba-plugin-next）自定义页面/接口的入口。
//
// 锅巴启动时会扫每个插件的 guoba/ 子目录，发现这里导出的 init(ctx) 就调用它，
// 给一个能注册后端接口的 ctx。我们只用它注册「聊天背景」的图片上传接口，
// 不注册任何侧边栏页面（所以不会多出菜单项）。
//
// 注意：这跟插件根目录的 guoba.support.js 是两套机制 ——
// guoba.support.js 负责「插件配置」表单，这里负责自定义后端接口，互不干扰。

import { registerGuobaUpload } from '../lib/guobaUpload.js'

export async function init (ctx) {
  registerGuobaUpload(ctx)
}
