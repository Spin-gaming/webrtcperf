import {
  Browser,
  computeExecutablePath,
  getInstalledBrowsers,
  getVersionComparator,
  install,
} from '@puppeteer/browsers'
import { spawn } from 'child_process'
import axios from 'axios'
import { createHash } from 'crypto'
import * as dns from 'dns'
import FormData from 'form-data'
import fs, { WriteStream, createWriteStream } from 'fs'
import { Agent } from 'https'
import * as ipaddrJs from 'ipaddr.js'
import net from 'net'
import NodeCache from 'node-cache'
import * as OSUtils from 'node-os-utils'
import os, { networkInterfaces } from 'os'
import path, { dirname } from 'path'
import pidtree from 'pidtree'
import pidusage from 'pidusage'
import puppeteer, { Page } from 'puppeteer-core'

import { Session } from './session'

// eslint-disable-next-line
const ps = require('pidusage/lib/ps')

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const { Log } = require('debug-level')

interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
}

export function logger(name: string, options = {}): Logger {
  return new Log(name, { splitLine: false, ...options })
}

export class LoggerInterface {
  name?: string

  private logInit(args: unknown[]): void {
    if (this.name) {
      args.unshift(`[${this.name}]`)
    }
  }

  debug(...args: unknown[]): void {
    this.logInit(args)
    log.debug(...args)
  }

  info(...args: unknown[]): void {
    this.logInit(args)
    log.info(...args)
  }

  warn(...args: unknown[]): void {
    this.logInit(args)
    log.warn(...args)
  }

  error(...args: unknown[]): void {
    this.logInit(args)
    log.error(...args)
  }

  log(...args: unknown[]): void {
    this.logInit(args)
    log.log(...args)
  }
}

const log = logger('webrtcperf:utils')

/**
 * Resolves the absolute path from the package installation directory.
 * @param relativePath The relative path.
 * @returns The absolute path.
 */
export function resolvePackagePath(relativePath: string): string {
  if ('__nexe' in process) {
    return relativePath
  }
  if (process.env.WEBPACK) {
    return path.join(path.dirname(__filename), relativePath)
  }
  for (const d of ['..', '../..']) {
    const p = path.join(__dirname, d, relativePath)
    if (fs.existsSync(p)) {
      return require.resolve(p)
    }
  }
  throw new Error(`resolvePackagePath: ${relativePath} not found`)
}

/**
 * Calculates the sha256 sum.
 * @param data The string input
 */
export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

const ProcessStatsCache = new NodeCache({ stdTTL: 5, checkperiod: 10 })
const ProcessChildrenCache = new NodeCache({ stdTTL: 15, checkperiod: 15 })

interface ProcessStat {
  cpu: number
  memory: number
}

/**
 * Returns the process stats.
 * @param pid The process pid
 * @param children If process children should be taken into account.
 * @returns
 */
export async function getProcessStats(pid = 0, children = false): Promise<ProcessStat> {
  const processPid = pid || process.pid
  let stat: ProcessStat | undefined = ProcessStatsCache.get(processPid)
  if (stat) {
    return stat
  }

  const pidStats = await pidusage(processPid)
  if (pidStats) {
    stat = {
      cpu: pidStats.cpu,
      memory: pidStats.memory / 1e6,
    }
  } else {
    stat = { cpu: 0, memory: 0 }
  }

  if (children) {
    try {
      let childrenPids: number[] | undefined = ProcessChildrenCache.get(processPid)
      if (!childrenPids?.length) {
        childrenPids = await pidtree(processPid)
        if (childrenPids?.length) {
          ProcessChildrenCache.set(processPid, childrenPids)
        }
      }
      if (childrenPids?.length) {
        const pidStats = await pidusage(childrenPids)
        for (const p of childrenPids) {
          if (pidStats[p]) {
            stat.cpu += pidStats[p].cpu
            stat.memory += pidStats[p].memory / 1e6
          }
        }
      }
    } catch (err) {
      log.error(`getProcessStats children error: ${(err as Error).stack}`)
    }
  }
  ProcessStatsCache.set(processPid, stat)
  return stat
}

// Socket stats.
interface SocketStat {
  recvBytes: number
  sendBytes: number
}

