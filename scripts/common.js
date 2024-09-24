// Global namespace.
const webrtcperf = {}

// Capture console messages in a serialized format.
webrtcperf.safeStringify = obj => {
  const values = new Set()
  try {
    const ret = JSON.stringify(obj, (_, v) => {
      if (typeof v !== 'object' || v === null || v === undefined) return v
      if (values.has(v)) return
      values.add(v)
      return v
    })
    if (ret === '{}') {
      return obj.toString()
    }
    return ret
  } catch (err) {
    return obj.toString()
  } finally {
    values.clear()
  }
}
;['error', 'warn', 'info', 'log', 'debug'].forEach(method => {
  const nativeFn = console[method].bind(console)
  console[method] = function (...args) {
    const customArgs = args
      .map(arg => {
        if (typeof arg === 'object') {
          return webrtcperf.safeStringify(arg)
        } else if (typeof arg === 'string') {
          if (arg.match(/^color: /)) {
            return ''
          }
          return arg.replace(/%c/g, '')
        }
        return arg !== undefined ? arg.toString() : 'undefined'
      })
      .filter(arg => arg.length > 0)
      .join(' ')
    void window.serializedConsoleLog(method, customArgs)

    return nativeFn(...args)
  }
})

/**
 * log
 * @param  {...any} args args
 */
function log(...args) {
  console.log.apply(null, [`[webrtcperf-${window.WEBRTC_PERF_INDEX}]`, ...args])
}

/**
 * sleep
 * @param  {number} ms ms
 * @return {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * getParticipantName
 */
window.getParticipantName = (index = window.WEBRTC_PERF_INDEX || 0) => {
  return `Participant-${index.toString().padStart(6, '0')}`
}

window.getParticipantNameForSave = (sendrecv, track) => {
  return `${window.getParticipantName()}_${sendrecv}_${track.id}`
}

/**
 * Returns the name of the sender participant for a given track.
 * @param {MediaStreamTrack} track
 */
window.getReceiverParticipantName = track => {
  return track.id
}

/**
 * getElement
 * @param {string} selector
 * @param {number} timeout
 * @param {boolean} throwError
 * @return {Promise<HTMLElement>}
 */
window.getElement = async (selector, timeout = 60000, throwError = false) => {
  let element = document.querySelector(selector)
  if (timeout) {
    const startTime = Date.now()
    while (!element && Date.now() - startTime < timeout) {
      await sleep(Math.min(timeout / 2, 1000))
      element = document.querySelector(selector)
    }
  }
  if (!element && throwError) {
    throw new Error(`Timeout getting "${selector}"`)
  }
  return element
}

/**
 * getElements
 * @param {string} selector
 * @param {number} timeout
 * @param {boolean} throwError
 * @param {string} innerText
 * @return {Promise<HTMLElement[]>}
 */
window.getElements = async (
  selector,
  timeout = 60000,
  throwError = false,
  innerText = '',
) => {
  let elements = document.querySelectorAll(selector)
  if (timeout) {
    const startTime = Date.now()
    while (!elements.length && Date.now() - startTime < timeout) {
      await sleep(Math.min(timeout / 2, 1000))
      elements = document.querySelectorAll(selector)
    }
  }
  if (!elements.length && throwError) {
    throw new Error(`Timeout getting "${selector}"`)
  }
  if (innerText) {
    return [...elements].filter(
      e => e.innerText.trim().toLowerCase() === innerText.trim().toLowerCase(),
    )
  } else {
    return [...elements]
  }
}

/**
 * overrideLocalStorage
 */
window.overrideLocalStorage = () => {
  if (window.LOCAL_STORAGE) {
    try {
      const values = JSON.parse(window.LOCAL_STORAGE)
      Object.entries(values).map(([key, value]) =>
        localStorage.setItem(key, value),
      )
    } catch (err) {
      log(`overrideLocalStorage error: ${err.message}`)
    }
  }
}

window.injectCss = css => {
  const style = document.createElement('style')
  style.setAttribute('type', 'text/css')
  style.innerHTML = css
  document.head.appendChild(style)
}

