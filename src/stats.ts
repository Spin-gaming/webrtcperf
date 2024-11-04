import axios from 'axios'
import chalk from 'chalk'
import * as events from 'events'
import { Stats as FastStats } from 'fast-stats'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import json5 from 'json5'
import * as path from 'path'
import * as promClient from 'prom-client'
import { PrometheusContentType } from 'prom-client'
import { sprintf } from 'sprintf-js'
import * as zlib from 'zlib'

import { PageStatsNames, RtcStatsMetricNames, parseRtStatKey } from './rtcstats'
import { Session } from './session'
import { Scheduler, enabledForSession, hideAuth, logger, toPrecision } from './utils'

export { FastStats }

const log = logger('webrtcperf:stats')

function calculateFailAmountPercentile(stat: FastStats, percentile = 95): number {
  return Math.round(stat.percentile(percentile))
}

/**
 * StatsWriter
 */
class StatsWriter {
  fname: string
  columns: string[]
  private _header_written = false

  constructor(fname = 'stats.log', columns: string[]) {
    this.fname = fname
    this.columns = columns
  }

  /**
   * push
   * @param dataColumns
   */
  async push(dataColumns: string[]): Promise<void> {
    if (!this._header_written) {
      const data = ['datetime', ...this.columns].join(',') + '\n'
      await fs.promises.mkdir(path.dirname(this.fname), { recursive: true })
      await fs.promises.writeFile(this.fname, data)
      this._header_written = true
    }
    //
    const data = [Date.now(), ...dataColumns].join(',') + '\n'
    return fs.promises.appendFile(this.fname, data)
  }
}

/**
 * formatStatsColumns
 * @param column
 */
function formatStatsColumns(column: string): string[] {
  return [
    `${column}_length`,
    `${column}_sum`,
    `${column}_mean`,
    `${column}_stdev`,
    `${column}_5p`,
    `${column}_95p`,
    `${column}_min`,
    `${column}_max`,
  ]
}

/** The Stats data collected for each metric. */
interface StatsData {
  /** The total samples collected. */
  length: number
  /** The sum of all the samples. */
  sum: number
  /** The average value. */
  mean: number
  /** The standard deviation. */
  stddev: number
  /** The 5th percentile. */
  p5: number
  /** The 95th percentile. */
  p95: number
  /** The minimum value. */
  min: number
  /** The maximum value. */
  max: number
}

type StatsDataKey = keyof StatsData

export interface CollectedStats {
  all: FastStats
  byHost: Record<string, FastStats>
  byCodec: Record<string, FastStats>
  byParticipantAndTrack: Record<string, number>
}

export interface CollectedStatsRaw {
  all: number[]
  byHost: Record<string, number[]>
  byCodec: Record<string, number[]>
  byParticipantAndTrack: Record<string, number>
}

/**
 * Formats the stats for console or for file output.
 * @param s The stats object.
 * @param forWriter If true, format the stats to be written on file.
 */
function formatStats(s: FastStats, forWriter = false): StatsData | string[] {
  if (forWriter) {
    return [
      toPrecision(s.length || 0, 0),
      toPrecision(s.sum || 0),
      toPrecision(s.amean() || 0),
      toPrecision(s.stddev() || 0),
      toPrecision(s.percentile(5) || 0),
      toPrecision(s.percentile(95) || 0),
      toPrecision(s.min || 0),
      toPrecision(s.max || 0),
    ]
  }
  return {
    length: s.length || 0,
    sum: s.sum || 0,
    mean: s.amean() || 0,
    stddev: s.stddev() || 0,
    p5: s.percentile(5) || 0,
    p95: s.percentile(95) || 0,
    min: s.min || 0,
    max: s.max || 0,
  }
}

/**
 * Formats the console stats title.
 * @param name
 */
function sprintfStatsTitle(name: string): string {
  return sprintf(chalk`-- {bold %(name)s} %(fill)s\n`, {
    name,
    fill: '-'.repeat(100 - name.length - 4),
  })
}

/**
 * Formats the console stats header.
 */
function sprintfStatsHeader(): string {
  return (
    sprintfStatsTitle(new Date().toUTCString()) +
    sprintf(
      chalk`{bold %(name)\' 30s} {bold %(length)\' 8s} {bold %(sum)\' 8s} {bold %(mean)\' 8s} {bold %(stddev)\' 8s} {bold %(p5)\' 8s} {bold %(p95)\' 8s} {bold %(min)\' 8s} {bold %(max)\' 8s}\n`,
      {
        name: 'name',
        length: 'count',
        sum: 'sum',
        mean: 'mean',
        stddev: 'stddev',
        p5: '5p',
        p95: '95p',
        min: 'min',
        max: 'max',
      },
    )
  )
}

/**
 * Format the stats for console output.
 */
function sprintfStats(
  name: string,
  stats: CollectedStats,
  format = '.2f',
  unit = '',
  scale = 1,
  hideSum = false,
): string {
  if (!stats?.all.length) {
    return ''
  }
  if (!scale) {
    scale = 1
  }
  const statsData = formatStats(stats.all) as StatsData
  return sprintf(
    chalk`{red {bold %(name)\' 30s}}` +
      chalk` {bold %(length)\' 8d}` +
      (hideSum ? '         ' : chalk` {bold %(sum)\' 8${format}}`) +
      chalk` {bold %(mean)\' 8${format}}` +
      chalk` {bold %(stddev)\' 8${format}}` +
      chalk` {bold %(p5)\' 8${format}}` +
      chalk` {bold %(p95)\' 8${format}}` +
      chalk` {bold %(min)\' 8${format}}` +
      chalk` {bold %(max)\' 8${format}}%(unit)s\n`,
    {
      name,
      length: statsData.length,
      sum: statsData.sum * scale,
      mean: statsData.mean * scale,
      stddev: statsData.stddev * scale,
      p5: statsData.p5 * scale,
      p95: statsData.p95 * scale,
      min: statsData.min * scale,
      max: statsData.max * scale,
      unit: unit ? chalk` {red {bold ${unit}}}` : '',
    },
  )
}

const promPrefix = 'wst_'

const promCreateGauge = (
  register: promClient.Registry,
  name: string,
  suffix = '',
  labelNames: string[] = [],
  collect?: () => void,
): promClient.Gauge<string> => {
  return new promClient.Gauge({
    name: `${promPrefix}${name}${suffix && '_' + suffix}`,
    help: `${name} ${suffix}`,
    labelNames,
    registers: [register],
    collect,
  })
}

/**
 * The alert rule description.
 *
 * Example:
 * ```
 cpu:
    tags:
    - performance
    failPercentile: 90
    p95:
      $gt: 10
      $lt: 100
      $after: 60
 * ```
 * It will check if the `cpu` 95th percentile is lower than 100% and greater than 10%,
 * starting the check after 60s from the test start. The alert results will be
 * grouped into the `performance` category.
 */
