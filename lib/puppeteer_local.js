// lib/puppeteer_local.js —— 出图执行层（多渲染后端兼容）
//
// 三种情况依次尝试，尽量把活交给宿主，实在不行才自己启动浏览器：
//
//   ① 宿主的渲染服务（`renderService.render`）—— **外置渲染也能用**
//      这是后端无关的入口：走 `lib/core/render/index.js` 的 noscript_renderers，
//      由宿主决定用本地 chromium 还是远程 chromium（browserless / puppeteerWS）。
//      用户装了外置渲染时，这条路才是正解 —— 硬去借宿主浏览器是借不到的。
//
//   ② 借宿主的浏览器实例（`hostRenderer.browserInit()` → 拿 Browser 开 page 自己截）
//      比 ① 灵活（能等图片、控 viewport），所以 ① 不适用时仍走这条。
//
//   ③ 自己启动一份 chromium
//      只在 ①② 都不行时兜底。**这条路最容易在用户机器上失败**
//      （puppeteer 装了但没下载浏览器 → `Could not find Chrome`），
//      所以失败时必须给一句人话提示，而不是抛栈。
//
// ⚠️ 记忆教训（王者插件的扫码登录踩过）：
//   · 渲染器要**优先取 e.runtime.puppeteer**，直接 import 渲染器文件在配了外置渲染时
//     不够健壮（`getRenderer()` 拿不到配置的后端时会返回**空对象 `{}`**）
//   · 能力检查必须严格（`typeof x.browserInit === 'function'`），否则会炸
//     `browserInit is not a function`
//   · `browserInit()` 并发时**直接返回 false**（源码 `if (this.lock) return false`），
//     所以拿不到要多试几次，不能一次就当不可用
//   · 自己起的实例要记着关，否则留孤儿进程

import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import YAML from 'yaml'
import { configDir } from '../components/paths.js'

// ---------- 宿主渲染服务 ----------

let hostRenderer = null
try {
  hostRenderer = (await import('../../../lib/puppeteer/puppeteer.js')).default
} catch {
  // 宿主路径变了或加载失败，走后面的兜底
  hostRenderer = null
}

// TRSS 系框架（TRSS-Yunzai 及其衍生，如 AozakiArina-Bot/Yunzai）没有
// `lib/puppeteer/puppeteer.js` 兼容层，渲染器本体在 `renderers/puppeteer/lib/puppeteer.js`。
// 探测到就借它的浏览器实例（同款 puppeteer Browser，isConnected/newPage 都在），
// 探测不到保持 null —— 自启动兜底顶上。
if (!hostRenderer) {
  try {
    const trss = (await import('../../../renderers/puppeteer/lib/puppeteer.js')).default
    // 渲染器实例：要能 browserInit + 挂着 browser 字段才算数（getRenderer 失败会返回空对象）
    if (trss && typeof trss.browserInit === 'function') hostRenderer = trss
  } catch {
    // 不是 TRSS 系布局，忽略
  }
}

/**
 * 宿主渲染服务能不能借浏览器实例。
 *
 * ⚠️ 必须严格检查：`lib/renderer/loader.js` 的 `getRenderer()` 在配置的后端不是
 *    puppeteer 时会返回**空对象 `{}`**（源码 `return this.renderers.get(name) || {}`），
 *    直接当渲染器用会炸成 `renderer.browserInit is not a function`。
 */
function hostUsable () {
  return typeof hostRenderer?.browserInit === 'function' && 'browser' in hostRenderer
}

/**
 * 宿主的渲染入口走不走得通（外置渲染靠这个，后端无关）。
 * JiuLi 的渲染服务叫 `render(name, data)`；TRSS 系（含 AozakiArina-Bot/Yunzai）
 * 的渲染器只有 `screenshot(name, data)`（返回 segment 包过的图或 Buffer 数组）。
 * 两个都认：extractRenderBuffer 能兜住 segment 形态的返回值。
 */
function hostCanRender () {
  return typeof hostRenderer?.render === 'function' || typeof hostRenderer?.screenshot === 'function'
}

/**
 * 判断是不是真正能用的 puppeteer Browser 实例。
 *
 * 宿主的 `renderer.browser` 是个「多值哨兵」字段，不是保证为实例：
 *   - 未初始化 / 已关闭 / 重启窗口期 → `false`
 *   - 启动失败 → `undefined`
 * 而 `b?.isConnected()` 的可选链只对 null/undefined 短路，
 * 碰到 `false` 或其它真值非实例对象会直接抛 "is not a function"。
 */
