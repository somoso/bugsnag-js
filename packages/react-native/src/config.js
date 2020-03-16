const { schema } = require('@bugsnag/core/config')
const stringWithLength = require('@bugsnag/core/lib/validators/string-with-length')

const ALLOWED_IN_JS = ['onError', 'onBreadcrumb', 'logger', 'metadata', 'user', 'context', 'codeBundleId']
const allowedErrorTypes = () => ({
  unhandledExceptions: true,
  unhandledRejections: true,
  anrs: true,
  ndkCrashes: true,
  ooms: true
})

module.exports.schema = {
  ...schema,
  logger: {
    ...schema.logger,
    defaultValue: () => getPrefixedConsole()
  },
  codeBundleId: {
    defaultValue: () => null,
    message: 'should be a string',
    validate: val => (val === null || stringWithLength(val))
  },
  enabledErrorTypes: {
    ...schema.enabledErrorTypes,
    defaultValue: () => allowedErrorTypes(),
    validate: value => {
      // ensure we have an object
      if (typeof value !== 'object' || !value) return false
      const providedKeys = Object.keys(value)
      const allowedKeys = Object.keys(allowedErrorTypes())
      // ensure it only has a subset of the allowed keys
      if (providedKeys.filter(k => allowedKeys.includes(k)).length < providedKeys.length) return false
      // ensure all of the values are boolean
      if (Object.keys(value).filter(k => typeof value[k] !== 'boolean').length > 0) return false
      return true
    }
  }
}

const getPrefixedConsole = () => {
  return ['debug', 'info', 'warn', 'error'].reduce((accum, method) => {
    accum[method] = console[method].bind(console, '[bugsnag]')
    return accum
  }, {})
}

module.exports.load = (NativeClient, warn = console.warn) => {
  const nativeOpts = NativeClient.configure()

  // if we don't have any native options, something went wrong
  if (!nativeOpts) throw new Error('[bugsnag] Configuration could not be loaded from native client')

  // annotate the config object with the fact it came from the native layer
  Object.defineProperty(nativeOpts, '_didLoadFromConfig', { value: true, enumerable: false })
  // save the original values to check for mutations (user, context and metadata can be supplied in JS)
  Object.defineProperty(nativeOpts, '_originalValues', { value: { ...nativeOpts }, enumerable: false, writable: false })

  return freeze(nativeOpts, warn)
}

const freeze = (opts, warn) => {
  return new Proxy(opts, {
    set (obj, prop, value) {
      if (!ALLOWED_IN_JS.includes(prop)) {
        warn(`[bugsnag] Cannot set "${prop}" configuration option in JS. This must be set in the native layer.`)
        return true
      }
      return Reflect.set(...arguments)
    },
    deleteProperty (target, prop) {
      if (!ALLOWED_IN_JS.includes(prop)) {
        warn(`[bugsnag] Cannot delete "${prop}" configuration option in JS. This must be set in the native layer.`)
        return true
      }
      return Reflect.deleteProperty(...arguments)
    }
  })
}