export async function getSocketStats(processPid: number): Promise<SocketStat> {
  const stats: SocketStat = { recvBytes: 0, sendBytes: 0 }
  try {
    const { stdout } = await runShellCommand(`ss -nOHpti | { grep pid=${processPid} || true; }`)
    for (const { groups } of stdout.matchAll(/bytes_sent:(?<sendBytes>\d+).+bytes_received:(?<recvBytes>\d+)/g)) {
      if (!groups) continue
      const recvBytes = parseInt(groups.recvBytes)
      const sendBytes = parseInt(groups.sendBytes)
      stats.recvBytes += recvBytes
      stats.sendBytes += sendBytes
    }
  } catch (err) {
    log.error(`socketStats error: ${(err as Error).stack}`)
  }
  return stats
}

// System stats.
const SystemStatsCache = new NodeCache({ stdTTL: 30, checkperiod: 60 })

export interface SystemStats {
  usedCpu: number
  usedMemory: number
  usedGpu: number
  usedGpuMemory: number
}

async function updateSystemStats(): Promise<void> {
  const [cpu, memInfo, gpuStats] = await Promise.all([OSUtils.cpu.free(10000), OSUtils.mem.info(), systemGpuStats()])
  const stat = {
    usedCpu: 100 - cpu,
    usedMemory: 100 - memInfo.freeMemPercentage,
    usedGpu: gpuStats.gpu,
    usedGpuMemory: gpuStats.mem,
  }
  SystemStatsCache.set('default', stat)
}

let systemStatsInterval: NodeJS.Timeout | null = null

export function getSystemStats(): SystemStats | undefined {
  if (!systemStatsInterval) {
    startUpdateSystemStats()
  }
  return SystemStatsCache.get<SystemStats>('default')
}

export function startUpdateSystemStats(): void {
  if (systemStatsInterval) {
    return
  }
  systemStatsInterval = setInterval(updateSystemStats, 5000)
}

export function stopTimers(): void {
  if (systemStatsInterval) {
    clearInterval(systemStatsInterval)
    systemStatsInterval = null
  }
}

/**
 * Sleeps for the specified amount of time.
 * @param ms
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(() => resolve(), ms))
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getActiveAudioTracks: () => any[]
  let publisherSetMuted: (muted: boolean) => Promise<void>
}

let randomActivateAudioTimeoutId: NodeJS.Timeout | null = null
let randomActivateAudioRunning = false

export function startRandomActivateAudio(
  sessions: Map<number, Session>,
  randomAudioPeriod: number,
  randomAudioProbability: number,
  randomAudioRange: number,
): void {
  if (randomActivateAudioRunning) return
  randomActivateAudioRunning = true
  void randomActivateAudio(sessions, randomAudioPeriod, randomAudioProbability, randomAudioRange)
}

export function stopRandomActivateAudio(): void {
  randomActivateAudioRunning = false
  if (randomActivateAudioTimeoutId) clearTimeout(randomActivateAudioTimeoutId)
}

/**
 * Randomly activate audio from one tab at time.
 * @param sessions The sessions Map
 * @param randomAudioPeriod If set, the function will be called in loop
 * @param randomAudioProbability The activation probability
 * @param randomAudioRange The number of pages to include into the automation
 */
export async function randomActivateAudio(
  sessions: Map<number, Session>,
  randomAudioPeriod: number,
  randomAudioProbability: number,
  randomAudioRange: number,
): Promise<void> {
  if (!randomAudioPeriod || !randomActivateAudioRunning) {
    return
  }
  try {
    let pages: (Page | null)[] = []
    for (const session of sessions.values()) {
      const sessionPages = [...session.pages.values()]
      if (randomAudioRange) {
        if (session.id > randomAudioRange) {
          break
        }
        sessionPages.splice(randomAudioRange - session.id)
      }
      pages = pages.concat(sessionPages)
    }
    // Remove pages with not audio tracks.
    for (const [i, page] of pages.entries()) {
      if (!page) {
        continue
      }
      let active = 0
      try {
        active = await page.evaluate(() => getActiveAudioTracks().length)
      } catch (err) {
        log.error(`randomActivateAudio error: ${(err as Error).stack}`)
      }
      if (!active) {
        pages[i] = null
      }
    }
    const pagesWithAudio: Page[] = pages.filter(p => !!p)
    //
    const index = Math.floor(Math.random() * pagesWithAudio.length)
    const enable = Math.round(100 * Math.random()) <= randomAudioProbability
    log.debug('randomActivateAudio %j', {
      pages: pagesWithAudio.length,
      randomAudioProbability,
      index,
      enable,
    })
    for (const [i, page] of pagesWithAudio.entries()) {
      try {
        if (i === index) {
          log.debug(`Changing audio in page ${i + 1}/${pagesWithAudio.length} (enable: ${enable})`)
          await page.evaluate(async enable => {
            if (typeof publisherSetMuted !== 'undefined') {
              await publisherSetMuted(!enable)
            } else {
              getActiveAudioTracks().forEach(track => {
                track.enabled = enable
                // track.dispatchEvent(new Event('custom-enabled'));
              })
            }
          }, enable)
        } else {
          await page.evaluate(async () => {
            if (typeof publisherSetMuted !== 'undefined') {
              await publisherSetMuted(true)
            } else {
              getActiveAudioTracks().forEach(track => {
                track.enabled = false
                // track.dispatchEvent(new Event('custom-enabled'));
              })
            }
          })
        }
      } catch (err) {
        log.error(`randomActivateAudio in page ${i + 1}/${pagesWithAudio.length} error: ${(err as Error).stack}`)
      }
    }
  } catch (err) {
    log.error(`randomActivateAudio error: ${(err as Error).stack}`)
  } finally {
    if (randomActivateAudioRunning) {
      const nextTime = randomAudioPeriod * (1 + Math.random())
      if (randomActivateAudioTimeoutId) clearTimeout(randomActivateAudioTimeoutId)
      randomActivateAudioTimeoutId = setTimeout(
        randomActivateAudio,
        nextTime * 1000,
        sessions,
        randomAudioPeriod,
        randomAudioProbability,
        randomAudioRange,
      )
    }
  }
}