window.watchObjectProperty = (object, name, cb) => {
  let value = object[name]
  Object.defineProperty(object, name, {
    get: function () {
      return value
    },
    set: function (newValue) {
      cb(newValue, value)
      value = newValue
    },
  })
}

window.loadScript = (name, src = '', textContent = '') => {
  return new Promise((resolve, reject) => {
    let script = document.getElementById(name)
    if (script) {
      resolve(script)
      return
    }
    script = document.createElement('script')
    script.setAttribute('id', name)
    if (src) {
      script.setAttribute('src', src)
      script.setAttribute('referrerpolicy', 'no-referrer')
      script.addEventListener('load', () => script && resolve(script), false)
      script.addEventListener('error', err => reject(err), false)
    } else if (textContent) {
      script.textContent = textContent
    } else {
      reject(new Error('src or textContent must be provided'))
    }
    document.head.appendChild(script)
    if (textContent) {
      resolve(script)
    }
  })
}

window.harmonicMean = array => {
  return array.length
    ? 1 /
        (array.reduce((sum, b) => {
          sum += 1 / b
          return sum
        }, 0) /
          array.length)
    : 0
}

window.unregisterServiceWorkers = () => {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (let registration of registrations) {
      registration.unregister()
    }
  })
}

window.MeasuredStats = class {
  constructor(
    { ttl, maxItems, secondsPerSample, storeId } = {
      ttl: 0,
      maxItems: 0,
      secondsPerSample: 1,
      storeId: '',
    },
  ) {
    /** @type number */
    this.ttl = ttl
    /** @type number */
    this.secondsPerSample = secondsPerSample
    /** @type string */
    this.storeId = storeId
    /** @type number */
    this.maxItems = maxItems
    /** @type Array<{ timestamp: number; value: number; count: number }> */
    this.stats = []
    /** @type number */
    this.statsSum = 0
    /** @type number */
    this.statsCount = 0
    // Restore from localStorage.
    this.load()
  }

  store() {
    if (!this.storeId) {
      return
    }
    try {
      localStorage.setItem(
        `webrtcperf-MeasuredStats-${this.storeId}`,
        JSON.stringify({
          stats: this.stats,
          statsSum: this.statsSum,
          statsCount: this.statsCount,
        }),
      )
    } catch (err) {
      log(`MeasuredStats store error: ${err.message}`)
    }
  }

  load() {
    if (!this.storeId) {
      return
    }
    try {
      const data = localStorage.getItem(
        `webrtcperf-MeasuredStats-${this.storeId}`,
      )
      if (data) {
        const { stats, statsSum, statsCount } = JSON.parse(data)
        this.stats = stats
        this.statsSum = statsSum
        this.statsCount = statsCount
      }
    } catch (err) {
      log(`MeasuredStats load error: ${err.message}`)
    }
  }

  clear() {
    this.stats = []
    this.statsSum = 0
    this.statsCount = 0
    this.store()
  }

  purge() {
    let changed = false
    if (this.ttl > 0) {
      const now = Date.now()
      let removeToIndex = -1
      for (const [index, { timestamp }] of this.stats.entries()) {
        if (now - timestamp > this.ttl * 1000) {
          removeToIndex = index
        } else {
          break
        }
      }
      if (removeToIndex >= 0) {
        for (const { value, count } of this.stats.splice(
          0,
          removeToIndex + 1,
        )) {
          this.statsSum -= value
          this.statsCount -= count
        }
        changed = true
      }
    }
    if (this.maxItems && this.stats.length > this.maxItems) {
      for (const { value, count } of this.stats.splice(
        0,
        this.stats.length - this.maxItems,
      )) {
        this.statsSum -= value
        this.statsCount -= count
      }
      changed = true
    }
    if (changed) {
      this.store()
    }
  }

  /**
   * push
   * @param {number} timestamp
   * @param {number} value
   */
  push(timestamp, value) {
    const last = this.stats[this.stats.length - 1]
    if (last && timestamp - last.timestamp < this.secondsPerSample * 1000) {
      last.value += value
      last.count += 1
    } else {
      this.stats.push({ timestamp, value, count: 1 })
    }
    this.statsSum += value
    this.statsCount += 1
    this.purge()
  }

  /**
   * mean
   * @returns {number | undefined} mean value
   */
  mean() {
    this.purge()
    return this.statsCount ? this.statsSum / this.statsCount : undefined
  }
}