function isBrowser (b) {
  return !!b && typeof b.isConnected === 'function' && typeof b.newPage === 'function'
}

// ---------- 自启动兜底 ----------

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const configFile = path.join(configDir, 'atme.yaml')

/** 配置里没写、或写了个不合法的值时用它（秒） */
const DEFAULT_IDLE_SECONDS = 60

/** 自启动兜底用的实例，正常情况下一直是 null */
let ownBrowser = null
let ownPromise = null
/** 正在出图的任务数。>0 时不能关浏览器，否则会把别人正用着的实例拽掉 */
let activeTasks = 0
let idleTimer = null
let idleSeconds = null
let idleMtime = 0

/**
 * 自启动兜底时，出图全部结束后再空闲多少毫秒就关掉浏览器，0 表示出完立刻关。
 * 跟着配置文件的 mtime 走，改完不用重启。
 */
function idleCloseMs () {
  try {
    const mtime = statSync(configFile).mtimeMs
    if (idleSeconds === null || mtime !== idleMtime) {
      const cfg = YAML.parse(readFileSync(configFile, 'utf-8')) || {}
      const sec = Number(cfg?.browser?.idleCloseSeconds)
      idleSeconds = Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_IDLE_SECONDS
      idleMtime = mtime
    }
  } catch {
    idleSeconds = DEFAULT_IDLE_SECONDS
  }
  return idleSeconds * 1000
}