/**
 * The {@link downloadUrl} output.
 */
export interface DownloadData {
  /** Download data. */
  data: string
  /** Start byte range. */
  start: number
  /** End byte range. */
  end: number
  /** Total returned size. */
  total: number
}

/**
 * Downloads the specified `url` to a local file or returning the file content
 * as {@link DownloadData} object.
 * @param url The remote url to download.
 * @param auth The basic authentication (`user:password`).
 * @param outputLocationPath The file output. If not specified, the download
 * content will be returned as {@link DownloadData} instance.
 * @param range The HTTP byte range to download (e.g. `10-100`).
 * @param timeout The download timeout in milliseconds.
 */
export async function downloadUrl(
  url: string,
  auth?: string,
  outputLocationPath?: string,
  range?: string,
  timeout = 60000,
): Promise<void | DownloadData> {
  log.debug(`downloadUrl url=${url} ${outputLocationPath}`)
  const authParts = auth?.split(':')
  let writer: WriteStream | null = null
  if (outputLocationPath) {
    await fs.promises.mkdir(dirname(outputLocationPath), {
      recursive: true,
    })
    writer = createWriteStream(outputLocationPath)
  }
  const response = await axios({
    method: 'get',
    url,
    auth: authParts
      ? {
          username: authParts[0],
          password: authParts[1],
        }
      : undefined,
    headers: range
      ? {
          Range: `bytes=${range}`,
        }
      : undefined,
    timeout,
    onDownloadProgress: event => {
      log.debug(`downloadUrl fileUrl=${url} progress=${event.progress || event.bytes}`)
    },
    httpsAgent: new Agent({
      rejectUnauthorized: false,
    }),
    responseType: writer ? 'stream' : 'text',
  })
  if (writer) {
    return new Promise((resolve, reject) => {
      if (!writer) {
        return
      }
      response.data.pipe(writer)
      let error: Error | null = null
      writer.on('error', err => {
        error = err
        if (writer) writer.close()
        reject(err)
      })
      writer.on('close', () => {
        if (!error) {
          resolve()
        }
      })
    })
  } else {
    /* log.debug(`downloadUrl ${response.data.length} bytes, headers=${
      JSON.stringify(response.headers)}`); */
    let start = 0
    let end = 0
    let total = 0
    if (response.headers['content-range']) {
      log.debug(`downloadUrl ${response.data.length} bytes, content-range=${response.headers['content-range']}`)
      const contentRange = response.headers['content-range'].split('/')
      const rangeParts = contentRange[0].split('-')
      total = parseInt(contentRange[1])
      if (rangeParts.length === 2) {
        start = parseInt(rangeParts[0])
        end = parseInt(rangeParts[1])
      } else if (contentRange[0].startsWith('-')) {
        end = parseInt(rangeParts[0])
      } else if (contentRange[0].endsWith('-')) {
        start = parseInt(rangeParts[0])
        end = total
      }
    }
    return {
      data: response.data,
      start,
      end,
      total,
    }
  }
}

/**
 * Uploads the file to the specified `url`.
 * @param filePath The file path to upload.
 * @param url The remote url to upload.
 * @param auth The basic authentication (`user:password`).
 */
