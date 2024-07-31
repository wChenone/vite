import { transform } from 'esbuild'
import { TraceMap, decodedMap, encodedMap } from '@jridgewell/trace-mapping'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import { escapeRegex } from '../utils'
import { isCSSRequest } from './css'
import { isHTMLRequest } from './html'

const nonJsRe = /\.json(?:$|\?)/
const isNonJsRequest = (request: string): boolean => nonJsRe.test(request)
const importMetaEnvMarker = '__vite_import_meta_env__'
const bareImportMetaEnvRe = new RegExp(`${importMetaEnvMarker}(?!\\.)\\b`)
const importMetaEnvKeyRe = new RegExp(`${importMetaEnvMarker}\\..+?\\b`, 'g')

export function definePlugin(config: ResolvedConfig): Plugin {
  const isBuild = config.command === 'build'
  const isBuildLib = isBuild && config.build.lib

  // ignore replace process.env in lib build
  const processEnv: Record<string, string> = {}
  if (!isBuildLib) {
    const nodeEnv = process.env.NODE_ENV || config.mode
    Object.assign(processEnv, {
      'process.env': `{}`,
      'global.process.env': `{}`,
      'globalThis.process.env': `{}`,
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'global.process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'globalThis.process.env.NODE_ENV': JSON.stringify(nodeEnv),
    })
  }

  // during dev, import.meta properties are handled by importAnalysis plugin.
  const importMetaKeys: Record<string, string> = {}
  const importMetaEnvKeys: Record<string, string> = {}
  const importMetaFallbackKeys: Record<string, string> = {}
  if (isBuild) {
    importMetaKeys['import.meta.hot'] = `undefined`
    for (const key in config.env) {
      const val = JSON.stringify(config.env[key])
      importMetaKeys[`import.meta.env.${key}`] = val
      importMetaEnvKeys[key] = val
    }
    // these will be set to a proper value in `generatePattern`
    importMetaKeys['import.meta.env.SSR'] = `undefined`
    importMetaFallbackKeys['import.meta.env'] = `undefined`
  }

  const userDefine: Record<string, string> = {}
  const userDefineEnv: Record<string, any> = {}
  for (const key in config.define) {
    userDefine[key] = handleDefineValue(config.define[key])

    // make sure `import.meta.env` object has user define properties
    if (isBuild && key.startsWith('import.meta.env.')) {
      userDefineEnv[key.slice(16)] = config.define[key]
    }
  }

  function generatePattern(ssr: boolean) {
    const replaceProcessEnv = !ssr || config.ssr?.target === 'webworker'

    const define: Record<string, string> = {
      ...(replaceProcessEnv ? processEnv : {}),
      ...importMetaKeys,
      ...userDefine,
      ...importMetaFallbackKeys,
    }

    // Additional define fixes based on `ssr` value
    if ('import.meta.env.SSR' in define) {
      define['import.meta.env.SSR'] = ssr + ''
    }
    if ('import.meta.env' in define) {
      define['import.meta.env'] = importMetaEnvMarker
    }

    const importMetaEnvVal = serializeDefine({
      ...importMetaEnvKeys,
      SSR: ssr + '',
      ...userDefineEnv,
    })
    const banner = `const ${importMetaEnvMarker} = ${importMetaEnvVal};\n`

    // Create regex pattern as a fast check before running esbuild
    const patternKeys = Object.keys(userDefine)
    if (replaceProcessEnv && Object.keys(processEnv).length) {
      patternKeys.push('process.env')
    }
    if (Object.keys(importMetaKeys).length) {
      patternKeys.push('import.meta.env', 'import.meta.hot')
    }
    const pattern = patternKeys.length
      ? new RegExp(patternKeys.map(escapeRegex).join('|'))
      : null

    return [define, pattern, banner] as const
  }

  const defaultPattern = generatePattern(false)
  const ssrPattern = generatePattern(true)

  return {
    name: 'vite:define',

    async transform(code, id, options) {
      const ssr = options?.ssr === true
      if (!ssr && !isBuild) {
        // for dev we inject actual global defines in the vite client to
        // avoid the transform cost. see the `clientInjection` and
        // `importAnalysis` plugin.
        return
      }

      if (
        // exclude html, css and static assets for performance
        isHTMLRequest(id) ||
        isCSSRequest(id) ||
        isNonJsRequest(id) ||
        config.assetsInclude(id)
      ) {
        return
      }

      const [define, pattern, banner] = ssr ? ssrPattern : defaultPattern
      if (!pattern) return

      // Check if our code needs any replacements before running esbuild
      pattern.lastIndex = 0
      if (!pattern.test(code)) return

      const result = await replaceDefine(code, id, define, config)

      // Replace `import.meta.env.*` with undefined
      result.code = result.code.replaceAll(importMetaEnvKeyRe, (m) =>
        'undefined'.padEnd(m.length),
      )

      // If there's bare `import.meta.env` references, prepend the banner
      if (bareImportMetaEnvRe.test(result.code)) {
        result.code = banner + result.code

        if (result.map) {
          const map = JSON.parse(result.map)
          map.mappings = ';' + map.mappings
          result.map = map
        }
      }

      return result
    },
  }
}

export async function replaceDefine(
  code: string,
  id: string,
  define: Record<string, string>,
  config: ResolvedConfig,
): Promise<{ code: string; map: string | null }> {
  const esbuildOptions = config.esbuild || {}

  const result = await transform(code, {
    loader: 'js',
    charset: esbuildOptions.charset ?? 'utf8',
    platform: 'neutral',
    define,
    sourcefile: id,
    sourcemap: config.command === 'build' ? !!config.build.sourcemap : true,
  })

  // remove esbuild's <define:...> source entries
  // since they would confuse source map remapping/collapsing which expects a single source
  if (result.map.includes('<define:')) {
    const originalMap = new TraceMap(result.map)
    if (originalMap.sources.length >= 2) {
      const sourceIndex = originalMap.sources.indexOf(id)
      const decoded = decodedMap(originalMap)
      decoded.sources = [id]
      decoded.mappings = decoded.mappings.map((segments) =>
        segments.filter((segment) => {
          // modify and filter
          const index = segment[1]
          segment[1] = 0
          return index === sourceIndex
        }),
      )
      result.map = JSON.stringify(encodedMap(new TraceMap(decoded as any)))
    }
  }

  return {
    code: result.code,
    map: result.map || null,
  }
}

/**
 * Like `JSON.stringify` but keeps raw string values as a literal
 * in the generated code. For example: `"window"` would refer to
 * the global `window` object directly.
 */
export function serializeDefine(define: Record<string, any>): string {
  let res = `{`
  const keys = Object.keys(define).sort()
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const val = define[key]
    res += `${JSON.stringify(key)}: ${handleDefineValue(val)}`
    if (i !== keys.length - 1) {
      res += `, `
    }
  }
  return res + `}`
}

function handleDefineValue(value: any): string {
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