export type AlertRule = AlertRuleOption & AlertRuleKey

/**
 * The alert rule options.
 */
export interface AlertRuleOption {
  /** The alert results will be grouped into the specified categories.  */
  tags: string[]
  /** The alert will pass when at least `failPercentile` of the checks (95 by default) are successful. */
  failPercentile?: number
}

/**
 * The supported alert rule checks.
 */
export interface AlertRuleKey {
  /** The total collected samples. */
  length?: AlertRuleValue | AlertRuleValue[]
  /** The sum of the collected samples. */
  sum?: AlertRuleValue | AlertRuleValue[]
  /** The 95th percentile of the collected samples. */
  p95?: AlertRuleValue | AlertRuleValue[]
  /** The 5th percentile of the collected samples. */
  p5?: AlertRuleValue | AlertRuleValue[]
  /** The minimum of the collected samples. */
  min?: AlertRuleValue | AlertRuleValue[]
  /** The maximum of the collected samples. */
  max?: AlertRuleValue | AlertRuleValue[]
}

/**
 * The alert check operators.
 */
export interface AlertRuleValue {
  $eq?: number
  $gt?: number
  $lt?: number
  $gte?: number
  $lte?: number
  $after?: number
  $before?: number
  $skip_lt?: number
  $skip_lte?: number
  $skip_gt?: number
  $skip_gte?: number
}

const calculateFailAmount = (checkValue: number, ruleValue: number): number => {
  if (ruleValue) {
    return 100 * Math.min(1, Math.abs(checkValue - ruleValue) / ruleValue)
  } else {
    return 100 * Math.min(1, Math.abs(checkValue))
  }
}

/**
 * The Stats collector class.
 */
export class Stats extends events.EventEmitter {
  readonly statsPath: string
  readonly detailedStatsPath: string
  readonly prometheusPushgateway: string
  readonly prometheusPushgatewayJobName: string
  readonly prometheusPushgatewayAuth?: string
  readonly prometheusPushgatewayGzip?: boolean
  readonly showStats: boolean
  readonly showPageLog: boolean
  readonly statsInterval: number
  readonly rtcStatsTimeout: number
  readonly customMetrics: Record<string, { labels?: string[] }> = {}
  readonly startTimestamp: number
  readonly enableDetailedStats: boolean | string | number
  private readonly startTimestampString: string

  readonly sessions = new Map<number, Session>()
  nextSessionId: number
  statsWriter: StatsWriter | null
  detailedStatsWriter: StatsWriter | null
  private scheduler?: Scheduler

  private alertRules: Record<string, AlertRule> | null = null
  readonly alertRulesFilename: string
  private readonly alertRulesFailPercentile: number
  private readonly pushStatsUrl: string
  private readonly pushStatsId: string
  private readonly serverSecret: string

  private readonly alertRulesReport = new Map<
    string,
    Map<
      string,
      {
        totalFails: number
        totalFailsTime: number
        totalFailsTimePerc: number
        lastFailed: number
        valueStats: FastStats
        failAmountStats: FastStats
        failAmountPercentile: number
      }
    >
  >()
  private gateway: promClient.Pushgateway<PrometheusContentType> | null = null

  /* metricConfigGauge: promClient.Gauge<string> | null = null */
  private elapsedTimeMetric: promClient.Gauge<string> | null = null
  private metrics: Record<
    string,
    {
      length: promClient.Gauge<string>
      sum: promClient.Gauge<string>
      mean: promClient.Gauge<string>
      stddev: promClient.Gauge<string>
      p5: promClient.Gauge<string>
      p95: promClient.Gauge<string>
      min: promClient.Gauge<string>
      max: promClient.Gauge<string>
      value?: promClient.Gauge<string>
      alertRules: Record<
        string,
        {
          report: promClient.Gauge<string>
          rule: promClient.Gauge<string>
          mean: promClient.Gauge<string>
        }
      >
    }
  > = {}

  private alertTagsMetrics?: promClient.Gauge<string>
  private readonly customMetricsLabels: Record<string, string | undefined>

  collectedStats: Record<string, CollectedStats>

  collectedStatsConfig = {
    url: '',
    pages: 0,
    startTime: 0,
  }
  externalCollectedStats = new Map<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { addedTime: number; externalStats: any; config: any }
  >()
  pushStatsInstance: axios.AxiosInstance | null = null

  private running = false

  /**
   * Stats aggregator class.
   */
  constructor({
    statsPath,
    detailedStatsPath,
    prometheusPushgateway,
    prometheusPushgatewayJobName,
    prometheusPushgatewayAuth,
    prometheusPushgatewayGzip,
    showStats,
    showPageLog,
    statsInterval,
    rtcStatsTimeout,
    customMetrics,
    alertRules,
    alertRulesFilename,
    alertRulesFailPercentile,
    pushStatsUrl,
    pushStatsId,
    serverSecret,
    startSessionId,
    startTimestamp,
    enableDetailedStats,
    customMetricsLabels,
  }: {
    statsPath: string
    detailedStatsPath: string
    prometheusPushgateway: string
    prometheusPushgatewayJobName: string
    prometheusPushgatewayAuth: string
    prometheusPushgatewayGzip: boolean
    showStats: boolean
    showPageLog: boolean
    statsInterval: number
    rtcStatsTimeout: number
    customMetrics: string
    alertRules: string
    alertRulesFilename: string
    alertRulesFailPercentile: number
    pushStatsUrl: string
    pushStatsId: string
    serverSecret: string
    startSessionId: number
    startTimestamp: number
    enableDetailedStats: boolean | string | number
    customMetricsLabels?: string
  }) {
    super()
    this.statsPath = statsPath
    this.detailedStatsPath = detailedStatsPath
    this.prometheusPushgateway = prometheusPushgateway
    this.prometheusPushgatewayJobName = prometheusPushgatewayJobName || 'default'
    this.prometheusPushgatewayAuth = prometheusPushgatewayAuth || undefined
    this.prometheusPushgatewayGzip = prometheusPushgatewayGzip
    this.showStats = showStats !== undefined ? showStats : true
    this.showPageLog = !!showPageLog
    this.statsInterval = statsInterval || 10
    this.rtcStatsTimeout = Math.max(rtcStatsTimeout, this.statsInterval)
    if (customMetrics.trim()) {
      this.customMetrics = json5.parse(customMetrics)
      log.debug(`using customMetrics: ${JSON.stringify(this.customMetrics, undefined, 2)}`)
    }

    this.collectedStats = this.initCollectedStats()
    this.sessions = new Map()
    this.nextSessionId = startSessionId
    this.startTimestamp = startTimestamp || Date.now()
    this.startTimestampString = new Date(this.startTimestamp).toISOString()
    this.enableDetailedStats = enableDetailedStats
    this.customMetricsLabels = customMetricsLabels
      ? customMetricsLabels.split(',').reduce(
          (p, label) => {
            label = label.trim()
            if (label) {
              p[label] = undefined
            }
            return p
          },
          {} as typeof this.customMetricsLabels,
        )
      : {}

    this.statsWriter = null
    this.detailedStatsWriter = null
    if (alertRules.trim()) {
      this.alertRules = json5.parse(alertRules)
      log.debug(`using alertRules: ${JSON.stringify(this.alertRules, undefined, 2)}`)
    }
    this.alertRulesFilename = alertRulesFilename
    this.alertRulesFailPercentile = alertRulesFailPercentile
    this.pushStatsUrl = pushStatsUrl
    this.pushStatsId = pushStatsId
    this.serverSecret = serverSecret

    if (this.pushStatsUrl) {
      const httpAgent = new http.Agent({ keepAlive: false })
      const httpsAgent = new https.Agent({
        keepAlive: false,
        rejectUnauthorized: false,
      })
      this.pushStatsInstance = axios.create({
        httpAgent,
        httpsAgent,
        baseURL: this.pushStatsUrl,
        auth: {
          username: 'admin',
          password: this.serverSecret,
        },
        maxBodyLength: 20000000,
        transformRequest: [
          ...(axios.defaults.transformRequest as axios.AxiosRequestTransformer[]),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (data: any, headers?: axios.AxiosRequestHeaders): any => {
            if (headers && typeof data === 'string' && data.length > 16 * 1024) {
              headers['Content-Encoding'] = 'gzip'
              return zlib.gzipSync(data)
            } else {
              return data
            }
          },
        ],
      })
    }
  }

