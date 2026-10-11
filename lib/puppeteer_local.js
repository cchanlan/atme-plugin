import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import YAML from 'yaml'
import { configDir } from '../components/paths.js'

/**
 * 出图统一走 Yunzai 自带的那份 chromium。
 *
 * 云崽本来就常驻一个浏览器实例给所有插件出图用，它自己管着断线重连和用满一定次数
 * 后的重启。插件再单独 launch 一份，等于凭空多占几十到几百 MB，而且那份的生死
 * 全靠插件自己兜 —— 一旦漏掉就永远留在系统里。所以这里只借宿主的实例开新页面。
 *
 * 只有一种情况借不到：用户把渲染后端换成了非 puppeteer 的实现（它没有 browser
 * 可借）。那时才退回自己启动，并带上空闲自动关闭，不让进程白占内存。
 */
let hostRenderer = null
try {
  hostRenderer = (await import('../../../lib/puppeteer/puppeteer.js')).default
} catch (err) {
  // 宿主路径变了或加载失败，走下面的自启动兜底
  hostRenderer = null
}

/** 宿主渲染后端能不能借浏览器：换成非 puppeteer 的渲染器时这两个属性就没有 */
function hostUsable () {
  return typeof hostRenderer?.browserInit === 'function' && 'browser' in hostRenderer
}

/**
 * 判断是不是真正能用的 puppeteer Browser 实例。
 *
 * 宿主的 renderer.browser 是个「多值哨兵」字段，不是保证为实例：
 *   - 未初始化 / 已关闭 / 重启窗口期 → false
 *   - 启动失败 → undefined
 * 而 `b?.isConnected()` 的可选链只对 null/undefined 短路，
 * 碰到 false 或其它真值非实例对象就会直接抛 "is not a function"。
 * 所以凡是拿到 browser 的地方，都必须先用这里校验，再决定要不要重新初始化。
 */
function isBrowser (b) {
  return !!b && typeof b.isConnected === 'function' && typeof b.newPage === 'function'
}

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
 *
 * 跟着配置文件的 mtime 走，改完不用重启 —— 与插件其余部分读配置的方式一致。
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
  // 这个定时器不该拖着 Node 不让退出
  idleTimer.unref?.()
}

/**
 * 关掉自启动的浏览器。宿主的实例不归插件管，一律不碰。
 *
 * close() 之外必须留一手 SIGKILL：--single-process 下页面一崩就会把整条 CDP 通道
 * 带走，这时 close() 的 Browser.close 命令根本发不出去，只 catch 掉的话 chromium
 * 进程会留在系统里 —— 一个几十 MB，跑上几天能攒出好几百 MB 谁也回收不了。
 */
async function closeBrowser () {
  cancelIdleClose()
  const b = ownBrowser
  ownBrowser = null
  if (!isBrowser(b)) return
  const proc = b.process()
  try {
    await b.close()
  } catch {}
  if (proc && proc.exitCode === null) {
    try { proc.kill('SIGKILL') } catch {}
  }
}

/** 兜底路径：自己启动一份 chromium */
async function ownInit () {
  if (isBrowser(ownBrowser) && ownBrowser.isConnected()) return ownBrowser
  if (ownPromise) return ownPromise

  ownPromise = (async () => {
    try {
      if (ownBrowser) await closeBrowser()

      // 只在拿不到宿主实例时才会走到这里（TRSS 的 RendererLoader、或用户换了
      // 非 puppeteer 的渲染后端）。宿主装的不一定是 `puppeteer`，也可能只有
      // `puppeteer-core` —— 两个都试一遍，都不行就给一句人话提示。
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
          '借不到宿主的浏览器，自己启动又没有可用的 puppeteer。' +
          '请确认 Yunzai 的渲染功能正常（首次启动会自动准备浏览器），' +
          '或在插件目录执行 pnpm add puppeteer 后重启'
        )
      }

      const launched = await puppeteer.launch({
        headless: 'new',
        args: [
          // 这三个只在 Linux 下有意义；Windows/macOS 上传了也无害
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      })
      ownBrowser = launched
      // 返回值不能少：并发进来的调用者拿到的就是这个 Promise
      return launched
    } finally {
      ownPromise = null
    }
  })()

  return ownPromise
}

/**
 * 初始化浏览器：优先让宿主把它那份准备好，宿主借不到才自己启动。
 * @returns {Promise<Browser|false>}
 */
async function browserInit () {
  if (hostUsable()) {
    const b = await hostRenderer.browserInit()
    if (isBrowser(b)) return b
    // 宿主正在启动中（内部有锁）会返回 false，等一下再取一次
    await new Promise(r => setTimeout(r, 1000))
    if (isBrowser(hostRenderer.browser)) return hostRenderer.browser
  }
  return ownInit()
}

/**
 * 确保浏览器可用，并把这次出图登记为「进行中」。
 *
 * 调用方**必须**在 finally 里配一次 releaseBrowser()，否则计数配不平，
 * 自启动兜底的那份就再没有关闭时机 —— 会退回到一直常驻的老样子。
 * @returns {Promise<Browser|false>}
 */
async function ensureBrowser () {
  activeTasks++
  // 先撤掉待关闭的定时器：它可能正好在这张图要用实例的当口把浏览器关掉
  cancelIdleClose()
  const b = getBrowser()
  // 拿到的是真值但不是 Browser 实例时打一条诊断，方便下次一眼看出宿主塞了什么进来
  if (b && !isBrowser(b)) {
    logger.warn(
      `[Atme-Plugin] 当前 browser 不是有效实例（typeof=${typeof b}, 值=${String(b).slice(0, 60)}），将重新初始化`
    )
  }
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
  const proc = ownBrowser?.process()
  if (proc && proc.exitCode === null) {
    try { proc.kill('SIGKILL') } catch {}
  }
})

export default {
  get browser () { return getBrowser() },
  browserInit,
  ensureBrowser,
  releaseBrowser,
  closeBrowser
}