export async function uploadUrl(filePath: string, url: string, auth?: string): Promise<string> {
  log.debug(`uploadUrl ${filePath} to ${url}`)
  const authParts = auth?.split(':')
  const formData = new FormData()
  formData.append('file', fs.createReadStream(filePath))
  const response = await axios({
    method: 'post',
    url,
    auth: authParts
      ? {
          username: authParts[0],
          password: authParts[1],
        }
      : undefined,
    headers: formData.getHeaders(),
    timeout: 3600 * 1000,
    httpsAgent: new Agent({
      rejectUnauthorized: false,
    }),
    responseType: 'text',
    data: formData,
  })
  return response.data as string
}

const HideAuthRegExp = new RegExp('(http[s]{0,1}://)(.+?:.+?@)', 'g')

/**
 * Hides the authentication part from an HTTP url.
 * @param data
 */
export function hideAuth(data: string): string {
  if (!data) {
    return data
  }
  return data.replace(HideAuthRegExp, '$1')
}

/** Exit handler callback. */
export type ExitHandler = (signal?: string) => Promise<void>

const exitHandlers = new Set<ExitHandler>()

/**
 * Register an {@link ExitHandler} callback that will be executed at the
 * nodejs process exit.
 * @param exitHandler
 */
export function registerExitHandler(exitHandler: ExitHandler): void {
  exitHandlers.add(exitHandler)
}

/**
 * Un-registers the {@link ExitHandler} callback.
 * @param exitHandler
 */
export function unregisterExitHandler(exitHandler: ExitHandler): void {
  exitHandlers.delete(exitHandler)
}

const runExitHandlers = async (signal?: string): Promise<void> => {
  let i = 0
  for (const exitHandler of exitHandlers.values()) {
    const id = `${i + 1}/${exitHandlers.size}`
    log.debug(`running exitHandler ${id}`)
    try {
      await exitHandler(signal)
      log.debug(`  exitHandler ${id} done`)
    } catch (err) {
      log.error(`exitHandler ${id} error: ${err}`)
    }
    i++
  }
  exitHandlers.clear()
}

let runExitHandlersPromise: Promise<void> | null = null

/**
 * Runs the registered exit handlers immediately.
 * @param signal The process exit signal.
 */
export async function runExitHandlersNow(signal?: string): Promise<void> {
  if (!runExitHandlersPromise) {
    runExitHandlersPromise = runExitHandlers(signal)
  }
  await runExitHandlersPromise
  stopTimers()
}

const SIGNALS = [
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGUSR1',
  'SIGSEGV',
  'SIGUSR2',
  'SIGTERM',
]
process.setMaxListeners(process.getMaxListeners() + SIGNALS.length)
SIGNALS.forEach(event =>
  process.once(event, async signal => {
    if (signal instanceof Error) {
      log.error(`Exit on error: ${signal.stack || signal.message}`)
    } else {
      log.debug(`Exit on signal: ${signal}`)
    }
    await runExitHandlersNow(signal)
    process.exit(0)
  }),
)

/**
 * Downloads the configured chrome executable if it doesn't exists into the
 * `$HOME/.webrtcperf/chrome` directory.
 * @returns The revision info.
 */
export async function checkChromeExecutable(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadConfig } = require('./config')
  const config = loadConfig()
  const cacheDir = path.join(os.homedir(), '.webrtcperf/chrome')

  const fixSemVer = (v: string) => v.split('.').slice(0, 3).join('.')

  const browsers = await getInstalledBrowsers({ cacheDir })
  const revisions = browsers.map(b => fixSemVer(b.buildId))
  const browser = Browser.CHROME
  revisions.sort(getVersionComparator(browser))
  log.debug(`Available chrome versions: ${revisions}`)
  const requiredRevision = config.chromiumVersion
  if (!requiredRevision) throw new Error('Chromium version not set')
  if (!revisions.includes(fixSemVer(requiredRevision))) {
    log.info(`Downloading chrome ${requiredRevision}...`)
    let progress = 0
    await install({
      browser,
      buildId: requiredRevision,
      cacheDir,
      downloadProgressCallback: (downloadedBytes, totalBytes) => {
        const cur = Math.round((100 * downloadedBytes) / totalBytes)
        if (cur - progress > 1) {
          progress = cur
          log.info(`  ${progress}%`)
        }
      },
    })
    log.info(`Downloading chrome ${requiredRevision} done.`)
  }
  return computeExecutablePath({
    browser,
    cacheDir,
    buildId: requiredRevision,
  })
}

export function clampMinMax(value: number, min: number, max: number): number {
  return Math.max(Math.min(value, max), min)
}