  private initCollectedStats(): Record<string, CollectedStats> {
    return this.statsNames.reduce(
      (prev, name: string) => {
        prev[name] = {
          all: new FastStats(),
          byHost: {},
          byCodec: {},
          byParticipantAndTrack: {},
        } as CollectedStats
        return prev
      },
      {} as Record<string, CollectedStats>,
    )
  }

  private get statsNames(): string[] {
    return Object.keys(PageStatsNames).concat(Object.keys(RtcStatsMetricNames)).concat(Object.keys(this.customMetrics))
  }

  /**
   * consumeSessionId
   * @param tabs the number of tabs to allocate in the same session.
   */
  consumeSessionId(tabs = 1): number {
    const id = this.nextSessionId
    this.nextSessionId += tabs
    return id
  }

  /**
   * Adds the session to the list of monitored sessions.
   */
  addSession(session: Session): void {
    log.debug(`addSession ${session.id}`)
    if (this.sessions.has(session.id)) {
      throw new Error(`session id ${session.id} already present`)
    }
    session.once('stop', id => {
      log.debug(`Session ${id} stopped`)
      this.sessions.delete(id)
    })
    this.sessions.set(session.id, session)
  }

  /**
   * Removes the session from list of monitored sessions.
   * @param id the Session id
   */
  removeSession(id: number): void {
    log.debug(`removeSession ${id}`)
    this.sessions.delete(id)
  }

  /**
   * It updates the custom label value.
   * @param label the custom metric label
   * @param value the custom metric label value
   */
  setCustomMetricLabel(label: string, value: string | undefined): void {
    if (!(label in this.customMetricsLabels)) {
      throw new Error(`Unknown custom metric label: ${label}`)
    }
    this.customMetricsLabels[label] = value
  }

