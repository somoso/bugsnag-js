const config = require('./config')
const BugsnagReport = require('./report')
const BugsnagBreadcrumb = require('./breadcrumb')
const BugsnagSession = require('./session')
const { map, reduce, includes, isArray } = require('./lib/es-utils')
const inferReleaseStage = require('./lib/infer-release-stage')
const isError = require('iserror')

const LOG_USAGE_ERR_PREFIX = `Usage error.`
const REPORT_USAGE_ERR_PREFIX = `Bugsnag usage error.`

const noop = () => {}

class BugsnagClient {
  constructor (notifier, configSchema = config.schema, session = null) {
    if (!notifier || !notifier.name || !notifier.version || !notifier.url) {
      throw new Error('`notifier` argument is required')
    }

    // notifier id
    this.notifier = notifier

    // config
    this.configSchema = configSchema

    // configure() should be called before notify()
    this._configured = false

    // i/o
    this._delivery = { sendSession: noop, sendReport: noop }
    this._logger = { debug: noop, info: noop, warn: noop, error: noop }

    // plugins
    this.plugins = []

    this.session = session
    this.beforeSession = []

    this.breadcrumbs = []

    // setable props
    this.app = {}
    this.context = undefined
    this.device = undefined
    this.metaData = undefined
    this.request = undefined
    this.user = {}

    // expose internal constructors
    this.BugsnagReport = BugsnagReport
    this.BugsnagBreadcrumb = BugsnagBreadcrumb
    this.BugsnagSession = BugsnagSession
  }

  configure (opts = {}) {
    this.config = config.mergeDefaults({ ...this.config, ...opts }, this.configSchema)
    const validity = config.validate(this.config, this.configSchema)
    if (!validity.valid === true) throw new Error(generateConfigErrorMessage(validity.errors))
    if (typeof this.config.beforeSend === 'function') this.config.beforeSend = [ this.config.beforeSend ]
    if (this.config.appVersion !== null) this.app.version = this.config.appVersion
    if (this.config.metaData) this.metaData = this.config.metaData
    if (this.config.user) this.user = this.config.user
    if (this.config.logger) this.logger(this.config.logger)
    this._configured = true
    this._logger.debug(`Loaded!`)
    return this
  }

  use (plugin) {
    this.plugins.push(plugin)
    return plugin.init(this)
  }

  delivery (d) {
    this._delivery = d
    return this
  }

  logger (l, sid) {
    this._logger = l
    return this
  }

  sessionDelegate (s) {
    this._sessionDelegate = s
    return this
  }

  startSession () {
    if (!this._sessionDelegate) {
      this._logger.warn('No session implementation is installed')
      return this
    }
    return this._sessionDelegate.startSession(this)
  }

  leaveBreadcrumb (name, metaData, type, timestamp) {
    if (!this._configured) throw new Error('client not configured')

    // coerce bad values so that the defaults get set
    name = name || undefined
    type = typeof type === 'string' ? type : undefined
    timestamp = typeof timestamp === 'string' ? timestamp : undefined
    metaData = typeof metaData === 'object' && metaData !== null ? metaData : undefined

    // if no name and no metaData, usefulness of this crumb is questionable at best so discard
    if (typeof name !== 'string' && !metaData) return

    const crumb = new BugsnagBreadcrumb(name, metaData, type, timestamp)

    // push the valid crumb onto the queue and maintain the length
    this.breadcrumbs.push(crumb)
    if (this.breadcrumbs.length > this.config.maxBreadcrumbs) {
      this.breadcrumbs = this.breadcrumbs.slice(this.breadcrumbs.length - this.config.maxBreadcrumbs)
    }

    return this
  }