/** Runs the shell command asynchronously. */
export async function runShellCommand(
  cmd: string,
  verbose = false,
  maxBuffer = 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  if (verbose) log.debug(`runShellCommand cmd: ${cmd}`)
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', data => {
      if (maxBuffer && stdout.length > maxBuffer) {
        stdout = stdout.slice(data.length)
      }
      stdout += data
    })
    p.stderr.on('data', data => {
      if (maxBuffer && stderr.length > maxBuffer) {
        stderr = stderr.slice(data.length)
      }
      stderr += data
    })
    p.once('error', err => reject(err))
    p.once('close', code => {
      if (code !== 0) {
        reject(new Error(`runShellCommand cmd: ${cmd} failed with code ${code}: ${stderr}`))
      } else {
        if (verbose) log.debug(`runShellCommand cmd: ${cmd} done`, { stdout, stderr })
        resolve({ stdout, stderr })
      }
    })
  })
}

//
const ipCache = new Map<string, { host: string; timestamp: number }>()

/**
 * Resolves the IP address hostname.
 * @param ip The IP address.
 * @param cacheTime The number of milliseconds to keep the resolved hostname
 * into the memory cache.
 * @returns The IP address hostname.
 */
export async function resolveIP(ip: string, cacheTime = 60 * 60 * 1000): Promise<string> {
  if (!ip) return ''
  if (ipaddrJs.parse(ip).range() === 'private') {
    return ip
  }
  const timestamp = Date.now()
  const ret = ipCache.get(ip)
  if (!ret || timestamp - ret.timestamp > cacheTime) {
    const host = await Promise.race([
      sleep(1000),
      dns.promises
        .reverse(ip)
        .then(hosts => {
          if (hosts.length) {
            log.debug(`resolveIP ${ip} -> ${hosts.join(', ')}`)
            ipCache.set(ip, {
              host: hosts[0],
              // Keep the value for 10 min.
              timestamp: timestamp + 10 * cacheTime,
            })
            return hosts[0]
          } else {
            ipCache.set(ip, { host: ip, timestamp })
            return ip
          }
        })
        .catch(err => {
          log.debug(`resolveIP error: ${(err as Error).stack}`)
          ipCache.set(ip, { host: ip, timestamp })
        }),
    ])
    return host || ip
  }
  return ret?.host || ip
}

/**
 * Strips the console logs characters from the provided string.
 * @param str The input string.
 * @returns The strippped string.
 */
export function stripColors(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B[[(?);]{0,2}(;?\d)*./g, '')
}

const nvidiaGpuPresent = fs.existsSync('/usr/bin/nvidia-smi') && fs.existsSync('/dev/dri')

const macOS = process.platform === 'darwin' && fs.existsSync('/usr/sbin/ioreg')

/**
 * Returns the GPU usage.
 *
 * On Linux, the `nvidia-smi` should be installed if Nvidia card is used.
 * @returns The GPU usage.
 */
export async function systemGpuStats(): Promise<{ gpu: number; mem: number }> {
  try {
    if (nvidiaGpuPresent) {
      const { stdout } = await runShellCommand('nvidia-smi --query-gpu=utilization.gpu,utilization.memory --format=csv')
      const line = stdout.split('\n')[1].trim()
      const [gpu, mem] = line.split(',').map(s => parseFloat(s.replace(' %', '')))
      return { gpu, mem }
    } else if (macOS) {
      const { stdout } = await runShellCommand('ioreg -r -d 1 -w 0 -c IOAccelerator | grep PerformanceStatistics\\"')
      const stats = JSON.parse(stdout.trim().split(' = ')[1].replace(/=/g, ':'))
      const gpu = stats['Device Utilization %'] || stats['GPU Activity(%)'] || 0
      return { gpu, mem: 0 }
    }
  } catch (err) {
    log.debug(`systemGpuStats error: ${(err as Error).stack}`)
  }
  return { gpu: 0, mem: 0 }
}

/**
 * Schedules a function call at the specified time interval.
 */
export class Scheduler {
  private readonly name: string
  private readonly interval: number
  private readonly callback: (now: number) => Promise<void>
  private readonly verbose: boolean

  private running = false
  private last = 0
  private errorSum = 0
  private statsTimeoutId?: NodeJS.Timeout

  /**
   * Scheduler.
   * @param name Logging name.
   * @param interval Update interval in seconds.
   * @param callback Callback function.
   * @param verbose Verbose logging.
   */
  constructor(name: string, interval: number, callback: (now: number) => Promise<void>, verbose = false) {
    this.name = name
    this.interval = interval * 1000
    this.callback = callback
    this.verbose = verbose
    log.debug(`[${this.name}-scheduler] constructor interval=${this.interval}ms`)
  }