function cancelIdleClose () {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/** 没有在跑的出图任务了，安排把自启动的浏览器关掉 */
function scheduleIdleClose () {
  cancelIdleClose()
  if (activeTasks > 0 || !ownBrowser) return
  const ms = idleCloseMs()
  if (ms === 0) {
    closeBrowser()
    return
  }
  idleTimer = setTimeout(() => {
    idleTimer = null
    // 排上定时器之后又来了新任务，就不能关
    if (activeTasks === 0) closeBrowser()
  }, ms)
  idleTimer.unref?.()
}

/**
 * 关掉自启动的浏览器。宿主的实例不归插件管，一律不碰。
 *
 * close() 之外必须留一手 SIGKILL：--single-process 下页面一崩就会把整条 CDP 通道
 * 带走，这时 close() 的 Browser.close 命令根本发不出去，只 catch 掉的话 chromium
 * 进程会留在系统里。
 */
async function closeBrowser () {
  cancelIdleClose()
  const b = ownBrowser
  ownBrowser = null
  if (!isBrowser(b)) return
  const proc = b.process?.()
  try {
    await b.close()
  } catch { /* 已经没了 */ }
  if (proc && proc.exitCode === null) {
    try { proc.kill('SIGKILL') } catch { /* 进程已经退了 */ }
  }
}

/**
 * 找本机可用的浏览器可执行文件。
 *
 * ⚠️ 这一步很关键：宿主装的多半是 **`puppeteer-core`**，它**从不自带浏览器**，
 *    `launch()` 不带 `executablePath` 时必然抛 `Could not find Chrome (ver. xxx)` ——
 *    用户现场就是这么崩的。所以自己启动前先找一个装好的浏览器：
 *      ① 环境变量 `PUPPETEER_EXECUTABLE_PATH`
 *      ② 宿主配置里的 chromium 路径（`bot.yaml` 的 `chromium_path`）
 *      ③ 各平台常见安装位置
 *    都找不到就交给 puppeteer 自己决定（它可能真下载过浏览器）。
 */
function findBrowserExecutable () {
  const candidates = []

  // ① 环境变量优先（用户显式指定过就听他的）
  if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH)

  // ② 宿主配置里的路径
  try {
    // 延迟读取：这个模块要在宿主之外也能加载，读不到就当没有
    const cfgPath = path.resolve(process.cwd(), 'config', 'config', 'bot.yaml')
    const cfg = YAML.parse(readFileSync(cfgPath, 'utf-8')) || {}
    if (cfg?.chromium_path) candidates.push(cfg.chromium_path)
  } catch { /* 没有这个配置就算了 */ }

  // ③ 各平台常见位置
  const common = {
    linux: [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  }
  candidates.push(...(common[process.platform] || []))

  for (const p of candidates) {
    if (!p) continue
    try {
      if (statSync(p).isFile()) return p
    } catch { /* 这个路径没有，试下一个 */ }
  }
  return null
}

/**
 * 兜底路径：自己启动一份 chromium。
 *
 * ⚠️ 这条最容易在用户机器上失败：宿主只装了 `puppeteer-core`（**从不自带浏览器**），
 *    报 `Could not find Chrome (ver. xxx)`。所以启动前先找本机现成的浏览器，
 *    报错也要给一句能照做的提示。
 */
async function ownInit () {
  if (isBrowser(ownBrowser) && ownBrowser.isConnected()) return ownBrowser
  if (ownPromise) return ownPromise

  ownPromise = (async () => {
    try {
      if (ownBrowser) await closeBrowser()

      // 宿主装的不一定是 `puppeteer`，也可能只有 `puppeteer-core` —— 两个都试
      let puppeteer = null
      for (const name of ['puppeteer', 'puppeteer-core']) {
        try {
          const mod = await import(name)
          puppeteer = mod?.default ?? mod
          if (typeof puppeteer?.launch === 'function') break
          puppeteer = null
        } catch { /* 没装这个包，试下一个 */ }
      }
      if (!puppeteer) {
        throw new Error(
          '借不到宿主浏览器，自己启动也找不到 puppeteer'
        )
      }

      const executablePath = findBrowserExecutable()
      let launched
      try {
        launched = await puppeteer.launch({
          // `true` 在各版本都能用；`'new'` 在新版 puppeteer 上已被移除
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          args: [
            // 这几个只在 Linux 下有意义；Windows/macOS 上传了也无害
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
          ]
        })
      } catch (err) {
        // 最常见：puppeteer-core 没浏览器、机器上也没装 Chrome
        if (/Could not find|not found|ENOENT/i.test(err?.message || '')) {
          throw new Error(
            '本机没有可用的浏览器（宿主的 puppeteer 是 core 版，不自带浏览器）'
          )
        }
        throw err
      }
      ownBrowser = launched
      return launched
    } finally {
      ownPromise = null
    }
  })()

  return ownPromise
}

/**
 * 让宿主把浏览器准备好（优先），拿不到才自己起。
 *
 * ⚠️ `browserInit()` 在**别的指令正在出图**时会直接返回 `false`
 *    （源码 `if (this.lock) return false`），所以这里多试几次，
 *    不能一次当不可用就转去自己 launch。
 *
 * @returns {Promise<Browser|false>}
 */
async function browserInit () {
  if (hostUsable()) {
    for (let i = 0; i < 4; i++) {
      try {
        const b = await hostRenderer.browserInit()
        if (isBrowser(b)) return b
      } catch { /* 宿主那边在重启，重试 */ }
      // 宿主正在启动中（内部有锁）会返回 false，等一下再取一次
      await new Promise(r => setTimeout(r, 700))
      if (isBrowser(hostRenderer.browser)) return hostRenderer.browser
    }
  }
  return ownInit()
}

/**
 * 确保浏览器可用，并把这次出图登记为「进行中」。
 *
 * 调用方**必须**在 finally 里配一次 releaseBrowser()，否则计数配不平，
 * 自启动兜底的那份就再没有关闭时机。
 * @returns {Promise<Browser|false>}
 */
async function ensureBrowser () {
  activeTasks++
  // 先撤掉待关闭的定时器：它可能正好在这张图要用实例的当口把浏览器关掉
  cancelIdleClose()
  const b = getBrowser()
  if (isBrowser(b) && b.isConnected()) return b
  return browserInit()
}

/** 当前该用哪个实例：宿主的优先，没有才用自己启动的（两者都必须真的是 Browser） */
function getBrowser () {
  if (hostUsable() && isBrowser(hostRenderer.browser)) return hostRenderer.browser
  return isBrowser(ownBrowser) ? ownBrowser : null
}

/** 这次出图用完了。宿主的实例交回宿主管，自启动的那份按空闲时间自动关掉 */
function releaseBrowser () {
  activeTasks = Math.max(0, activeTasks - 1)
  scheduleIdleClose()
}

// 进程直接退出（没走信号）时把自启动的 chromium 一起带走，
// 否则它会被 init 收养、继续挂在系统里
process.on('exit', () => {
  const proc = ownBrowser?.process?.()
  if (proc && proc.exitCode === null) {
    try { proc.kill('SIGKILL') } catch { /* 已经退了 */ }
  }
})

export default {
  get browser () { return getBrowser() },
  browserInit,
  ensureBrowser,
  releaseBrowser,
  closeBrowser,
  /** 宿主能不能走后端无关的 render（外置渲染时为 true） */
  hostCanRender,
  /** 拿宿主的 render 服务（没有就 null） */
  get hostRenderService () { return hostCanRender() ? hostRenderer : null }
}
