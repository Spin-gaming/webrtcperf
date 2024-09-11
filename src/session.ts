import assert from 'assert'
import axios from 'axios'
import chalk from 'chalk'
import EventEmitter from 'events'
import fs from 'fs'
import JSON5 from 'json5'
import { LoremIpsum } from 'lorem-ipsum'
import NodeCache from 'node-cache'
import os from 'os'
import path from 'path'
import puppeteer, {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  Metrics,
  Page,
  Permission,
} from 'puppeteer-core'
import type { Interception } from 'puppeteer-intercept-and-modify-requests'
import { RequestInterceptionManager } from 'puppeteer-intercept-and-modify-requests'
import * as sdpTransform from 'sdp-transform'
import { gunzipSync } from 'zlib'

import { rtcStatKey, RtcStats, updateRtcStats } from './rtcstats'
import { getSessionThrottleValues } from './throttle'
import {
  checkChromeExecutable,
  downloadUrl,
  enabledForSession,
  getProcessStats,
  getSystemStats,
  hideAuth,
  increaseKey,
  logger,
  PeerConnectionExternal,
  PeerConnectionExternalMethod,
  portForwarder,
  resolveIP,
  resolvePackagePath,
  sha256,
  sleep,
} from './utils'

const log = logger('webrtcperf:session')

/* const metricsTotalDuration = (metrics: Metrics): number => {
  return (
    (metrics.LayoutDuration || 0) +
    (metrics.RecalcStyleCount || 0) +
    (metrics.ScriptDuration || 0) +
    (metrics.TaskDuration || 0)
  )
} */

declare global {
  let collectPeerConnectionStats: () => Promise<{
    stats: RtcStats[]
    signalingHost?: string
    participantName?: string
    activePeerConnections: number
    peerConnectionsDisconnected: number
    peerConnectionsFailed: number
    peerConnectionsClosed: number
  }>
  let collectAudioEndToEndDelayStats: () => number
  let collectVideoEndToEndDelayStats: () => number
  let collectVideoEndToEndNetworkDelayStats: () => number
  let collectHttpResourcesStats: () => {
    recvBytes: number
    recvBitrate: number
    recvLatency: number
  }
  let collectCpuPressure: () => number
  let collectCustomMetrics: () => Promise<Record<string, number | string>>
  let getParticipantName: () => string
}

const PageLogColors = {
  error: 'red',
  warn: 'yellow',
  info: 'cyan',
  log: 'grey',
  debug: 'white',
  requestfailed: 'magenta',
}

type PageLogColorsKey =
  | 'error'
  | 'warn'
  | 'info'
  | 'log'
  | 'debug'
  | 'requestfailed'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionStats = Record<string, number | Record<string, number>>

export type SessionParams = {
  /** The chromium running instance url. */
  chromiumUrl: string
  /** The chromium executable path. */
  chromiumPath: string
  /** Chromium additional field trials. */
  chromiumFieldTrials: string
  /** The browser width. */
  windowWidth: number
  /** The browser height. */
  windowHeight: number
  /** The browser device scale factor. */
  deviceScaleFactor: number
  /**
   * If unset, the browser will run in headless mode.
   * When running on Linux, set to a valid X display variable (e.g. `:0`).
   */
  display: string
  /** Enables RED for OPUS codec (experimental).  */
  /* audioRedForOpus: boolean */
  /** The page URL. */
  url: string
  /** The page URL query. */
  urlQuery: string
  /** Custom URL handler. */
  customUrlHandler: string
  customUrlHandlerFn?: CustomUrlHandlerFn
  videoPath?: { video: string; audio: string }
  videoWidth: number
  videoHeight: number
  videoFramerate: number
  enableGpu: string
  enableBrowserLogging: string
  startTimestamp: number
  sessions: number
  tabsPerSession: number
  spawnPeriod: number
  statsInterval: number
  getUserMediaOverride: string
  disabledVideoCodecs: string
  getDisplayMediaOverride: string
  getDisplayMediaType: string
  getDisplayMediaCrop: string
  localStorage: string
  clearCookies: boolean
  scriptPath: string
  showPageLog: boolean
  pageLogFilter: string
  pageLogPath: string
  userAgent: string
  id: number
  throttleIndex: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluateAfter?: any[]
  exposedFunctions?: string
  scriptParams: string
  blockedUrls: string
  extraHeaders: string
  responseModifiers: string
  extraCSS: string
  cookies: string
  overridePermissions: string
  debuggingPort: number
  debuggingAddress: string
  randomAudioPeriod: number
  maxVideoDecoders: number
  maxVideoDecodersAt: number
  incognito: boolean
  serverPort: number
  serverSecret: string
  serverUseHttps: boolean
}

export type CustomUrlHandlerFn = (params: {
  id: number
  sessions: number
  tabIndex: number
  tabsPerSession: number
  index: number
  pid: number
  env: Record<string, string>
  params: Record<string, unknown>
}) => Promise<string>

/**
 * Implements a test session instance running on a browser instance.
 */