  start(): void {
    log.debug(`[${this.name}-scheduler] start`)
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    log.debug(`[${this.name}-scheduler] stop`)
    this.running = false
    if (this.statsTimeoutId) {
      clearTimeout(this.statsTimeoutId)
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return
    }
    const now = Date.now()
    if (this.last) {
      this.errorSum += clampMinMax(now - this.last - this.interval, -this.interval, this.interval)
      if (this.verbose) {
        log.debug(`[${this.name}-scheduler] last=${now - this.last}ms drift=${this.errorSum}ms`)
      }
    }
    this.last = now
    this.statsTimeoutId = setTimeout(
      async () => {
        try {
          const now = Date.now()
          await this.callback(now)
          const elapsed = Date.now() - now
          if (elapsed > this.interval) {
            log.warn(`[${this.name}-scheduler] callback elapsed=${elapsed}ms > ${this.interval}ms`)
          } else if (this.verbose) {
            log.debug(`[${this.name}-scheduler] callback elapsed=${elapsed}ms`)
          }
        } catch (err) {
          log.error(`[${this.name}-scheduler] callback error: ${(err as Error).stack}`, err)
        } finally {
          this.scheduleNext()
        }
      },
      this.interval - this.errorSum / 2,
    )
  }
}

//
export class PeerConnectionExternal {
  public id: number
  private process
  private static cache = new Map<number, PeerConnectionExternal>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(options?: any) {
    this.process = spawn('sleep', ['600'])
    this.id = this.process.pid || -1
    log.debug(`PeerConnectionExternal contructor: ${this.id}`, options)
    PeerConnectionExternal.cache.set(this.id, this)

    this.process.stdout.on('data', data => {
      log.debug(`PeerConnectionExternal stdout: ${data}`)
    })

    this.process.stderr.on('data', data => {
      log.debug(`PeerConnectionExternal stderr: ${data}`)
    })

    this.process.on('close', code => {
      log.debug(`PeerConnectionExternal process exited with code ${code}`)
      PeerConnectionExternal.cache.delete(this.id)
    })
  }

  static get(id: number): PeerConnectionExternal | undefined {
    return PeerConnectionExternal.cache.get(id)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createOffer(options: any) {
    log.debug(`PeerConnectionExternal createOffer`, { options })
    return {}
  }

  setLocalDescription(description: string) {
    log.debug(`PeerConnectionExternal setLocalDescription`, description)
  }

  setRemoteDescription(description: string) {
    log.debug(`PeerConnectionExternal setRemoteDescription`, description)
  }
}

export type PeerConnectionExternalMethod = 'createOffer' | 'setLocalDescription' | 'setRemoteDescription'

export function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export async function getFiles(dir: string, ext: string): Promise<string[]> {
  const dirs = await fs.promises.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    dirs.map(entry => {
      const res = path.resolve(dir, entry.name)
      return entry.isDirectory() ? getFiles(res, ext) : res
    }),
  )
  return Array.prototype.concat(...files).filter(f => f.endsWith(ext))
}

/**
 * Format number to the specified precision.
 * @param value value to format
 * @param precision precision
 */
export function toPrecision(value: number, precision = 3): string {
  return (Math.round(value * 10 ** precision) / 10 ** precision).toFixed(precision)
}

export async function getDefaultNetworkInterface(): Promise<string> {
  const { stdout } = await runShellCommand(`ip route | awk '/default/ {print $5; exit}' | tr -d ''`)
  return stdout.trim()
}

export async function checkNetworkInterface(device: string): Promise<void> {
  await runShellCommand(`ip route | grep -q "dev ${device}"`)
}

export async function portForwarder(port: number, listenInterface?: string) {
  if (!listenInterface) {
    listenInterface = await getDefaultNetworkInterface()
  }
  const controller = new AbortController()
  Object.entries(networkInterfaces()).forEach(([iface, nets]) => {
    if (listenInterface !== '0.0.0.0' && iface !== listenInterface) return
    if (!nets) return
    for (const n of nets) {
      if (n.internal || n.address === '127.0.0.1' || n.family !== 'IPv4') {
        continue
      }
      const msg = `portForwarder on ${iface} (${n.address}:${port})`
      const server = net
        .createServer(from => {
          const to = net.createConnection({ host: '127.0.0.1', port })
          from.once('error', err => {
            log.error(`${msg} error: ${err.stack}`)
            to.destroy()
          })
          to.once('error', err => {
            log.error(`${msg} error: ${err.stack}`)
            from.destroy()
          })
          from.pipe(to)
          to.pipe(from)
        })
        .listen({ port, host: n.address, signal: controller.signal })
      server.on('listening', () => {
        log.debug(`${msg} listening`)
      })
      server.once('error', err => {
        log.error(`${msg} error: ${err.stack}`)
      })
    }
  })

  return () => {
    log.debug(`portForwarder on port ${port} stop`)
    controller.abort()
  }
}