window.enabledForSession = value => {
  if (value === true) {
    return true
  } else if (value === false || value === undefined) {
    return false
  } else if (typeof value === 'string') {
    if (value.indexOf('-') !== -1) {
      const [start, end] = value.split('-').map(s => parseInt(s))
      if (isFinite(start) && window.WEBRTC_PERF_INDEX < start) {
        return false
      }
      if (isFinite(end) && window.WEBRTC_PERF_INDEX > end) {
        return false
      }
      return true
    } else {
      const indexes = value
        .split(',')
        .filter(s => s.length)
        .map(s => parseInt(s))
      return indexes.includes(window.WEBRTC_PERF_INDEX)
    }
  } else if (window.WEBRTC_PERF_INDEX === value) {
    return true
  }
  return false
}

// Common page actions
let actionsStarted = false

window.webrtcPerfElapsedTime = () =>
  Date.now() - window.WEBRTC_PERF_START_TIMESTAMP

window.setupActions = async () => {
  if (!window.PARAMS?.actions || actionsStarted) {
    return
  }
  actionsStarted = true

  /** @ŧype Array<{ name: string, at: number, every: number, times: number, index: number, params: [] }> */
  const actions = window.PARAMS.actions
  actions
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .forEach(action => {
      const { name, at, every, times, index, params } = action
      const fn = window[name]
      if (!fn) {
        log(`setupActions undefined action: "${name}"`)
        return
      }

      if (index !== undefined) {
        if (!window.enabledForSession(index)) {
          return
        }
      }

      const setupTime = window.webrtcPerfElapsedTime()
      let startTime = at > 0 ? at * 1000 - setupTime : 0
      if (startTime < 0) {
        log(
          `setupActions action "${name}" already passed (setupTime: ${
            setupTime / 1000
          } at: ${at})`,
        )
        if (every > 0) {
          startTime =
            Math.ceil(-startTime / (every * 1000)) * every * 1000 + startTime
        } else {
          return
        }
      }
      log(
        `scheduling action ${name}(${params || ''}) at ${at}s${
          every ? ` every ${every}s` : ''
        }${
          times ? ` ${times} times` : ''
        } with startTime: ${startTime}ms setupTime: ${setupTime}ms`,
      )
      let currentIteration = 0
      const cb = async () => {
        const ts = (window.webrtcPerfElapsedTime() / 1000).toFixed(0)
        log(
          `run action [${ts}s] ${name}(${params || ''})${
            every ? ` every ${every}s` : ''
          }${
            times
              ? ` (${times - currentIteration}/${times} times remaining)`
              : ''
          } (${Date.now()})`,
        )
        try {
          if (params && params.length) {
            await fn(...params)
          } else {
            await fn()
          }
          log(`run action [${ts}s] [${window.WEBRTC_PERF_INDEX}] ${name} done`)
        } catch (err) {
          log(
            `run action [${ts}s] [${window.WEBRTC_PERF_INDEX}] ${name} error: ${err.message}`,
          )
        } finally {
          currentIteration += 1
          if (every > 0 && currentIteration < (times || Infinity)) {
            setTimeout(cb, every * 1000)
          }
        }
      }

      setTimeout(cb, startTime)
    })
}

window.stringToBinary = str => {
  return str
    .split('')
    .reduce((prev, cur, index) => prev + (cur.charCodeAt() << (8 * index)), 0)
}

window.createWorker = fn => {
  const blob = new Blob(
    [
      fn
        .toString()
        .replace(/^[^{]*{\s*/, '')
        .replace(/\s*}[^}]*$/, ''),
    ],
    {
      type: 'text/javascript',
    },
  )
  const url = URL.createObjectURL(blob)
  return new Worker(url)
}