  /**
   * start
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('already running')
      return
    }
    log.debug('start')
    this.running = true

    if (this.statsPath) {
      log.debug(`Logging stats into ${this.statsPath}`)
      const headers = this.statsNames.reduce((v: string[], name) => v.concat(formatStatsColumns(name)), [])
      this.statsWriter = new StatsWriter(this.statsPath, headers)
    }

    if (this.detailedStatsPath) {
      log.debug(`Logging stats into ${this.statsPath}`)
      this.detailedStatsWriter = new StatsWriter(this.detailedStatsPath, [
        'participantName',
        'trackId',
        ...this.statsNames,
      ])
    }

    if (this.prometheusPushgateway) {
      const register = new promClient.Registry()
      const agent = this.prometheusPushgateway.startsWith('https://')
        ? new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 60000,
            maxSockets: 5,
          })
        : new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 60000,
            maxSockets: 5,
          })
      this.gateway = new promClient.Pushgateway(
        this.prometheusPushgateway,
        {
          timeout: 5000,
          auth: this.prometheusPushgatewayAuth,
          rejectUnauthorized: false,
          agent,
          headers: this.prometheusPushgatewayGzip
            ? {
                'Content-Encoding': 'gzip',
              }
            : undefined,
        },
        register,
      )

      // promClient.collectDefaultMetrics({ prefix: promPrefix, register })

      this.elapsedTimeMetric = promCreateGauge(
        register,
        'elapsedTime',
        '',
        ['datetime', ...Object.keys(this.customMetricsLabels)],
        () =>
          this.elapsedTimeMetric?.set(
            {
              datetime: this.startTimestampString,
              ...this.customMetricsLabels,
            },
            (Date.now() - this.startTimestamp) / 1000,
          ),
      )

      // Export rtc stats.
      this.statsNames.forEach(name => {
        this.metrics[name] = {
          length: promCreateGauge(register, name, 'length', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          sum: promCreateGauge(register, name, 'sum', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          mean: promCreateGauge(register, name, 'mean', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          stddev: promCreateGauge(register, name, 'stddev', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          p5: promCreateGauge(register, name, 'p5', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          p95: promCreateGauge(register, name, 'p95', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          min: promCreateGauge(register, name, 'min', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          max: promCreateGauge(register, name, 'max', [
            'host',
            'codec',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ]),
          alertRules: {},
        }

        if (this.enableDetailedStats !== false) {
          this.metrics[name].value = promCreateGauge(register, name, '', [
            'participantName',
            'trackId',
            'datetime',
            ...Object.keys(this.customMetricsLabels),
          ])
        }

        if (this.alertRules && this.alertRules[name]) {
          const rule = this.alertRules[name]
          for (const ruleKey of Object.keys(rule)) {
            const ruleName = `alert_${name}_${ruleKey}`
            this.metrics[name].alertRules[ruleName] = {
              report: promCreateGauge(register, ruleName, 'report', [
                'rule',
                'datetime',
                ...Object.keys(this.customMetricsLabels),
              ]),
              rule: promCreateGauge(register, ruleName, '', [
                'rule',
                'datetime',
                ...Object.keys(this.customMetricsLabels),
              ]),
              mean: promCreateGauge(register, ruleName, 'mean', [
                'rule',
                'datetime',
                ...Object.keys(this.customMetricsLabels),
              ]),
            }
          }
        }
      })

      if (this.alertRules) {
        this.alertTagsMetrics = promCreateGauge(register, `alert_report`, '', [
          'datetime',
          'tag',
          ...Object.keys(this.customMetricsLabels),
        ])
      }

      await this.deletePushgatewayStats()
    }

    this.scheduler = new Scheduler('stats', this.statsInterval, this.collectStats.bind(this))
    this.scheduler.start()
  }

  async deletePushgatewayStats(): Promise<void> {
    if (!this.gateway) {
      return
    }
    try {
      const { resp, body } = await this.gateway.delete({
        jobName: this.prometheusPushgatewayJobName,
      })
      if ((body as string).length) {
        log.warn(`Pushgateway delete error ${(resp as http.ServerResponse).statusCode}: ${body as string}`)
      }
    } catch (err) {
      log.error(`Pushgateway delete error: ${(err as Error).stack}`)
    }
  }

  /**
   * collectStats
   */
  async collectStats(now: number): Promise<void> {
    if (!this.running) {
      return
    }
    // log.debug(`statsInterval ${this.sessions.size} sessions`);
    if (!this.sessions.size && !this.externalCollectedStats.size) {
      return
    }
    // Prepare config.
    this.collectedStatsConfig.pages = 0
    this.collectedStatsConfig.startTime = this.startTimestamp
    // Reset collectedStats object.
    Object.values(this.collectedStats).forEach(stats => {
      stats.all.reset()
      Object.values(stats.byHost).forEach(s => s.reset())
      Object.values(stats.byCodec).forEach(s => s.reset())
      stats.byParticipantAndTrack = {}
    })
    for (const [sessionId, session] of this.sessions.entries()) {
      this.collectedStatsConfig.url = `${hideAuth(session.url)}?${session.urlQuery}`
      this.collectedStatsConfig.pages += session.pages.size || 0
      const sessionStats = await session.updateStats()
      for (const [name, obj] of Object.entries(sessionStats)) {
        if (obj === undefined) {
          return
        }
        //log.log(name, obj)
        try {
          const collectedStats = this.collectedStats[name]
          if (typeof obj === 'number' && isFinite(obj)) {
            collectedStats.all.push(obj)
          } else {
            for (const [key, value] of Object.entries(obj)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (typeof value === 'number' && isFinite(value as any)) {
                collectedStats.all.push(value)
                // Push host label.
                const { trackId, hostName, participantName } = parseRtStatKey(key)
                let stats = collectedStats.byHost[hostName]
                if (!stats) {
                  stats = collectedStats.byHost[hostName] = new FastStats()
                }
                stats.push(value)
                // Push participant and track values.
                if (enabledForSession(sessionId, this.enableDetailedStats) && participantName) {
                  collectedStats.byParticipantAndTrack[`${participantName}:${trackId || ''}`] = value
                }
              } else if (typeof value === 'string') {
                // Codec stats.
                collectedStats.all.push(1)
                let stats = collectedStats.byCodec[value]
                if (!stats) {
                  stats = collectedStats.byCodec[value] = new FastStats()
                }
                stats.push(1)
              }
            }
          }
        } catch (err) {
          log.error(`session getStats name: ${name} error: ${(err as Error).stack}`, err)
        }
      }
    }
    // Add external collected stats.
    for (const [id, data] of this.externalCollectedStats.entries()) {
      const { addedTime, externalStats, config } = data
      if (now - addedTime > this.rtcStatsTimeout * 1000) {
        log.debug(`remove externalCollectedStats from ${id}`)
        this.externalCollectedStats.delete(id)
        continue
      }
      log.debug(`add external stats from ${id}`)
      // Add external config settings.
      if (config.url) {
        this.collectedStatsConfig.url = config.url
      }
      if (config.pages) {
        this.collectedStatsConfig.pages += config.pages
      }
      // Add metrics.
      this.statsNames.forEach(name => {
        const stats = externalStats[name] as CollectedStatsRaw
        if (!stats) {
          return
        }
        const collectedStats = this.collectedStats[name]
        collectedStats.all.push(stats.all)
        Object.entries(stats.byHost).forEach(([host, values]) => {
          if (!collectedStats.byHost[host]) {
            collectedStats.byHost[host] = new FastStats()
          }
          collectedStats.byHost[host].push(values)
        })
        Object.entries(stats.byCodec).forEach(([codec, values]) => {
          if (!collectedStats.byCodec[codec]) {
            collectedStats.byCodec[codec] = new FastStats()
          }
          collectedStats.byCodec[codec].push(values)
        })
        Object.entries(stats.byParticipantAndTrack).forEach(([label, value]) => {
          collectedStats.byParticipantAndTrack[label] = value
        })
      })
    }
    this.emit('stats', this.collectedStats)
    // Push to an external instance.
    if (this.pushStatsInstance) {
      const pushStats: Record<string, CollectedStatsRaw> = {}
      for (const [name, stats] of Object.entries(this.collectedStats)) {
        pushStats[name] = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          all: (stats.all as any).data,
          byHost: {},
          byCodec: {},
          byParticipantAndTrack: {},
        }
        Object.entries(stats.byHost).forEach(([host, stat]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pushStats[name].byHost[host] = (stat as any).data
        })
        Object.entries(stats.byCodec).forEach(([codec, stat]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pushStats[name].byCodec[codec] = (stat as any).data
        })
        Object.entries(stats.byParticipantAndTrack).forEach(([label, value]) => {
          pushStats[name].byParticipantAndTrack[label] = value
        })
      }
      try {
        const res = await this.pushStatsInstance.put('/collected-stats', {
          id: this.pushStatsId,
          stats: pushStats,
          config: this.collectedStatsConfig,
        })
        log.debug(`pushStats message=${res.data.message}`)
      } catch (err) {
        log.error(`pushStats error: ${(err as Error).stack}`)
      }
    }
    // Check alerts.
    this.checkAlertRules()
    // Show to console.
    this.consoleShowStats()