export async function pageScreenshot(
  url: string,
  filePath: string,
  width = 1920,
  height = 1024,
  selector = 'body',
  headers?: Record<string, string>,
  extraCss?: string,
): Promise<void> {
  log.debug(`pageScreenshot ${url} -> ${filePath}`)
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  let executablePath = process.env.CHROMIUM_PATH
  if (!executablePath || !fs.existsSync(executablePath)) {
    executablePath = await checkChromeExecutable()
  }
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: {
      width,
      height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isLandscape: false,
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      //'--remote-debugging-port=9222',
    ],
  })
  const page = await browser.newPage()
  if (headers) {
    await page.setExtraHTTPHeaders(headers)
  }
  if (extraCss) {
    await page.evaluateOnNewDocument((css: string) => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style')
        style.setAttribute('id', 'webrtcperf-extra-style')
        style.setAttribute('type', 'text/css')
        style.innerHTML = css
        document.head.appendChild(style)
      })
    }, extraCss)
  }
  await page.goto(url, {
    waitUntil: ['domcontentloaded', 'networkidle0'],
    timeout: 60 * 1000,
  })
  try {
    const element = await page.waitForSelector(selector, {
      visible: true,
      timeout: 15 * 1000,
    })
    if (!element) {
      throw new Error(`pageScreenshot selector "${selector}" not found`)
    }
    await element.screenshot({ path: filePath })
  } catch (err) {
    log.error(`pageScreenshot error: ${(err as Error).message}`)
  } finally {
    await page.close()
    await browser.close()
  }
}

export function enabledForSession(index: number, value: boolean | string | number): boolean {
  if (value === true || value === 'true') {
    return true
  } else if (value === false || value === 'false' || value === undefined) {
    return false
  } else if (typeof value === 'string') {
    if (value.includes('-')) {
      const [start, end] = value.split('-').map(s => parseInt(s))
      if (isFinite(start) && index < start) {
        return false
      }
      if (isFinite(end) && index > end) {
        return false
      }
      return true
    } else {
      const indexes = value
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length)
        .map(s => parseInt(s))
      return indexes.includes(index)
    }
  } else if (index === value) {
    return true
  }
  return false
}

export function increaseKey(o: Record<string, number>, key: string, value?: number): void {
  if (value === undefined || !isFinite(value)) return
  if (o[key] === undefined) {
    o[key] = 0
  }
  o[key] += value
}

export async function chunkedPromiseAll<T, R>(
  items: T[],
  f: (v: T, index: number) => Promise<R>,
  chunkSize = 1,
): Promise<R[]> {
  const results = Array<R>(items.length)
  for (let index = 0; index < items.length; index += chunkSize) {
    await Promise.allSettled(
      items.slice(index, index + chunkSize).map(async (item, i) => {
        const res = await f(item, index + i)
        if (res !== undefined) results[index + i] = res
      }),
    )
  }
  return results
}

export function maybeNumber(s: string): string | number {
  const n = parseFloat(s)
  return !isNaN(n) ? n : s
}

export enum FFProbeProcess {
  Skip = 'skip',
  Stop = 'stop',
}

/**
 * It runs the ffprobe command to extract the video/video frames.
 * @param fpath The file path.
 * @param kind The kind of the media (video or audio).
 * @param entries Which entries to show.
 * @param filters Apply filters.
 * @param frameProcess A function to process the frame. The function return value could be:
 *   - the modified frame object
 *   - `FFProbeProcess.Skip` to skip the frame from the output
 *   - `FFProbeProcess.Stop` to stop processing and immediately return the collected frames.
 */