export class Session extends EventEmitter {
  private readonly chromiumUrl: string
  private readonly chromiumPath?: string
  private readonly chromiumFieldTrials?: string
  private readonly windowWidth: number
  private readonly windowHeight: number
  private readonly deviceScaleFactor: number
  private readonly display: string
  /* private readonly audioRedForOpus: boolean */
  public readonly videoPath?: { video: string; audio: string }
  private readonly videoWidth: number
  private readonly videoHeight: number
  private readonly videoFramerate: number
  private readonly enableGpu: string
  private readonly enableBrowserLogging: boolean
  private readonly startTimestamp: number
  private readonly sessions: number
  private readonly tabsPerSession: number
  private readonly spawnPeriod: number
  private readonly statsInterval: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly getUserMediaOverride: any | null
  private readonly disabledVideoCodecs: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly getDisplayMediaOverride: any | null
  private readonly getDisplayMediaType: string
  private readonly getDisplayMediaCrop: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly localStorage?: any
  private readonly clearCookies: boolean
  private readonly scriptPath: string
  private readonly showPageLog: boolean
  private readonly pageLogFilter: string
  private readonly pageLogPath: string
  private readonly userAgent: string
  private readonly evaluateAfter: {
    // eslint-disable-next-line @typescript-eslint/ban-types
    pageFunction: Function
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any
  }[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly exposedFunctions: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly scriptParams: any
  private readonly blockedUrls: string[]
  private readonly extraHeaders?: Record<string, Record<string, string>>
  private readonly responseModifiers: Record<
    string,
    { search: RegExp; replace: string }[]
  > = {}
  private readonly extraCSS: string
  private readonly cookies?: Record<string, string>
  private readonly overridePermissions: Permission[] = []
  private readonly debuggingPort: number
  private readonly debuggingAddress: string
  private readonly randomAudioPeriod: number
  private readonly maxVideoDecoders: number
  private readonly maxVideoDecodersAt: number
  private readonly incognito: boolean
  private readonly serverPort: number
  private readonly serverSecret: string
  private readonly serverUseHttps: boolean

  private running = false
  private browser?: Browser
  private context?: BrowserContext
  private stopPortForwarder?: () => void

  /** The numeric id assigned to the session. */
  readonly id: number
  /** The throttle configuration index assigned to the session. */
  readonly throttleIndex: number
  /** The test page url. */
  readonly url: string
  /** The url query. */
  readonly urlQuery: string
  /**
   * The custom URL handler. This is the path to a JavaScript module (.mjs) exporting the function.
   * The function itself takes an object as input with the following parameters:
   *
   * @typedef {Object} CustomUrlHandler
   * @property {string} id - The identifier for the URL.
   * @property {string} sessions - The number of sessions.
   * @property {string} tabIndex - The index of the current tab.
   * @property {string} tabsPerSession - The number of tabs per session.
   * @property {string} index - The index for the URL.
   * @property {string} pid - The process identifier for the URL.
   *
   * @type {string} path - The path to the JavaScript file containing the function:
   *   (params: CustomUrlHandler) => Promise<string>
   */
  readonly customUrlHandler: string
  /**
   * Imported custom URL handler function.
   * @typedef {Object} CustomUrlHandler
   * @property {number} id - The identifier for the URL.
   * @property {number} sessions - The number of sessions.
   * @property {number} tabIndex - The index of the current tab.
   * @property {number} tabsPerSession - The number of tabs per session.
   * @property {number} index - The index for the URL.
   * @property {number} pid - The process identifier for the URL.
   * @property {Record<string, string>} env - The process environment.
   *
   * @type {string} path - The path to the JavaScript file containing the function:
   *   (params: CustomUrlHandler) => Promise<string>
   */
  public customUrlHandlerFn?: CustomUrlHandlerFn
  /** The latest stats extracted from page. */
  stats: SessionStats = {}
  /** The browser opened pages. */
  readonly pages = new Map<number, Page>()
  /** The browser opened pages metrics. */
  readonly pagesMetrics = new Map<number, Metrics>()
  /** The page warnings count. */
  pageWarnings = 0
  /** The page errors count. */
  pageErrors = 0

  private static readonly jsonFetchCache = new NodeCache({
    stdTTL: 30,
    checkperiod: 15,
  })

  constructor({
    chromiumUrl,
    chromiumPath,
    chromiumFieldTrials,
    windowWidth,
    windowHeight,
    deviceScaleFactor,
    display,
    /* audioRedForOpus, */
    url,
    urlQuery,
    customUrlHandler,
    customUrlHandlerFn,
    videoPath,
    videoWidth,
    videoHeight,
    videoFramerate,
    enableGpu,
    enableBrowserLogging,
    startTimestamp,
    sessions,
    tabsPerSession,
    spawnPeriod,
    statsInterval,
    getUserMediaOverride,
    disabledVideoCodecs,
    getDisplayMediaOverride,
    getDisplayMediaType,
    getDisplayMediaCrop,
    localStorage,
    clearCookies,
    scriptPath,
    showPageLog,
    pageLogFilter,
    pageLogPath,
    userAgent,
    id,
    throttleIndex,
    evaluateAfter,
    exposedFunctions,
    scriptParams,
    blockedUrls,
    extraHeaders,
    responseModifiers,
    extraCSS,
    cookies,
    overridePermissions,
    debuggingPort,
    debuggingAddress,
    randomAudioPeriod,
    maxVideoDecoders,
    maxVideoDecodersAt,
    incognito,
    serverPort,
    serverSecret,
    serverUseHttps,
  }: SessionParams) {
    super()
    log.debug('constructor', { id })
    this.id = id
    this.chromiumUrl = chromiumUrl
    this.chromiumPath = chromiumPath || undefined
    this.chromiumFieldTrials = chromiumFieldTrials || undefined
    this.windowWidth = windowWidth || 1920
    this.windowHeight = windowHeight || 1080
    this.deviceScaleFactor = deviceScaleFactor || 1
    this.debuggingPort = debuggingPort || 0
    this.debuggingAddress = debuggingAddress || ''
    this.display = display
    /* this.audioRedForOpus = !!audioRedForOpus */
    this.url = url
    this.urlQuery = urlQuery
    if (!this.urlQuery && url.indexOf('?') !== -1) {
      const parts = url.split('?', 2)
      this.url = parts[0]
      this.urlQuery = parts[1]
    }
    this.customUrlHandler = customUrlHandler
    this.customUrlHandlerFn = customUrlHandlerFn
    this.videoPath = videoPath
    this.videoWidth = videoWidth
    this.videoHeight = videoHeight
    this.videoFramerate = videoFramerate
    this.enableGpu = enableGpu
    this.enableBrowserLogging = enabledForSession(this.id, enableBrowserLogging)
    this.startTimestamp = startTimestamp || Date.now()
    this.sessions = sessions || 1
    this.tabsPerSession = tabsPerSession || 1
    assert(this.tabsPerSession >= 1, 'tabsPerSession should be >= 1')
    this.spawnPeriod = spawnPeriod || 1000
    this.statsInterval = statsInterval || 10
    if (getUserMediaOverride) {
      try {
        this.getUserMediaOverride = JSON5.parse(getUserMediaOverride)
      } catch (err: unknown) {
        log.error(`error parsing getUserMediaOverride: ${(err as Error).stack}`)
        this.getUserMediaOverride = null
      }
    }
    if (getDisplayMediaOverride) {
      try {
        this.getDisplayMediaOverride = JSON5.parse(getDisplayMediaOverride)
      } catch (err: unknown) {
        log.error(
          `error parsing getDisplayMediaOverride: ${(err as Error).stack}`,
        )
        this.getDisplayMediaOverride = null
      }
    }
    if (disabledVideoCodecs) {
      this.disabledVideoCodecs = disabledVideoCodecs
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length)
    } else {
      this.disabledVideoCodecs = []
    }
    this.getDisplayMediaType = getDisplayMediaType
    this.getDisplayMediaCrop = getDisplayMediaCrop
    if (localStorage) {
      try {
        this.localStorage = JSON5.parse(localStorage)
      } catch (err: unknown) {
        log.error(`error parsing localStorage: ${(err as Error).stack}`)
        this.localStorage = null
      }
    }
    this.clearCookies = clearCookies
    this.scriptPath = scriptPath
    this.showPageLog = showPageLog
    this.pageLogFilter = pageLogFilter
    this.pageLogPath = pageLogPath
    this.userAgent = userAgent
    this.randomAudioPeriod = randomAudioPeriod
    this.maxVideoDecoders = maxVideoDecoders
    this.maxVideoDecodersAt = maxVideoDecodersAt
    this.incognito = incognito
    this.serverPort = serverPort
    this.serverSecret = serverSecret
    this.serverUseHttps = serverUseHttps

    this.throttleIndex = throttleIndex
    this.evaluateAfter = evaluateAfter || []
    this.exposedFunctions = exposedFunctions || {}
    if (scriptParams) {
      try {
        this.scriptParams = JSON5.parse(scriptParams)
      } catch (err) {
        log.error(
          `error parsing scriptParams '${scriptParams}': ${
            (err as Error).stack
          }`,
        )
        throw err
      }
    } else {
      this.scriptParams = {}
    }
    this.blockedUrls = (blockedUrls || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length)
    // Always block sentry.io.
    this.blockedUrls.push('ingest.sentry.io')

    if (extraHeaders) {
      try {
        this.extraHeaders = JSON5.parse(extraHeaders)
      } catch (err) {
        log.error(`error parsing extraHeaders: ${(err as Error).stack}`)
        this.extraHeaders = undefined
      }
    } else {
      this.extraHeaders = undefined
    }

    if (responseModifiers) {
      try {
        const parsed = JSON5.parse(responseModifiers) as Record<
          string,
          { search: string; replace: string }[]
        >
        Object.entries(parsed).forEach(([url, replacements]) => {
          this.responseModifiers[url] = replacements.map(
            ({ search, replace }) => ({
              search: new RegExp(search, 'g'),
              replace,
            }),
          )
        })
      } catch (err) {
        log.error(
          `error parsing responseModifiers "${responseModifiers}": ${
            (err as Error).stack
          }`,
        )
      }
    }

    this.extraCSS = extraCSS

    if (cookies) {
      try {
        this.cookies = JSON5.parse(cookies)
      } catch (err) {
        log.error(`error parsing cookies: ${(err as Error).stack}`)
        this.cookies = undefined
      }
    } else {
      this.cookies = undefined
    }

    if (overridePermissions) {
      this.overridePermissions = overridePermissions
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length) as Permission[]
    }
  }

  /**
   * Returns the chromium browser launch args
   * @return the args list
   */
  getBrowserArgs(): string[] {
    // https://peter.sh/experiments/chromium-command-line-switches/
    // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/fieldtrial_testing_config.json;l=8877?q=%20fieldtrial_testing_config.json&ss=chromium
    let args = [
      '--no-sandbox',
      '--no-zygote',
      '--ignore-certificate-errors',
      '--no-user-gesture-required',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-infobars',
      '--allow-running-insecure-content',
      `--unsafely-treat-insecure-origin-as-secure=http://${
        new URL(this.url || 'http://localhost').host
      }`,
      '--use-fake-ui-for-media-stream',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--auto-accept-this-tab-capture',
      `--use-fake-device-for-media-stream=display-media-type=${
        this.getDisplayMediaType || 'monitor'
      },fps=30`,
      // '--auto-select-desktop-capture-source=Entire screen',
      // `--auto-select-tab-capture-source-by-title=about:blank`,
      `--remote-debugging-port=${
        this.debuggingPort ? this.debuggingPort + this.id : 0
      }`,
    ]

    // 'WebRTC-VP8ConferenceTemporalLayers/2',
    // 'AutomaticTabDiscarding/Disabled',
    // 'WebRTC-Vp9DependencyDescriptor/Enabled',
    // 'WebRTC-DependencyDescriptorAdvertised/Enabled',
    let fieldTrials = this.chromiumFieldTrials || ''
    /* if (this.audioRedForOpus) {
      fieldTrials.push('WebRTC-Audio-Red-For-Opus/Enabled')
    } */
    if (this.maxVideoDecoders !== -1 && this.id >= this.maxVideoDecodersAt) {
      fieldTrials =
        `WebRTC-MaxVideoDecoders/${this.maxVideoDecoders}/` + fieldTrials
    }
    if (fieldTrials.length) {
      args.push(`--force-fieldtrials=${fieldTrials}`)
    }

    if (this.videoPath) {
      log.debug(`${this.id} using ${this.videoPath} as fake source`)
      args.push(`--use-file-for-fake-video-capture=${this.videoPath.video}`)
      args.push(`--use-file-for-fake-audio-capture=${this.videoPath.audio}`)
    }

    if (this.enableGpu) {
      args = args.concat([
        '--ignore-gpu-blocklist',
        '--enable-features=VaapiVideoDecoder',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--disable-gpu-sandbox',
        '--enable-vulkan',
      ])
      if (this.enableGpu === 'egl') {
        args.push('--use-gl=egl')
      }
    } else {
      args = args.concat([
        // Disables webgl support.
        '--disable-3d-apis',
        '--disable-site-isolation-trials',
        // '--renderer-process-limit=2',
        // '--single-process',
      ])
    }

    if (this.enableBrowserLogging) {
      args = args.concat(['--enable-logging=stderr', '--vmodule=*/webrtc/*=1'])
    }

    return args
  }

  /**
   * Start
   */
  async start(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    if (this.browser) {
      log.warn(`${this.id} start: already running`)
      return
    }
    log.debug(`${this.id} start`)

    if (this.chromiumUrl) {
      // connect to a remote chrome instance
      try {
        this.browser = await puppeteer.connect({
          browserURL: this.chromiumUrl,
          ignoreHTTPSErrors: true,
          defaultViewport: {
            width: this.windowWidth,
            height: this.windowHeight,
            deviceScaleFactor: this.deviceScaleFactor,
            isMobile: false,
            hasTouch: false,
            isLandscape: false,
          },
        })
      } catch (err) {
        log.error(`${this.id} browser connect error: ${(err as Error).stack}`)
        return this.stop()
      }
    } else {
      // run a browser instance locally
      let executablePath = this.chromiumPath
      if (!executablePath || !fs.existsSync(executablePath)) {
        executablePath = await checkChromeExecutable()
        log.debug(`using executablePath=${executablePath}`)
      }

      // Create process wrapper.
      if (this.throttleIndex > -1 && os.platform() === 'linux') {
        const mark = this.throttleIndex + 1
        const executableWrapperPath = `/tmp/webrtcperf-launcher-${mark}`
        const group = `webrtcperf${mark}`
        await fs.promises.writeFile(
          executableWrapperPath,
          `#!/bin/bash
getent group ${group} || sudo -n addgroup --system ${group}
sudo -n adduser $USER ${group}

sudo -n iptables -t mangle -L OUTPUT | grep -q "owner GID match ${group}" || sudo -n iptables -t mangle -A OUTPUT -m owner --gid-owner ${group} -j MARK --set-mark ${mark}
sudo -n iptables -t mangle -L PREROUTING | grep -q "CONNMARK restore" || sudo -n iptables -t mangle -A PREROUTING -j CONNMARK --restore-mark
sudo -n iptables -t mangle -L POSTROUTING | grep -q "CONNMARK save" || sudo -n iptables -t mangle -A POSTROUTING -j CONNMARK --save-mark

cat <<EOF > /tmp/webrtcperf-launcher-${mark}-browser
#!/bin/bash
exec ${executablePath} $@
EOF
chmod +x /tmp/webrtcperf-launcher-${mark}-browser

exec sg ${group} -c /tmp/webrtcperf-launcher-${mark}-browser`,
        )
        await fs.promises.chmod(executableWrapperPath, 0o755)
        executablePath = executableWrapperPath
      }

      const env = { ...process.env }
      if (!this.display) {
        delete env.DISPLAY
      } else {
        env.DISPLAY = this.display
      }

      const args = this.getBrowserArgs()
      const ignoreDefaultArgs = [
        '--disable-dev-shm-usage',
        '--remote-debugging-port',
        //'--hide-scrollbars',
      ]
      if (this.debuggingPort) {
        ignoreDefaultArgs.push('--enable-automation')
      }

      log.debug(`Using args:\n  ${args.join('\n  ')}`)
      log.debug(`Default args:\n  ${puppeteer.defaultArgs().join('\n  ')}`)

      try {
        // log.debug('defaultArgs:', puppeteer.defaultArgs());
        this.browser = await puppeteer.launch({
          headless: this.display ? false : true,
          executablePath,
          handleSIGINT: false,
          env,
          dumpio: this.enableBrowserLogging,
          // devtools: true,
          ignoreHTTPSErrors: true,
          defaultViewport: {
            width: this.windowWidth,
            height: this.windowHeight,
            deviceScaleFactor: this.deviceScaleFactor,
            isMobile: false,
            hasTouch: false,
            isLandscape: false,
          },
          ignoreDefaultArgs,
          args,
        })
        // const version = await this.browser.version();
        // console.log(`[session ${this.id}] Using chrome version: ${version}`);
      } catch (err) {
        log.error(
          `[session ${this.id}] Browser launch error: ${(err as Error).stack}`,
        )
        return this.stop()
      }
    }

    assert(this.browser, 'BrowserNotCreated')

    if (this.debuggingPort && this.debuggingAddress !== '127.0.0.1') {
      this.stopPortForwarder = await portForwarder(
        this.debuggingPort + this.id,
        this.debuggingAddress,
      )
    }

    this.browser.once('disconnected', () => {
      log.debug('browser disconnected')
      return this.stop()
    })

    // get GPU infos from chrome://gpu page
    /* if (this.enableGpu) {
      try {
        const page = await this.browser.newPage()
        await page.goto('chrome://gpu')
        const data = await page.evaluate(() =>
          [
            // eslint-disable-next-line no-undef
            ...document.querySelectorAll('ul.feature-status-list > li > span'),
          ].map(
            (e, i) =>
              `${i % 2 === 0 ? '\n- ' : ''}${(e as HTMLSpanElement).innerText}`,
          ),
        )
        await page.close()
        console.log(`GPU infos:${data.join('')}`)
      } catch (err) {
        log.warn(`${this.id} error getting gpu info: %j`, err)
      }
    } */

    // open pages
    for (let i = 0; i < this.tabsPerSession; i++) {
      this.openPage(i).catch(err =>
        log.error(`openPage error: ${(err as Error).stack}`),
      )
      if (i < this.tabsPerSession - 1) {
        await sleep(this.spawnPeriod)
      }
    }
  }

  /**
   * openPage
   * @param tabIndex
   */
  async openPage(tabIndex: number): Promise<void> {
    if (!this.browser) {
      return
    }
    const index = this.id + tabIndex
    let saveFile: fs.promises.FileHandle | undefined = undefined
    let url = this.url

    if (!url) {
      if (this.customUrlHandler && !this.customUrlHandlerFn) {
        const customUrlHandlerPath = path.resolve(
          process.cwd(),
          this.customUrlHandler,
        )
        if (!fs.existsSync(customUrlHandlerPath)) {
          throw new Error(
            `Custom url handler script not found: "${customUrlHandlerPath}"`,
          )
        }
        this.customUrlHandlerFn = (
          await import(/* webpackIgnore: true */ customUrlHandlerPath)
        ).default
      }
      if (!this.customUrlHandlerFn) {
        throw new Error(`Custom url handler function not set`)
      }
      url = await this.customUrlHandlerFn({
        id: this.id,
        sessions: this.sessions,
        tabIndex,
        tabsPerSession: this.tabsPerSession,
        index,
        pid: process.pid,
        env: { ...process.env } as Record<string, string>,
        params: this.scriptParams,
      })
    }

    if (!url) {
      throw new Error(`Page URL not set`)
    }

    if (this.urlQuery) {
      url += `?${this.urlQuery
        .replace(/\$s/g, String(this.id))
        .replace(/\$S/g, String(this.sessions))
        .replace(/\$t/g, String(tabIndex))
        .replace(/\$T/g, String(this.tabsPerSession))
        .replace(/\$i/g, String(index))
        .replace(/\$p/g, String(process.pid))}`
    }

    log.debug(
      `opening page ${index} (session: ${this.id} tab: ${tabIndex}): ${hideAuth(
        url,
      )}`,
    )

    if (this.incognito) {
      this.context = await this.browser.createBrowserContext()
    } else {
      this.context = this.browser.defaultBrowserContext()
    }

    if (this.overridePermissions.length) {
      await this.context.overridePermissions(
        new URL(url).origin,
        this.overridePermissions,
      )
    }

    const page = await this.getNewPage(tabIndex)

    await page.setBypassCSP(true)

    if (this.userAgent) {
      await page.setUserAgent(this.userAgent)
    }

    await Promise.all(
      Object.keys(this.exposedFunctions).map(
        async (name: string) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.exposeFunction(name, (...args: any[]) =>
            this.exposedFunctions[name](...args),
          ),
      ),
    )

    // Export config to page.
    let cmd = `\
window.WEBRTC_PERF_START_TIMESTAMP = ${this.startTimestamp};
window.WEBRTC_PERF_URL = "${hideAuth(url)}";
window.WEBRTC_PERF_SESSION = ${this.id};
window.WEBRTC_PERF_TAB_INDEX = ${tabIndex};
window.WEBRTC_PERF_INDEX = ${index};
window.STATS_INTERVAL = ${this.statsInterval};
window.VIDEO_WIDTH = ${this.videoWidth};
window.VIDEO_HEIGHT = "${this.videoHeight}";
window.VIDEO_FRAMERATE = ${this.videoFramerate};
window.LOCAL_STORAGE = '${
      this.localStorage ? JSON.stringify(this.localStorage) : ''
    }';
window.RANDOM_AUDIO_PERIOD = ${this.randomAudioPeriod};
try {
  window.PARAMS = JSON.parse('${JSON.stringify(this.scriptParams)}' || '{}');
} catch (err) {}
`

    if (this.serverPort) {
      cmd += `\
window.SERVER_PORT = ${this.serverPort};
window.SERVER_SECRET = "${this.serverSecret}";
window.SERVER_USE_HTTPS = ${this.serverUseHttps};
`
    }

    if (this.getUserMediaOverride) {
      log.debug('Using getUserMedia override:', this.getUserMediaOverride)
      cmd += `window.GET_USER_MEDIA_OVERRIDE = JSON.parse('${JSON.stringify(
        this.getUserMediaOverride,
      )}');\n`
    }

    if (this.getDisplayMediaOverride) {
      log.debug('Using getDisplayMedia override:', this.getDisplayMediaOverride)
      cmd += `window.GET_DISPLAY_MEDIA_OVERRIDE = JSON.parse('${JSON.stringify(
        this.getDisplayMediaOverride,
      )}');\n`
    }

    if (this.disabledVideoCodecs.length) {
      log.debug('Using disabledVideoCodecs:', this.disabledVideoCodecs)
      cmd += `window.GET_CAPABILITIES_DISABLED_VIDEO_CODECS = JSON.parse('${JSON.stringify(
        this.disabledVideoCodecs,
      )}');\n`
    }

    if (this.getDisplayMediaCrop) {
      log.debug('Using getDisplayMedia crop:', this.getDisplayMediaCrop)
      cmd += `window.GET_DISPLAY_MEDIA_CROP = "${this.getDisplayMediaCrop}";\n`
    }

    if (this.localStorage) {
      log.debug('Using localStorage:', this.localStorage)
      Object.entries(this.localStorage).map(([key, value]) => {
        cmd += `localStorage.setItem('${key}', JSON.parse('${JSON.stringify(
          value,
        )}'));\n`
      })
    }

    await page.evaluateOnNewDocument(cmd)

    // Clear cookies.
    if (this.clearCookies) {
      try {
        const client = await page.target().createCDPSession()
        await client.send('Network.clearBrowserCookies')
      } catch (err) {
        log.error(`clearCookies error: ${(err as Error).stack}`)
      }
    }

    // Load scripts.
    for (const name of [
      'scripts/common.js',
      'scripts/get-user-media.js',
      'scripts/peer-connection-stats.js',
      `scripts/peer-connection${
        process.env.EXTERNAL_PEER_CONNECTION === 'true' ? '-external' : ''
      }.js`,
      'scripts/e2e-network-stats.js',
      'https://raw.githubusercontent.com/ggerganov/ggwave/master/bindings/javascript/ggwave.js',
      'scripts/e2e-audio-stats.js',
      'scripts/e2e-video-stats.js',
      'scripts/playout-delay-hint.js',
      'scripts/page-stats.js',
      'scripts/save-tracks.js',
      'scripts/pressure-stats.js',
    ]) {
      if (name.startsWith('http')) {
        log.debug(`loading ${name} script`)
        const res = await downloadUrl(name)
        if (!res?.data) {
          throw new Error(`Failed to download script from: ${name}`)
        }
        await page.evaluateOnNewDocument(res.data)
      } else {
        const filePath = resolvePackagePath(name)
        if (!fs.existsSync(filePath)) {
          throw new Error(`${name} script not found: ${filePath}`)
        }
        log.debug(`loading ${name} script from: ${filePath}`)
        await page.evaluateOnNewDocument(fs.readFileSync(filePath, 'utf8'))
      }
    }

    // Execute external script(s).
    if (this.scriptPath) {
      if (this.scriptPath.startsWith('base64:gzip:')) {
        const data = Buffer.from(
          this.scriptPath.replace('base64:gzip:', ''),
          'base64',
        )
        const code = gunzipSync(data).toString()
        log.debug(`loading script from ${code.length} bytes`)
        await page.evaluateOnNewDocument(code)
      } else {
        for (const filePath of this.scriptPath.split(',')) {
          if (!filePath.trim()) {
            continue
          }
          if (filePath.startsWith('http')) {
            log.debug(`loading custom script from url: ${filePath}`)
            const res = await downloadUrl(filePath)
            if (!res?.data) {
              throw new Error(`Failed to download script from: ${filePath}`)
            }
            await page.evaluateOnNewDocument(res.data)
          } else {
            if (!fs.existsSync(filePath)) {
              log.warn(`custom script not found: ${filePath}`)
              continue
            }
            log.debug(`loading custom script from file: ${filePath}`)
            await page.evaluateOnNewDocument(fs.readFileSync(filePath, 'utf8'))
          }
        }
      }
    }

    page.on('dialog', async dialog => {
      log.debug(
        `page ${index + 1} dialog ${dialog.type()}: ${dialog.message()}`,
      )
      try {
        await dialog.accept()
      } catch (err) {
        log.debug(`dialog accept error: ${(err as Error).message}`)
      }
      try {
        await dialog.dismiss()
      } catch (err) {
        log.debug(`dialog dismiss error: ${(err as Error).message}`)
      }
    })

    page.once('close', () => {
      log.debug(`page ${index + 1} closed`)
      this.pages.delete(index)
      this.pagesMetrics.delete(index)

      if (saveFile) {
        saveFile.close().catch(err => {
          log.error(`saveFile close error: ${(err as Error).stack}`)
        })
        saveFile = undefined
      }

      if (this.browser && this.running) {
        setTimeout(() => this.openPage(index), 1000)
      }
    })

    // Enable request interception.
    let setRequestInterceptionState = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageCDPSession = (page as any)._client() as CDPSession
    await pageCDPSession.send('Network.setBypassServiceWorker', {
      bypass: true,
    })

    const interceptManager = new RequestInterceptionManager(pageCDPSession, {
      onError: error => {
        log.error('Request interception error:', error)
      },
    })

    const interceptions: Interception[] = []

    // Blocked URLs.
    this.blockedUrls.forEach(blockedUrl => {
      interceptions.push({
        urlPattern: blockedUrl,
        modifyRequest: () => ({ errorReason: 'BlockedByClient' }),
      })
    })

    // Add extra headers.
    if (this.extraHeaders) {
      Object.entries(this.extraHeaders).forEach(([url, obj]) => {
        const headers = Object.entries(obj).map(([name, value]) => ({
          name,
          value,
        }))
        interceptions.push({
          urlPattern: url,
          modifyRequest: ({ event }) => {
            log.debug(`adding extraHeaders in: ${event.request.url}`, headers)
            return { headers }
          },
        })
      })
    }

    // Response modifiers.
    Object.entries(this.responseModifiers).forEach(([url, replacements]) => {
      interceptions.push({
        urlPattern: url,
        modifyResponse: ({ event, body }) => {
          if (body) {
            log.debug(
              `using responseModifiers in: ${event.request.url}`,
              replacements.map(
                ({ search, replace }) => `${search.toString()} => ${replace}`,
              ),
            )
            replacements.forEach(({ search, replace }) => {
              body = body?.replace(search, replace)
            })
          }
          return { body }
        },
      })
    })

    await interceptManager.intercept(...interceptions)

    // Allow to change the setRequestInterception state from page.
    const setRequestInterceptionFunction = async (value: boolean) => {
      if (value === setRequestInterceptionState) {
        return
      }
      log.debug(`setRequestInterception to ${value}`)
      try {
        if (!value) {
          await interceptManager.disable()
        } else {
          await interceptManager.enable()
        }
        setRequestInterceptionState = value
      } catch (err) {
        log.error(`setRequestInterception error: ${(err as Error).stack}`)
      }
    }

    await page.exposeFunction(
      'setRequestInterception',
      setRequestInterceptionFunction,
    )

    await page.exposeFunction(
      'jsonFetch',
      async (
        options: axios.AxiosRequestConfig & {
          validStatuses: number[]
          downloadPath: string
        },
        cacheKey = '',
        cacheTimeout = 0,
      ) => {
        if (cacheKey) {
          const ret = Session.jsonFetchCache.get(cacheKey)
          if (ret) {
            return ret
          }
        }
        try {
          if (options.validStatuses) {
            options.validateStatus = status =>
              options.validStatuses.includes(status)
          }
          const { status, data, headers } = await axios(options)
          if (options.responseType === 'stream') {
            if (options.downloadPath && !fs.existsSync(options.downloadPath)) {
              log.debug(
                `jsonFetch saving file to: ${options.downloadPath}`,
                headers['content-disposition'],
              )
              await fs.promises.mkdir(path.dirname(options.downloadPath), {
                recursive: true,
              })
              const writer = fs.createWriteStream(options.downloadPath)
              await new Promise<void>((resolve, reject) => {
                writer.on('error', err => reject(err))
                writer.on('close', () => resolve())
                data.pipe(writer)
              })
            }
            if (cacheKey) {
              Session.jsonFetchCache.set(cacheKey, { status }, cacheTimeout)
            }
            return { status, headers }
          } else {
            if (cacheKey) {
              Session.jsonFetchCache.set(
                cacheKey,
                { status, data },
                cacheTimeout,
              )
            }
            return { status, headers, data }
          }
        } catch (err) {
          const error = (err as Error).message
          log.warn(`jsonFetch error: ${error}`)
          return { status: 500, error }
        }
      },
    )

    await page.exposeFunction(
      'readLocalFile',
      (filePath: string, encoding?: BufferEncoding) => {
        filePath = path.resolve(process.cwd(), filePath)
        return fs.promises.readFile(filePath, encoding)
      },
    )

    // PeerConnectionExternal
    await page.exposeFunction(
      'createPeerConnectionExternal',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (options: any) => {
        const pc = new PeerConnectionExternal(options)
        return { id: pc.id }
      },
    )

    await page.exposeFunction(
      'callPeerConnectionExternalMethod',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (id: number, name: PeerConnectionExternalMethod, arg: any) => {
        const pc = PeerConnectionExternal.get(id)
        if (pc) {
          return pc[name](arg)
        }
      },
    )

    /* pageCDPSession.on('Network.webSocketFrameSent', ({requestId, timestamp, response}) => {
      log('Network.webSocketFrameSent', requestId, timestamp, response.payloadData)
    })

    pageCDPSession.on('Network.webSocketFrameReceived', ({requestId, timestamp, response}) => {
      log('Network.webSocketFrameReceived', requestId, timestamp, response.payloadData)
    }) */

    // Simulate keypress
    await page.exposeFunction(
      'keypressText',
      async (selector: string, text: string, delay = 20) => {
        await page.type(selector, text, { delay })
      },
    )

    // Simulate mouse clicks
    await page.exposeFunction('mouseClick', async (selector: string) => {
      await page.click(selector)
    })

    const lorem = new LoremIpsum({
      sentencesPerParagraph: {
        max: 4,
        min: 1,
      },
      wordsPerSentence: {
        max: 16,
        min: 2,
      },
    })

    await page.exposeFunction(
      'keypressRandomText',
      async (
        selector: string,
        count = 1,
        prefix = '',
        suffix = '',
        delay = 0,
      ) => {
        const c = prefix + lorem.generateSentences(count) + suffix
        const frames = await page.frames()
        for (const frame of frames) {
          const el = await frame.$(selector)
          if (el) {
            await el.focus()
            await frame.type(selector, c, { delay })
          }
        }
      },
    )

    await page.exposeFunction(
      'uploadFileFromUrl',
      async (fileUrl: string, selector: string) => {
        const filename = sha256(fileUrl) + '.' + fileUrl.split('.').slice(-1)[0]
        const filePath = path.join(
          os.homedir(),
          '.webrtcperf/uploads',
          filename,
        )
        if (!fs.existsSync(filePath)) {
          await downloadUrl(fileUrl, undefined, filePath)
        }
        log.debug(`uploadFileFromUrl: ${filePath}`)
        const frames = await page.frames()
        for (const frame of frames) {
          const el = await frame.$(selector)
          if (el) {
            await (el as ElementHandle<HTMLInputElement>).uploadFile(filePath)
            break
          }
        }
      },
    )

    // add extra styles
    if (this.extraCSS) {
      log.debug(`Add extraCSS: ${this.extraCSS}`)
      try {
        await page.evaluateOnNewDocument(
          (css: string) => {
            // eslint-disable-next-line no-undef
            document.addEventListener('DOMContentLoaded', () => {
              // eslint-disable-next-line no-undef
              const style = document.createElement('style')
              style.setAttribute('id', 'webrtcperf-extra-style')
              style.setAttribute('type', 'text/css')
              style.innerHTML = css
              // eslint-disable-next-line no-undef
              document.head.appendChild(style)
            })
          },
          this.extraCSS.replace(/important/g, '!important'),
        )
      } catch (err) {
        log.error(`Add extraCSS error: ${(err as Error).stack}`)
      }
    }

    // add cookies
    if (this.cookies) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars,unused-imports/no-unused-vars-ts
        const [schema, _, domain] = url.split('/').slice(0, 3)
        await Promise.all(
          Object.entries(this.cookies).map(([name, value]) => {
            const cookie = {
              name,
              value,
              domain,
              path: '/',
              httpOnly: true,
              secure: true,
            }
            log.debug(`setting cookie: %j`, cookie)
            return page.setCookie(cookie)
          }),
        )
      } catch (err) {
        log.error(`Set cookies error: ${(err as Error).stack}`)
      }
    }

    // Page logs and errors.
    if (this.pageLogPath) {
      try {
        await fs.promises.mkdir(path.dirname(this.pageLogPath), {
          recursive: true,
        })
        saveFile = await fs.promises.open(this.pageLogPath, 'a')
      } catch (err) {
        log.error(
          `error opening page log file: ${this.pageLogPath}: ${
            (err as Error).stack
          }`,
        )
      }
    }

    await page.exposeFunction(
      'serializedConsoleLog',
      async (type: PageLogColorsKey, text: string) => {
        if (this.showPageLog || saveFile) {
          try {
            await this.onPageMessage(index, type, text, saveFile)
          } catch (err) {
            log.error(`serializedConsoleLog error: ${(err as Error).stack}`)
          }
        }
      },
    )

    if (this.showPageLog || saveFile) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page.on('pageerror', async (error: any) => {
        const text = `pageerror: ${error.message?.message || error.message} - ${
          error.message?.stack || error.stack
        }`
        await this.onPageMessage(index, 'error', text, saveFile)
      })

      page.on('requestfailed', async request => {
        const err = (request.failure()?.errorText || '').trim()
        if (err === 'net::ERR_ABORTED') {
          return
        }
        const text = `${request.method()} ${request.url()}: ${err}`
        await this.onPageMessage(index, 'requestfailed', text, saveFile)
      })
    }

    await page.exposeFunction('WebRtcPerf_sdpParse', (sdpStr: string) =>
      sdpTransform.parse(sdpStr),
    )

    await page.exposeFunction(
      'WebRtcPerf_sdpWrite',
      (sdp: sdpTransform.SessionDescription) => sdpTransform.write(sdp),
    )

    /* page.on('workercreated', worker =>
      log.debug(`Worker created: ${worker.url()}`),
    )
    page.on('workerdestroyed', worker =>
      log.debug(`Worker created: ${worker.url()}`),
    ) */

    // open the page url
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60 * 1000,
      })
    } catch (error) {
      log.error(
        `Page ${index + 1} "${url}" load error: ${(error as Error).stack}`,
      )
      await page.close()
      return
    }

    // add to pages map
    this.pages.set(index, page)

    log.debug(`Page ${index + 1} "${url}" loaded`)

    for (let i = 0; i < this.evaluateAfter.length; i++) {
      await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.evaluateAfter[i].pageFunction as any,
        ...this.evaluateAfter[i].args,
      )
    }

    // If not using a real display, select the first blank page.
    /* if (!this.display) {
      const pages = await this.browser.pages()
      await pages[0].bringToFront()
    } */
  }

  private async getNewPage(_tabIndex: number): Promise<Page> {
    assert(this.context, 'NoBrowserContextCreated')
    return await this.context.newPage()
  }

  private async onPageMessage(
    index: number,
    type: PageLogColorsKey,
    text: string,
    saveFile?: fs.promises.FileHandle,
  ): Promise<void> {
    if (text.endsWith('net::ERR_BLOCKED_BY_CLIENT.Inspector')) {
      return
    }
    const isBlocked = this.blockedUrls.some(
      blockedUrl =>
        (type === 'requestfailed' || text.search('FetchError') !== -1) &&
        text.search(blockedUrl) !== -1,
    )
    if (isBlocked) {
      return
    }
    const color = PageLogColors[type] || 'grey'
    const filter = this.pageLogFilter
      ? new RegExp(this.pageLogFilter, 'ig')
      : null
    if (!filter || text.match(filter)) {
      const errorOrWarning = ['error', 'warning'].includes(type)
      const isWebrtcPerf = text.startsWith('[webrtcperf')
      if (saveFile) {
        if (!errorOrWarning && !isWebrtcPerf && text.length > 1024) {
          text = text.slice(0, 1024) + `... +${text.length - 1024} bytes`
        }
        await saveFile.write(
          `${new Date().toISOString()} [page ${index}] (${type}) ${text}\n`,
        )
      }
      if (this.showPageLog) {
        if (!errorOrWarning && !isWebrtcPerf && text.length > 256) {
          text = text.slice(0, 256) + `... +${text.length - 256} bytes`
        }
        console.log(chalk`{bold [page ${index}]} {${color} (${type}) ${text}}`)
      }
      if (type === 'error') {
        this.pageErrors += 1
      } else if (type === 'warn') {
        this.pageWarnings += 1
      }
    }
  }

  /**
   * updateStats
   */
  async updateStats(_now: number): Promise<SessionStats> {
    if (!this.browser) {
      this.stats = {}
      return this.stats
    }

    const collectedStats: SessionStats = {}

    try {
      const processStats = await getProcessStats()
      collectedStats.nodeCpu = processStats.cpu
      collectedStats.nodeMemory = processStats.memory
    } catch (err) {
      log.error(`node getProcessStats error: ${(err as Error).stack}`)
    }

    try {
      const systemStats = getSystemStats()
      if (systemStats) {
        collectedStats.usedCpu = systemStats.usedCpu
        collectedStats.usedMemory = systemStats.usedMemory
        collectedStats.usedGpu = systemStats.usedGpu
      }
    } catch (err) {
      log.error(`node getSystemStats error: ${(err as Error).stack}`)
    }

    const browserProcess = this.browser.process()
    if (browserProcess) {
      try {
        const processStats = await getProcessStats(browserProcess.pid, true)
        processStats.cpu /= this.tabsPerSession
        processStats.memory /= this.tabsPerSession
        Object.assign(collectedStats, processStats)
      } catch (err) {
        log.error(`getProcessStats error: ${(err as Error).stack}`)
      }
    }

    const pages: Record<string, number> = {}
    const peerConnections: Record<string, number> = {}
    const peerConnectionsClosed: Record<string, number> = {}
    const peerConnectionsDisconnected: Record<string, number> = {}
    const peerConnectionsFailed: Record<string, number> = {}
    const audioEndToEndDelayStats: Record<string, number> = {}
    const videoEndToEndDelayStats: Record<string, number> = {}
    const videoEndToEndNetworkDelayStats: Record<string, number> = {}
    const httpRecvBytesStats: Record<string, number> = {}
    const httpRecvBitrateStats: Record<string, number> = {}
    const httpRecvLatencyStats: Record<string, number> = {}
    const pageCpu: Record<string, number> = {}
    const pageMemory: Record<string, number> = {}
    const cpuPressureStats: Record<string, number> = {}

    const throttleUpValuesRate: Record<string, number> = {}
    const throttleUpValuesDelay: Record<string, number> = {}
    const throttleUpValuesLoss: Record<string, number> = {}
    const throttleUpValuesQueue: Record<string, number> = {}
    const throttleDownValuesRate: Record<string, number> = {}
    const throttleDownValuesDelay: Record<string, number> = {}
    const throttleDownValuesLoss: Record<string, number> = {}
    const throttleDownValuesQueue: Record<string, number> = {}

    const customStats: Record<string, Record<string, number | string>> = {}

    await Promise.allSettled(
      [...this.pages.entries()].map(async ([pageIndex, page]) => {
        try {
          // Collect stats from the page.
          const {
            peerConnectionStats,
            audioEndToEndDelay,
            videoEndToEndDelay,
            videoEndToEndNetworkDelay,
            httpResourcesStats,
            cpuPressure,
            customMetrics,
          } = await page.evaluate(async () => ({
            peerConnectionStats: await collectPeerConnectionStats(),
            audioEndToEndDelay: collectAudioEndToEndDelayStats(),
            videoEndToEndDelay: collectVideoEndToEndDelayStats(),
            videoEndToEndNetworkDelay: collectVideoEndToEndNetworkDelayStats(),
            httpResourcesStats: collectHttpResourcesStats(),
            cpuPressure: collectCpuPressure(),
            customMetrics:
              'collectCustomMetrics' in window ? collectCustomMetrics() : null,
          }))
          const { participantName } = peerConnectionStats

          // Get host from the first collected remote address.
          if (
            !peerConnectionStats.signalingHost &&
            peerConnectionStats.stats.length
          ) {
            const values = Object.values(peerConnectionStats.stats[0])
            if (values.length) {
              peerConnectionStats.signalingHost = await resolveIP(
                values[0].remoteAddress as string,
              )
            }
          }
          const { stats, activePeerConnections, signalingHost } =
            peerConnectionStats

          // Calculate stats keys.
          const hostKey = rtcStatKey({
            hostName: signalingHost,
            participantName,
          })
          const pageKey = rtcStatKey({
            pageIndex,
            hostName: signalingHost,
            participantName,
          })

          // Set pages counter.
          increaseKey(pages, hostKey, 1)

          // Set peerConnections counters.
          increaseKey(peerConnections, hostKey, activePeerConnections)
          increaseKey(
            peerConnectionsClosed,
            hostKey,
            peerConnectionStats.peerConnectionsClosed,
          )
          increaseKey(
            peerConnectionsDisconnected,
            hostKey,
            peerConnectionStats.peerConnectionsDisconnected,
          )
          increaseKey(
            peerConnectionsFailed,
            hostKey,
            peerConnectionStats.peerConnectionsFailed,
          )

          // E2E stats.
          if (audioEndToEndDelay) {
            audioEndToEndDelayStats[pageKey] = audioEndToEndDelay
          }
          if (videoEndToEndDelay) {
            videoEndToEndDelayStats[pageKey] = videoEndToEndDelay
          }
          if (videoEndToEndNetworkDelay) {
            videoEndToEndNetworkDelayStats[pageKey] = videoEndToEndNetworkDelay
          }

          // HTTP stats.
          httpRecvBytesStats[pageKey] = httpResourcesStats.recvBytes
          httpRecvBitrateStats[pageKey] = httpResourcesStats.recvBitrate
          httpRecvLatencyStats[pageKey] = httpResourcesStats.recvLatency

          if (cpuPressure !== undefined) {
            cpuPressureStats[pageKey] = cpuPressure
          }

          // Collect RTC stats.
          for (const s of stats) {
            for (const [trackId, value] of Object.entries(s)) {
              try {
                updateRtcStats(
                  collectedStats as RtcStats,
                  pageIndex,
                  trackId,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  value,
                  signalingHost,
                  participantName,
                )
              } catch (err) {
                log.error(
                  `updateRtcStats error for ${trackId}: ${(err as Error).stack}`,
                  err,
                )
              }
            }
          }

          // Collect custom metrics.
          if (customMetrics) {
            for (const [name, value] of Object.entries(customMetrics)) {
              if (!customStats[name]) {
                customStats[name] = {}
              }
              customStats[name][pageKey] = value
            }
          }

          // Collect page metrics
          /* const metrics = await page.metrics()
        if (metrics.Timestamp) {
          const lastMetrics = this.pagesMetrics.get(pageIndex)
          if (lastMetrics?.Timestamp) {
            const elapsedTime = metrics.Timestamp - lastMetrics.Timestamp
            if (elapsedTime > 10) {
              const durationDiff =
                metricsTotalDuration(metrics) -
                metricsTotalDuration(lastMetrics)
              const usage = (100 * durationDiff) / elapsedTime
              pageCpu[pageKey] = usage
              pageMemory[pageKey] = (metrics.JSHeapUsedSize || 0) / 1e6
              this.pagesMetrics.set(pageIndex, metrics)
            }
          } else {
            this.pagesMetrics.set(pageIndex, metrics)
          }
        } */
          pageCpu[pageKey] = collectedStats.cpu as number
          pageMemory[pageKey] = collectedStats.memory as number

          // Collect throttle metrics
          const throttleUpValues = getSessionThrottleValues(
            this.throttleIndex,
            'up',
          )
          if (throttleUpValues.rate !== undefined) {
            throttleUpValuesRate[pageKey] = throttleUpValues.rate
          }
          if (throttleUpValues.delay !== undefined) {
            throttleUpValuesDelay[pageKey] = throttleUpValues.delay
          }
          if (throttleUpValues.loss !== undefined) {
            throttleUpValuesLoss[pageKey] = throttleUpValues.loss
          }
          if (throttleUpValues.queue !== undefined) {
            throttleUpValuesQueue[pageKey] = throttleUpValues.queue
          }

          const throttleDownValues = getSessionThrottleValues(
            this.throttleIndex,
            'down',
          )
          if (throttleDownValues.rate !== undefined) {
            throttleDownValuesRate[pageKey] = throttleDownValues.rate
          }
          if (throttleDownValues.delay !== undefined) {
            throttleDownValuesDelay[pageKey] = throttleDownValues.delay
          }
          if (throttleDownValues.loss !== undefined) {
            throttleDownValuesLoss[pageKey] = throttleDownValues.loss
          }
          if (throttleDownValues.queue !== undefined) {
            throttleDownValuesQueue[pageKey] = throttleDownValues.queue
          }
        } catch (err) {
          log.error(
            `collectPeerConnectionStats for page ${pageIndex} error: ${(err as Error).stack}`,
          )
        }
      }),
    )

    collectedStats.pages = pages
    if (this.pageErrors) collectedStats.errors = this.pageErrors
    if (this.pageWarnings) collectedStats.warnings = this.pageWarnings
    collectedStats.peerConnections = peerConnections
    collectedStats.peerConnectionsClosed = peerConnectionsClosed
    collectedStats.peerConnectionsDisconnected = peerConnectionsDisconnected
    collectedStats.peerConnectionsFailed = peerConnectionsFailed
    collectedStats.audioEndToEndDelay = audioEndToEndDelayStats
    collectedStats.videoEndToEndDelay = videoEndToEndDelayStats
    collectedStats.videoEndToEndNetworkDelay = videoEndToEndNetworkDelayStats
    collectedStats.httpRecvBytes = httpRecvBytesStats
    collectedStats.httpRecvBitrate = httpRecvBitrateStats
    collectedStats.httpRecvLatency = httpRecvLatencyStats
    collectedStats.cpuPressure = cpuPressureStats
    collectedStats.pageCpu = pageCpu
    collectedStats.pageMemory = pageMemory
    collectedStats.throttleUpRate = throttleUpValuesRate
    collectedStats.throttleUpDelay = throttleUpValuesDelay
    collectedStats.throttleUpLoss = throttleUpValuesLoss
    collectedStats.throttleUpQueue = throttleUpValuesQueue
    collectedStats.throttleDownRate = throttleDownValuesRate
    collectedStats.throttleDownDelay = throttleDownValuesDelay
    collectedStats.throttleDownLoss = throttleDownValuesLoss
    collectedStats.throttleDownQueue = throttleDownValuesQueue

    Object.assign(collectedStats, customStats)

    if (pages.size < this.pages.size) {
      log.warn(`updateStats collected pages ${pages.size} < ${this.pages.size}`)
    }

    this.stats = collectedStats
    return this.stats
  }

  /**
   * stop
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }
    this.running = false
    log.debug(`${this.id} stop`)

    if (this.stopPortForwarder) {
      this.stopPortForwarder()
    }

    if (this.browser) {
      // close the opened tabs
      log.debug(`${this.id} closing ${this.pages.size} pages`)
      await Promise.allSettled(
        [...this.pages.values()].map(page => {
          return page.close({ runBeforeUnload: true })
        }),
      )
      let attempts = 20
      while (this.pages.size > 0 && attempts > 0) {
        await sleep(500)
        attempts -= 1
      }
      this.browser.removeAllListeners()
      if (this.chromiumUrl) {
        log.debug(`${this.id} disconnect from browser`)
        try {
          await this.browser.disconnect()
        } catch (err) {
          log.warn(`browser disconnect error: ${(err as Error).message}`)
        }
      } else {
        log.debug(`${this.id} closing browser`)
        try {
          await this.browser.close()
        } catch (err) {
          log.error(`browser close error: ${(err as Error).stack}`)
        }
      }
      this.pages.clear()
      this.pagesMetrics.clear()
      this.browser = undefined
    }

    this.emit('stop', this.id)
  }

  /**
   * pageScreenshot
   * @param {number} pageIndex
   * @param {String} format The image format (png|jpeg|webp).
   * @return {String}
   */
  async pageScreenshot(pageIndex = 0, format = 'webp'): Promise<string> {
    log.debug(`pageScreenshot ${this.id}-${pageIndex}`)
    const index = this.id + pageIndex
    const page = this.pages.get(index)
    if (!page) {
      throw new Error(`Page ${index} not found`)
    }
    const filePath = `/tmp/screenshot-${index}.${format}`
    await page.screenshot({
      path: filePath,
      fullPage: true,
    })
    return filePath
  }
}