  notify (error, opts = {}) {
    if (!this._configured) throw new Error('client not configured')

    // releaseStage can be set via config.releaseStage or client.app.releaseStage
    const releaseStage = inferReleaseStage(this)

    // ensure we have an error (or a reasonable object representation of an error)
    let { err, errorFramesToSkip, _opts } = normaliseError(error, opts, this._logger)
    if (_opts) opts = _opts

    // if we have something falsey at this point, report usage error
    if (!err) {
      const msg = generateNotifyUsageMessage('nothing')
      this._logger.warn(`${LOG_USAGE_ERR_PREFIX} ${msg}`)
      err = new Error(`${REPORT_USAGE_ERR_PREFIX} ${msg}`)
    }

    // ensure opts is an object
    if (typeof opts !== 'object' || opts === null) opts = {}

    // create a report from the error, if it isn't one already
    const report = BugsnagReport.ensureReport(err, errorFramesToSkip, 1)

    report.app = { ...{ releaseStage }, ...report.app, ...this.app }
    report.context = report.context || opts.context || this.context || undefined
    report.device = { ...report.device, ...this.device, ...opts.device }
    report.request = { ...report.request, ...this.request, ...opts.request }
    report.user = { ...report.user, ...this.user, ...opts.user }
    report.metaData = { ...report.metaData, ...this.metaData, ...opts.metaData }
    report.breadcrumbs = this.breadcrumbs.slice(0)

    if (this.session) {
      this.session.trackError(report)
      report.session = this.session
    }

    // set severity if supplied
    if (opts.severity !== undefined) {
      report.severity = opts.severity
      report._handledState.severityReason = { type: 'userSpecifiedSeverity' }
    }

    // exit early if the reports should not be sent on the current releaseStage
    if (isArray(this.config.notifyReleaseStages) && !includes(this.config.notifyReleaseStages, releaseStage)) {
      this._logger.warn(`Report not sent due to releaseStage/notifyReleaseStages configuration`)
      return false
    }

    const originalSeverity = report.severity

    const beforeSend = [].concat(opts.beforeSend).concat(this.config.beforeSend)
    const preventSend = reduce(beforeSend, (accum, fn) => {
      if (accum === true) return true
      if (typeof fn === 'function' && fn(report) === false) return true
      if (report.isIgnored()) return true
      return false
    }, false)

    if (preventSend) {
      this._logger.debug(`Report not sent due to beforeSend callback`)
      return false
    }

    // only leave a crumb for the error if actually got sent
    if (this.config.autoBreadcrumbs) {
      this.leaveBreadcrumb(report.errorClass, {
        errorClass: report.errorClass,
        errorMessage: report.errorMessage,
        severity: report.severity
      }, 'error')
    }

    if (originalSeverity !== report.severity) {
      report._handledState.severityReason = { type: 'userCallbackSetSeverity' }
    }

    this._delivery.sendReport(this._logger, this.config, {
      apiKey: report.apiKey || this.config.apiKey,
      notifier: this.notifier,
      events: [ report ]
    })

    return true
  }
}

const normaliseError = (error, opts, logger) => {
  let err
  let errorFramesToSkip = 0
  let _opts
  switch (typeof error) {
    case 'string':
      if (typeof opts === 'string') {
        // ≤v3 used to have a notify('ErrorName', 'Error message') interface
        // report usage/deprecation errors if this function is called like that
        const msg = generateNotifyUsageMessage('string/string')
        logger.warn(`${LOG_USAGE_ERR_PREFIX} ${msg}`)
        err = new Error(`${REPORT_USAGE_ERR_PREFIX} ${msg}`)
        _opts = { metaData: { notifier: { notifyArgs: [ error, opts ] } } }
      } else {
        err = new Error(String(error))
        errorFramesToSkip += 2
      }
      break
    case 'number':
    case 'boolean':
      err = new Error(String(error))
      break
    case 'function':
      const msg = generateNotifyUsageMessage('function')
      logger.warn(`${LOG_USAGE_ERR_PREFIX} ${msg}`)
      err = new Error(`${REPORT_USAGE_ERR_PREFIX} ${msg}`)
      break
    case 'object':
      if (error !== null && (isError(error) || error.__isBugsnagReport)) {
        err = error
      } else if (error !== null && hasNecessaryFields(error)) {
        err = new Error(error.message || error.errorMessage)
        err.name = error.name || error.errorClass
        errorFramesToSkip += 2
      } else {
        const msg = generateNotifyUsageMessage('unsupported object')
        logger.warn(`${LOG_USAGE_ERR_PREFIX} ${msg}`)
        err = new Error(`${REPORT_USAGE_ERR_PREFIX} ${msg}`)
      }
      break
  }
  return { err, errorFramesToSkip, _opts }
}

const hasNecessaryFields = error =>
  (typeof error.name === 'string' || typeof error.errorClass === 'string') &&
  (typeof error.message === 'string' || typeof error.errorMessage === 'string')

const generateConfigErrorMessage = errors =>
  `Bugsnag configuration error\n${map(errors, (err) => `"${err.key}" ${err.message} \n    got ${stringify(err.value)}`).join('\n\n')}`

const generateNotifyUsageMessage = actual =>
  `notify() expected error/opts parameters, got ${actual}`

const stringify = val => typeof val === 'object' ? JSON.stringify(val) : String(val)

module.exports = BugsnagClient