export async function ffprobe(
  fpath: string,
  kind = 'video',
  entries = '',
  filters = '',
  frameProcess?: (_frame: Record<string, string>) => Record<string, string> | FFProbeProcess,
): Promise<Record<string, string>[]> {
  const cmd = `\
exec ffprobe -loglevel error ${kind === 'video' ? '-select_streams v' : ''} -show_frames -print_format compact \
${entries ? `-show_entries ${entries}` : ''} \
-f lavfi -i '${kind === 'video' ? '' : 'a'}movie=${fpath}${filters ? `,${filters}` : ''}'`
  const frames = [] as Record<string, string>[]
  let stderr = ''
  let stopProcessing = false
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    p.stdout.on('data', data => {
      if (stopProcessing) return
      const frame = data
        .toString()
        .split('|')
        .reduce(
          (prev: Record<string, string>, cur: string) => {
            const [key, value] = cur.split('=')
            if (value && !key.startsWith('side_datum')) {
              prev[key.replace(/[:.]/g, '_')] = value
            }
            return prev
          },
          {} as Record<string, string>,
        )
      if (frameProcess) {
        const newFrame = frameProcess(frame)
        if (newFrame === FFProbeProcess.Skip) {
          // Skip the frame.
        } else if (newFrame === FFProbeProcess.Stop) {
          stopProcessing = true
          p.kill('SIGINT')
        } else {
          frames.push(newFrame)
        }
      } else {
        frames.push(frame)
      }
    })
    p.stderr.on('data', data => {
      stderr += data
    })
    p.once('error', err => reject(err))
    p.once('close', code => {
      if (code !== 0 && !stopProcessing) {
        reject(new Error(`${cmd} failed with code ${code}: ${stderr}`))
      } else {
        resolve(frames)
      }
    })
  })
}

export function buildIvfHeader(width = 1920, height = 1080, frameRate = 30, fourcc = 'MJPG') {
  const buffer = Buffer.alloc(32)
  buffer.write('DKIF', 0, 'utf8')
  buffer.writeUint16LE(0, 4) // version
  buffer.writeUint16LE(32, 6) // header size
  buffer.write(fourcc, 8, 'utf8')
  buffer.writeUint16LE(width, 12)
  buffer.writeUint16LE(height, 14)
  buffer.writeUint32LE(frameRate, 16)
  buffer.writeUint32LE(1, 20)
  buffer.writeUint32LE(0, 24) // frame count
  buffer.writeUint32LE(0, 28) // unused
  return buffer
}

export async function ffmpeg(command = 'video', processFn: (_frame: Buffer) => void): Promise<void> {
  const port = 10000 + Math.floor(Math.random() * 10000)
  const cmd = `exec ffmpeg -hide_banner -loglevel warning ${command} zmq:tcp://127.0.0.1:${port}`
  log.debug(`${cmd}`)
  let stderr = ''

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zmq = require('zeromq')
  const sub = new zmq.Subscriber()
  const p = spawn(cmd, {
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  p.stderr.on('data', data => {
    stderr += data
  })
  p.once('error', err => {
    sub.close()
    throw err
  })
  p.once('close', code => {
    sub.close()
    if (code !== 0) {
      throw new Error(`${cmd} failed with code ${code}: ${stderr}`)
    }
  })
  sub.connect(`tcp://127.0.0.1:${port}`)
  sub.subscribe('')
  for await (const [msg] of sub) {
    await processFn(msg)
  }
  sub.close()
}

export async function analyzeColors(fpath: string) {
  let Y = 0
  let U = 0
  let V = 0
  let SAT = 0
  let HUE = 0
  let count = 0
  await ffprobe(
    fpath,
    'video',
    'frame=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG,lavfi.signalstats.SATAVG,lavfi.signalstats.HUEAVG',
    'signalstats',
    frame => {
      Y += parseFloat(frame.tag_lavfi_signalstats_YAVG)
      U += parseFloat(frame.tag_lavfi_signalstats_UAVG)
      V += parseFloat(frame.tag_lavfi_signalstats_VAVG)
      SAT += parseFloat(frame.tag_lavfi_signalstats_SATAVG)
      HUE += parseFloat(frame.tag_lavfi_signalstats_HUEAVG)
      count++
      return FFProbeProcess.Skip
    },
  )
  return { YAvg: Y / count, UAvg: U / count, VAvg: V / count, SatAvg: SAT / count, HueAvg: HUE / count }
}

/**
 * Wait for the process to stop or kill it after the timeout.
 * @param pid The process pid
 * @param timeout The maximum wait time in milliseconds
 * @returns `true` if the process stopped, `false` if the process was killed.
 */
export async function waitStopProcess(pid: number, timeout = 5000): Promise<boolean> {
  log.debug(`waitStopProcess pid: ${pid} timeout: ${timeout}`)
  const now = Date.now()
  while (Date.now() - now < timeout) {
    try {
      process.kill(pid, 0)
      await sleep(Math.max(timeout / 10, 200))
    } catch {
      return true
    }
  }
  log.warn(`waitStopProcess pid: ${pid} timeout`)
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return true
  }
  return false
}