    await Promise.allSettled([
      this.writeStats(),
      this.writeDetailedStats(),
      this.sendToPushGateway(),
      this.writeAlertRulesReport(),
    ])
  }

  async writeStats() {
    if (!this.statsWriter) return
    const values = this.statsNames.reduce(
      (v: string[], name) => v.concat(formatStats(this.collectedStats[name].all, true) as string[]),
      [],
    )
    await this.statsWriter.push(values)
  }

  async writeDetailedStats() {
    if (!this.detailedStatsWriter) return
    const participantStats = new Map<string, Record<string, string>>()
    const participantTrackStats = new Map<string, Record<string, string>>()
    Object.entries(this.collectedStats).forEach(([name, stats]) => {
      Object.entries(stats.byParticipantAndTrack).forEach(([label, value]) => {
        const [participantName, trackId] = label.split(':', 2)
        if (!trackId) {
          let stats = participantStats.get(participantName)
          if (!stats) {
            stats = {}
            participantStats.set(participantName, stats)
          }
          stats[name] = toPrecision(value, 6)
        } else {
          let stats = participantTrackStats.get(label)
          if (!stats) {
            stats = {}
            participantTrackStats.set(label, stats)
          }
          stats[name] = toPrecision(value, 6)
        }
      })
    })
    for (const [label, trackStats] of participantTrackStats.entries()) {
      const [participantName, trackId] = label.split(':', 2)
      const stats = participantStats.get(participantName) || {}
      const values = [participantName, trackId]
      for (const name of this.statsNames) {
        if (trackStats[name] !== undefined) {
          values.push(trackStats[name])
        } else if (stats[name] !== undefined) {
          values.push(stats[name])
        } else {
          values.push('')
        }
      }
      await this.detailedStatsWriter.push(values)
    }
  }

  /**
   * addCollectedStats
   * @param id
   * @param externalStats
   * @param config
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addExternalCollectedStats(id: string, externalStats: any, config: any): void {
    log.debug(`addExternalCollectedStats from ${id}`)
    const addedTime = Date.now()
    this.externalCollectedStats.set(id, { addedTime, externalStats, config })
  }

  /**
   * It display stats on the console.
   */
  consoleShowStats(): void {
    if (!this.showStats) {
      return
    }
    const stats = this.collectedStats
    let out =
      sprintfStatsHeader() +
      sprintfStats('System CPU', stats.usedCpu, '.2f', '%', undefined, true) +
      sprintfStats('System GPU', stats.usedGpu, '.2f', '%', undefined, true) +
      sprintfStats('System Memory', stats.usedMemory, '.2f', '%', undefined, true) +
      sprintfStats('CPU/page', stats.cpu, '.2f', '%') +
      sprintfStats('Memory/page', stats.memory, '.2f', 'MB') +
      sprintfStats('Pages', stats.pages, 'd', '') +
      sprintfStats('Errors', stats.errors, 'd', '') +
      sprintfStats('Warnings', stats.warnings, 'd', '') +
      sprintfStats('Peer Connections', stats.peerConnections, 'd', '') +
      sprintfStats('audioSubscribeDelay', stats.audioSubscribeDelay, 'd', 'ms', undefined, true) +
      sprintfStats('videoSubscribeDelay', stats.videoSubscribeDelay, 'd', 'ms', undefined, true) +
      // inbound audio
      sprintfStatsTitle('Inbound audio') +
      sprintfStats('received', stats.audioBytesReceived, '.2f', 'MB', 1e-6) +
      sprintfStats('rate', stats.audioRecvBitrates, '.2f', 'Kbps', 1e-3) +
      sprintfStats('lost', stats.audioRecvPacketsLost, '.2f', '%', undefined, true) +
      sprintfStats('jitter', stats.audioRecvJitter, '.2f', 's', undefined, true) +
      sprintfStats('avgJitterBufferDelay', stats.audioRecvAvgJitterBufferDelay, '.2f', 'ms', 1e3, true) +
      // inbound video
      sprintfStatsTitle('Inbound video') +
      sprintfStats('received', stats.videoRecvBytes, '.2f', 'MB', 1e-6) +
      sprintfStats('decoded', stats.videoFramesDecoded, 'd', 'frames') +
      sprintfStats('rate', stats.videoRecvBitrates, '.2f', 'Kbps', 1e-3) +
      sprintfStats('lost', stats.videoRecvPacketsLost, '.2f', '%', undefined, true) +
      sprintfStats('jitter', stats.videoRecvJitter, '.2f', 's', undefined, true) +
      sprintfStats('avgJitterBufferDelay', stats.videoRecvAvgJitterBufferDelay, '.2f', 'ms', 1e3, true) +
      sprintfStats('width', stats.videoRecvWidth, 'd', 'px', undefined, true) +
      sprintfStats('height', stats.videoRecvHeight, 'd', 'px', undefined, true) +
      sprintfStats('fps', stats.videoRecvFps, 'd', 'fps', undefined, true) +
      sprintfStats('firCountSent', stats.firCountSent, 'd', '', undefined, true) +
      sprintfStats('pliCountSent', stats.pliCountSent, 'd', '', undefined, true) +
      // outbound audio
      sprintfStatsTitle('Outbound audio') +
      sprintfStats('sent', stats.audioBytesSent, '.2f', 'MB', 1e-6) +
      sprintfStats('retransmitted', stats.audioRetransmittedBytesSent, '.2f', 'MB', 1e-6) +
      sprintfStats('rate', stats.audioSentBitrates, '.2f', 'Kbps', 1e-3) +
      sprintfStats('lost', stats.audioSentPacketsLost, '.2f', '%', undefined, true) +
      sprintfStats('roundTripTime', stats.audioSentRoundTripTime, '.3f', 's', undefined, true) +
      // outbound video
      sprintfStatsTitle('Outbound video') +
      sprintfStats('sent', stats.videoSentBytes, '.2f', 'MB', 1e-6) +
      sprintfStats('retransmitted', stats.videoSentRetransmittedBytes, '.2f', 'MB', 1e-6) +
      sprintfStats('rate', stats.videoSentBitrates, '.2f', 'Kbps', 1e-3) +
      sprintfStats('lost', stats.videoSentPacketsLost, '.2f', '%', undefined, true) +
      sprintfStats('roundTripTime', stats.videoSentRoundTripTime, '.3f', 's', undefined, true) +
      sprintfStats('qualityLimitResolutionChanges', stats.videoQualityLimitationResolutionChanges, 'd', '') +
      sprintfStats('qualityLimitationCpu', stats.videoQualityLimitationCpu, 'd', '%') +
      sprintfStats('qualityLimitationBandwidth', stats.videoQualityLimitationBandwidth, 'd', '%') +
      sprintfStats('sentActiveSpatialLayers', stats.videoSentActiveSpatialLayers, 'd', 'layers', undefined, true) +
      sprintfStats('sentMaxBitrate', stats.videoSentMaxBitrate, '.2f', 'Kbps', 1e-3) +
      sprintfStats('width', stats.videoSentWidth, 'd', 'px', undefined, true) +
      sprintfStats('height', stats.videoSentHeight, 'd', 'px', undefined, true) +
      sprintfStats('fps', stats.videoSentFps, 'd', 'fps', undefined, true) +
      sprintfStats('firCountReceived', stats.videoFirCountReceived, 'd', '', undefined, true) +
      sprintfStats('pliCountReceived', stats.videoPliCountReceived, 'd', '', undefined, true)
    if (this.alertRules) {
      const report = this.formatAlertRulesReport()
      if (report.length) {
        out += sprintfStatsTitle('Alert rules report')
        out += report
      }
    }

    if (!this.showPageLog) {
      console.clear()
    }
    console.log(out)
  }

  /**
   * sendToPushGateway
   */
  async sendToPushGateway(): Promise<void> {
    if (!this.gateway || !this.running) {
      return
    }
    const elapsedSeconds = (Date.now() - this.startTimestamp) / 1000
    const datetime = this.startTimestampString

    Object.entries(this.metrics).forEach(([name, metric]) => {
      if (!this.collectedStats[name]) {
        return
      }

      const setStats = (stats: FastStats, host: string, codec: string): void => {
        const labels = { host, codec, datetime, ...this.customMetricsLabels }
        const { length, sum, mean, stddev, p5, p95, min, max } = formatStats(stats) as StatsData
        metric.length.set(labels, length)
        metric.sum.set(labels, sum)
        metric.mean.set(labels, mean)
        metric.stddev.set(labels, stddev)
        metric.p5.set(labels, p5)
        metric.p95.set(labels, p95)
        metric.min.set(labels, min)
        metric.max.set(labels, max)
      }

      setStats(this.collectedStats[name].all, 'all', 'all')
      Object.entries(this.collectedStats[name].byHost).forEach(([host, stats]) => {
        setStats(stats, host, 'all')
      })
      Object.entries(this.collectedStats[name].byCodec).forEach(([codec, stats]) => {
        setStats(stats, 'all', codec)
      })
      if (metric.value) {
        Object.entries(this.collectedStats[name].byParticipantAndTrack).forEach(([label, value]) => {
          const [participantName, trackId] = label.split(':', 2)
          metric.value?.set(
            {
              participantName,
              trackId,
              datetime,
              ...this.customMetricsLabels,
            },
            value,
          )
        })
      }

      // Set alerts metrics.
      if (this.alertRules && this.alertRules[name]) {
        const rule = this.alertRules[name]
        // eslint-disable-next-line prefer-const
        for (let [ruleKey, ruleValues] of Object.entries(rule)) {
          if (ruleKey === 'tags') {
            continue
          }
          if (!Array.isArray(ruleValues)) {
            ruleValues = [ruleValues as AlertRuleValue]
          } else {
            ruleValues = ruleValues as AlertRuleValue[]
          }
          for (const ruleValue of ruleValues) {
            // Send rule values as metrics.
            if (ruleValue.$after !== undefined && elapsedSeconds < ruleValue.$after) {
              continue
            }
            const ruleName = `alert_${name}_${ruleKey}`
            const ruleObj = this.metrics[name].alertRules[ruleName]
            const remove = ruleValue.$before !== undefined && elapsedSeconds > ruleValue.$before
            // Send rule report as metric.
            const ruleDesc = this.getAlertRuleDesc(ruleKey, ruleValue)
            const report = this.alertRulesReport.get(name)
            if (report) {
              const ruleReport = report.get(ruleDesc)
              if (ruleReport) {
                const labels = {
                  rule: ruleDesc,
                  datetime,
                  ...this.customMetricsLabels,
                }
                if (!remove) {
                  ruleObj.report.set(labels, ruleReport.failAmountPercentile)
                  ruleObj.mean.set(labels, ruleReport.valueStats.amean())
                } else {
                  ruleObj.report.remove(labels)
                  ruleObj.mean.remove(labels)
                }
              }
            }
            // Send rules values as metrics.
            if (ruleValue.$eq !== undefined) {
              const labels = {
                rule: `${name} ${ruleKey} =`,
                datetime,
                ...this.customMetricsLabels,
              }
              if (!remove) {
                ruleObj.rule.set(labels, ruleValue.$eq)
              } else {
                ruleObj.rule.remove(labels)
              }
            }
            if (ruleValue.$lt !== undefined) {
              const labels = {
                rule: `${name} ${ruleKey} <`,
                datetime,
                ...this.customMetricsLabels,
              }
              if (!remove) {
                ruleObj.rule.set(labels, ruleValue.$lt)
              } else {
                ruleObj.rule.remove(labels)
              }
            }
            if (ruleValue.$lte !== undefined) {
              const labels = {
                rule: `${name} ${ruleKey} <=`,
                datetime,
                ...this.customMetricsLabels,
              }
              if (!remove) {
                ruleObj.rule.set(labels, ruleValue.$lte)
              } else {
                ruleObj.rule.remove(labels)
              }
            }
            if (ruleValue.$gt !== undefined) {
              const labels = {
                rule: `${name} ${ruleKey} >`,
                datetime,
                ...this.customMetricsLabels,
              }
              if (!remove) {
                ruleObj.rule.set(labels, ruleValue.$gt)
              } else {
                ruleObj.rule.remove(labels)
              }
            }
            if (ruleValue.$gte !== undefined) {
              const labels = {
                rule: `${name} ${ruleKey} >=`,
                datetime,
                ...this.customMetricsLabels,
              }
              if (!remove) {
                ruleObj.rule.set(labels, ruleValue.$gte)
              } else {
                ruleObj.rule.remove(labels)
              }
            }
          }
        }
      }
    })

    const alertRulesReportTags = this.getAlertRulesTags()
    if (alertRulesReportTags && this.alertTagsMetrics) {
      for (const [tag, stat] of alertRulesReportTags.entries()) {
        this.alertTagsMetrics.set(
          { datetime, tag, ...this.customMetricsLabels },
          calculateFailAmountPercentile(stat, this.alertRulesFailPercentile),
        )
      }
    }

    try {
      const { resp, body } = await this.gateway.push({
        jobName: this.prometheusPushgatewayJobName,
      })
      if ((body as string).length) {
        log.warn(`Pushgateway error ${(resp as http.ServerResponse).statusCode}: ${body as string}`)
      }
    } catch (err) {
      log.error(`Pushgateway push error: ${(err as Error).stack}`)
    }
  }

  /**
   * alertRuleDesc
   */
  getAlertRuleDesc(ruleKey: string, ruleValue: AlertRuleValue): string {
    const ruleDescs = []
    if (ruleValue.$eq !== undefined) {
      ruleDescs.push(`= ${ruleValue.$eq}`)
    }
    if (ruleValue.$gt !== undefined) {
      ruleDescs.push(`> ${ruleValue.$gt}`)
    }
    if (ruleValue.$gte !== undefined) {
      ruleDescs.push(`>= ${ruleValue.$gte}`)
    }
    if (ruleValue.$lt !== undefined) {
      ruleDescs.push(`< ${ruleValue.$lt}`)
    }
    if (ruleValue.$lte !== undefined) {
      ruleDescs.push(`<= ${ruleValue.$lte}`)
    }
    let ruleDesc = `${ruleKey} ${ruleDescs.join(' and ')}`
    if (ruleValue.$after !== undefined) {
      ruleDesc += ` after ${ruleValue.$after}s`
    }
    if (ruleValue.$before !== undefined) {
      ruleDesc += ` before ${ruleValue.$before}s`
    }
    return ruleDesc
  }

  /**
   * checkAlertRules
   */
  checkAlertRules(): void {
    if (!this.alertRules || !this.running) {
      return
    }
    const now = Date.now()
    const elapsedSeconds = (now - this.startTimestamp) / 1000

    for (const [key, rule] of Object.entries(this.alertRules)) {
      if (!this.collectedStats[key]) {
        continue
      }
      let failPercentile = this.alertRulesFailPercentile
      const value = formatStats(this.collectedStats[key].all) as StatsData
      // eslint-disable-next-line prefer-const
      for (let [ruleKey, ruleValues] of Object.entries(rule)) {
        if (['tags', 'failPercentile'].includes(ruleKey)) {
          if (ruleKey === 'failPercentile') {
            failPercentile = ruleValues as number
          }
          continue
        }
        if (!Array.isArray(ruleValues)) {
          ruleValues = [ruleValues as AlertRuleValue]
        } else {
          ruleValues = ruleValues as AlertRuleValue[]
        }
        let ruleElapsedSeconds = elapsedSeconds
        for (const ruleValue of ruleValues) {
          if (
            (ruleValue.$after !== undefined && elapsedSeconds < ruleValue.$after) ||
            (ruleValue.$before !== undefined && elapsedSeconds > ruleValue.$before)
          ) {
            continue
          }
          if (ruleValue.$after !== undefined) {
            ruleElapsedSeconds -= ruleValue.$after
          }
          const checkValue = value[ruleKey as StatsDataKey]
          if (!isFinite(checkValue)) {
            continue
          }
          const ruleDesc = this.getAlertRuleDesc(ruleKey, ruleValue)
          let failed = false
          let failAmount = 0

          if (
            (ruleValue.$skip_lt !== undefined && checkValue < ruleValue.$skip_lt) ||
            (ruleValue.$skip_lte !== undefined && checkValue <= ruleValue.$skip_lte) ||
            (ruleValue.$skip_gt !== undefined && checkValue > ruleValue.$skip_gt) ||
            (ruleValue.$skip_gte !== undefined && checkValue >= ruleValue.$skip_gte)
          ) {
            continue
          }

          if (ruleValue.$eq !== undefined) {
            if (checkValue !== ruleValue.$eq) {
              failed = true
              failAmount = calculateFailAmount(checkValue, ruleValue.$eq)
            }
          } else {
            if (ruleValue.$lt !== undefined) {
              if (checkValue >= ruleValue.$lt) {
                failed = true
                failAmount = calculateFailAmount(checkValue, ruleValue.$lt)
              }
            } else if (ruleValue.$lte !== undefined) {
              if (checkValue > ruleValue.$lte) {
                failed = true
                failAmount = calculateFailAmount(checkValue, ruleValue.$lte)
              }
            }
            if (!failed) {
              if (ruleValue.$gt !== undefined) {
                if (checkValue <= ruleValue.$gt) {
                  failed = true
                  failAmount = calculateFailAmount(checkValue, ruleValue.$gt)
                }
              } else if (ruleValue.$gte !== undefined) {
                if (checkValue < ruleValue.$gte) {
                  failed = true
                  failAmount = calculateFailAmount(checkValue, ruleValue.$gte)
                }
              }
            }
          }
          // Report if failed or not.
          this.updateRulesReport(key, checkValue, ruleDesc, failed, failAmount, now, ruleElapsedSeconds, failPercentile)
        }
      }
    }
  }

  /**
   * addFailedRule
   */
  updateRulesReport(
    key: string,
    checkValue: number,
    ruleDesc: string,
    failed: boolean,
    failAmount: number,
    now: number,
    elapsedSeconds: number,
    failPercentile: number,
  ): void {
    if (failed) {
      log.debug(
        `updateRulesReport ${key}.${ruleDesc} failed: ${failed} checkValue: ${checkValue} failAmount: ${failAmount} elapsedSeconds: ${elapsedSeconds}`,
      )
    }
    let report = this.alertRulesReport.get(key)
    if (!report) {
      report = new Map()
      this.alertRulesReport.set(key, report)
    }
    let reportValue = report.get(ruleDesc)
    if (!reportValue) {
      reportValue = {
        totalFails: 0,
        totalFailsTime: 0,
        totalFailsTimePerc: 0,
        lastFailed: 0,
        valueStats: new FastStats(),
        failAmountStats: new FastStats(),
        failAmountPercentile: 0,
      }
      report.set(ruleDesc, reportValue)
    }
    if (failed) {
      reportValue.totalFails += 1
      if (reportValue.lastFailed) {
        reportValue.totalFailsTime += (now - reportValue.lastFailed) / 1000
      }
      reportValue.lastFailed = now
    } else {
      reportValue.lastFailed = 0
    }
    reportValue.totalFailsTimePerc = Math.round((100 * reportValue.totalFailsTime) / elapsedSeconds)
    reportValue.valueStats.push(checkValue)
    reportValue.failAmountStats.push(failAmount)
    reportValue.failAmountPercentile = calculateFailAmountPercentile(reportValue.failAmountStats, failPercentile)
  }

  getAlertRulesTags(): Map<string, FastStats> | undefined {
    if (!this.alertRules) {
      return
    }
    const alertRulesReportTags = new Map<string, FastStats>()
    for (const [key, report] of this.alertRulesReport.entries()) {
      const tags = this.alertRules[key].tags || []
      for (const tag of tags) {
        if (!alertRulesReportTags.has(tag)) {
          alertRulesReportTags.set(tag, new FastStats())
        }
      }
      for (const reportValue of report.values()) {
        const { failAmountPercentile } = reportValue
        for (const tag of tags) {
          const stat = alertRulesReportTags.get(tag)
          if (!stat) {
            continue
          }
          stat.push(failAmountPercentile)
        }
      }
    }
    return alertRulesReportTags
  }

  /**
   * formatAlertRulesReport
   * @param ext
   */
  formatAlertRulesReport(ext: string | null = null): string {
    if (!this.alertRulesReport || !this.alertRules) {
      return ''
    }
    // Update tags values.
    const alertRulesReportTags = this.getAlertRulesTags()!
    // JSON output.
    if (ext === 'json') {
      const out = {
        tags: {} as Record<string, number>,
        reports: {} as Record<
          string,
          {
            totalFails: number
            totalFailsTime: number
            totalFailsTimePerc: number
            failAmount: number
            count: number
            valueAverage: number
            // failAmountStats: number[]
          }
        >,
      }
      for (const [key, report] of this.alertRulesReport.entries()) {
        for (const [reportDesc, reportValue] of report.entries()) {
          const { totalFails, totalFailsTime, valueStats, totalFailsTimePerc, failAmountStats, failAmountPercentile } =
            reportValue
          if (totalFails) {
            out.reports[`${key} ${reportDesc}`] = {
              totalFails,
              totalFailsTime: Math.round(totalFailsTime),
              valueAverage: valueStats.amean(),
              totalFailsTimePerc,
              failAmount: failAmountPercentile,
              count: failAmountStats.length,

              // failAmountStats: (failAmountStats as any).data as number[],
            }
          }
        }
      }
      for (const [tag, stat] of alertRulesReportTags.entries()) {
        out.tags[tag] = calculateFailAmountPercentile(stat, this.alertRulesFailPercentile)
      }
      return JSON.stringify(out, null, 2)
    }
    // Textual output.
    let out = ''
    // Calculate max column size.
    let colSize = 20
    for (const [key, report] of this.alertRulesReport.entries()) {
      for (const [reportDesc, reportValue] of report.entries()) {
        const { totalFails, totalFailsTimePerc } = reportValue
        if (totalFails && totalFailsTimePerc > 0) {
          const check = `${key} ${reportDesc}`
          colSize = Math.max(colSize, check.length)
        }
      }
    }
    if (ext) {
      out += sprintf(
        `| %(check)-${colSize}s | %(total)-10s | %(totalFailsTime)-15s | %(totalFailsTimePerc)-15s | %(failAmount)-15s |\n`,
        {
          check: 'Condition',
          total: 'Fails',
          totalFailsTime: 'Fail time (s)',
          totalFailsTimePerc: 'Fail time (%)',
          failAmount: 'Fail amount %',
        },
      )
    } else {
      out += sprintf(
        chalk`{bold %(check)-${colSize}s} {bold %(total)-10s} {bold %(totalFailsTime)-15s} {bold %(totalFailsTimePerc)-15s} {bold %(failAmount)-15s}\n`,
        {
          check: 'Condition',
          total: 'Fails',
          totalFailsTime: 'Fail time (s)',
          totalFailsTimePerc: 'Fail time (%)',
          failAmount: 'Fail amount %',
        },
      )
    }
    for (const [key, report] of this.alertRulesReport.entries()) {
      for (const [reportDesc, reportValue] of report.entries()) {
        const { totalFails, totalFailsTime, failAmountPercentile, totalFailsTimePerc } = reportValue
        if (totalFails && totalFailsTimePerc > 0) {
          if (ext) {
            out += sprintf(
              `| %(check)-${colSize}s | %(totalFails)-10s | %(totalFailsTime)-15s | %(totalFailsTimePerc)-15s | %(failAmountPercentile)-15s |\n`,
              {
                check: `${key} ${reportDesc}`,
                totalFails,
                totalFailsTime: Math.round(totalFailsTime),
                totalFailsTimePerc,
                failAmountPercentile,
              },
            )
          } else {
            out += sprintf(
              chalk`{red {bold %(check)-${colSize}s}} {bold %(totalFails)-10s} {bold %(totalFailsTime)-15s} {bold %(totalFailsTimePerc)-15s} {bold %(failAmountPercentile)-15s}\n`,
              {
                check: `${key} ${reportDesc}`,
                totalFails,
                totalFailsTime: Math.round(totalFailsTime),
                totalFailsTimePerc,
                failAmountPercentile,
              },
            )
          }
        }
      }
    }
    // Tags report.
    if (ext) {
      out += sprintf(`%(fill)s\n`, { fill: '-'.repeat(colSize + 15 + 7) })

      out += sprintf(`| %(name)-${colSize}s | %(failPerc)-15s |\n`, {
        name: 'Tag',
        failPerc: 'Fail %',
      })
    } else {
      out += sprintf(`%(fill)s\n`, { fill: '-'.repeat(colSize + 15) })

      out += sprintf(chalk`{bold %(name)-${colSize}s} {bold %(failPerc)-15s}\n`, {
        name: 'Tag',
        failPerc: 'Fail %',
      })
    }
    for (const [tag, stat] of alertRulesReportTags.entries()) {
      const failPerc = calculateFailAmountPercentile(stat, this.alertRulesFailPercentile)
      if (ext) {
        out += sprintf(`| %(tag)-${colSize}s | %(failPerc)-15s |\n`, {
          tag,
          failPerc,
        })
      } else {
        const color = failPerc < 5 ? 'green' : failPerc < 25 ? 'yellowBright' : failPerc < 50 ? 'yellow' : 'red'

        out += sprintf(chalk`{${color} {bold %(tag)-${colSize}s %(failPerc)-15s}}\n`, {
          tag,
          failPerc,
        })
      }
    }
    return out
  }

  /**
   * writeAlertRulesReport
   */
  async writeAlertRulesReport(): Promise<void> {
    if (!this.alertRules || !this.alertRulesFilename || !this.running) {
      return
    }
    log.debug(`writeAlertRulesReport writing in ${this.alertRulesFilename}`)
    try {
      const ext = this.alertRulesFilename.split('.').slice(-1)[0]
      const report = this.formatAlertRulesReport(ext)
      if (!report.length) {
        return
      }
      let out
      if (ext === 'log') {
        const lines = report.split('\n').filter(line => line.length)
        const name = `Alert rules report (${new Date().toISOString()})`
        out = sprintf(`-- %(name)s %(fill)s\n`, {
          name,
          fill: '-'.repeat(Math.max(4, lines[0].length - name.length - 4)),
        })
        out += report
        out += sprintf(`%(fill)s\n`, {
          fill: '-'.repeat(lines[lines.length - 1].length),
        })
      } else {
        out = report
      }
      await fs.promises.mkdir(path.dirname(this.alertRulesFilename), {
        recursive: true,
      })
      await fs.promises.writeFile(this.alertRulesFilename, out)
    } catch (err) {
      log.error(`writeAlertRulesReport error: ${(err as Error).stack}`)
    }
  }

  /**
   * Stop the stats collector and the added Sessions.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }
    this.running = false
    log.debug('stop')
    if (this.scheduler) {
      this.scheduler.stop()
      this.scheduler = undefined
    }

    for (const session of this.sessions.values()) {
      try {
        session.removeAllListeners()
        await session.stop()
      } catch (err) {
        log.error(`session stop error: ${(err as Error).stack}`)
      }
    }
    this.sessions.clear()

    this.statsWriter = null

    // delete metrics
    if (this.gateway) {
      await this.deletePushgatewayStats()
      this.gateway = null
      this.metrics = {}
    }

    this.collectedStats = this.initCollectedStats()
    this.externalCollectedStats.clear()
  }
}
