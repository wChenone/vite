import path from 'node:path'
import { pathToFileURL } from 'node:url'
import colors from 'picocolors'
import type { ViteDevServer } from '../server'
import { isBuiltin, isExternalUrl, isFilePathESM } from '../utils'
import { transformRequest } from '../server/transformRequest'
import type { InternalResolveOptionsWithOverrideConditions } from '../plugins/resolve'
import { tryNodeResolve } from '../plugins/resolve'
import { genSourceMapUrl } from '../server/sourcemap'
import {
  AsyncFunction,
  asyncFunctionDeclarationPaddingLineCount,
  isWindows,
  unwrapId,
} from '../../shared/utils'
import {
  type SSRImportBaseMetadata,
  analyzeImportedModDifference,
} from '../../shared/ssrTransform'
import { SOURCEMAPPING_URL } from '../../shared/constants'
import {
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrModuleExportsKey,
} from './ssrTransform'
import { ssrFixStacktrace } from './ssrStacktrace'

interface SSRContext {
  global: typeof globalThis
}

type SSRModule = Record<string, any>

interface NodeImportResolveOptions
  extends InternalResolveOptionsWithOverrideConditions {
  legacyProxySsrExternalModules?: boolean
}

const pendingModules = new Map<string, Promise<SSRModule>>()
const pendingModuleDependencyGraph = new Map<string, Set<string>>()
const importErrors = new WeakMap<Error, { importee: string }>()

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  fixStacktrace?: boolean,
): Promise<SSRModule> {
  url = unwrapId(url)

  // when we instantiate multiple dependency modules in parallel, they may
  // point to shared modules. We need to avoid duplicate instantiation attempts
  // by register every module as pending synchronously so that all subsequent
  // request to that module are simply waiting on the same promise.
  const pending = pendingModules.get(url)
  if (pending) {
    return pending
  }

  const modulePromise = instantiateModule(url, server, context, fixStacktrace)
  pendingModules.set(url, modulePromise)
  modulePromise
    .catch(() => {
      /* prevent unhandled promise rejection error from bubbling up */
    })
    .finally(() => {
      pendingModules.delete(url)
    })
  return modulePromise
}

async function instantiateModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  fixStacktrace?: boolean,
): Promise<SSRModule> {
  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url, true)

  if (mod.ssrError) {
    throw mod.ssrError
  }

  if (mod.ssrModule) {
    return mod.ssrModule
  }
  const result =
    mod.ssrTransformResult ||
    (await transformRequest(url, server, { ssr: true }))
  if (!result) {
    // TODO more info? is this even necessary?
    throw new Error(`failed to load module for ssr: ${url}`)
  }

  const ssrModule = {
    [Symbol.toStringTag]: 'Module',
  }
  Object.defineProperty(ssrModule, '__esModule', { value: true })

  // Tolerate circular imports by ensuring the module can be
  // referenced before it's been instantiated.
  mod.ssrModule = ssrModule

  // replace '/' with '\\' on Windows to match Node.js
  const osNormalizedFilename = isWindows ? path.resolve(mod.file!) : mod.file!

  const ssrImportMeta = {
    dirname: path.dirname(osNormalizedFilename),
    filename: osNormalizedFilename,
    // The filesystem URL, matching native Node.js modules
    url: pathToFileURL(mod.file!).toString(),
  }

  const {
    isProduction,
    resolve: { dedupe, preserveSymlinks },
    root,
    ssr,
  } = server.config

  const overrideConditions = ssr.resolve?.externalConditions || []

  const resolveOptions: NodeImportResolveOptions = {
    mainFields: ['main'],
    conditions: [],
    overrideConditions: [...overrideConditions, 'production', 'development'],
    extensions: ['.js', '.cjs', '.json'],
    dedupe,
    preserveSymlinks,
    isBuild: false,
    isProduction,
    root,
    ssrConfig: ssr,
    legacyProxySsrExternalModules:
      server.config.legacy?.proxySsrExternalModules,
    packageCache: server.config.packageCache,
  }

  const ssrImport = async (dep: string, metadata?: SSRImportBaseMetadata) => {
    try {
      if (dep[0] !== '.' && dep[0] !== '/') {
        return await nodeImport(dep, mod.file!, resolveOptions, metadata)
      }
      // convert to rollup URL because `pendingImports`, `moduleGraph.urlToModuleMap` requires that
      dep = unwrapId(dep)

      // Handle any potential circular dependencies for static imports, preventing
      // deadlock scenarios when two modules are indirectly waiting on one another
      // to finish initializing. Dynamic imports are resolved at runtime, hence do
      // not contribute to the static module dependency graph in the same way
      if (!metadata?.isDynamicImport) {
        addPendingModuleDependency(url, dep)

        // If there's a circular dependency formed as a result of the dep import,
        // return the current state of the dependent module being initialized, in
        // order to avoid interlocking circular dependencies hanging indefinitely
        if (checkModuleDependencyExists(dep, url)) {
          const depSsrModule = moduleGraph.urlToModuleMap.get(dep)?.ssrModule
          if (!depSsrModule) {
            // Technically, this should never happen under normal circumstances
            throw new Error(
              '[vite] The dependency module is not yet fully initialized due to circular dependency. This is a bug in Vite SSR',
            )
          }
          return depSsrModule
        }
      }

      return ssrLoadModule(dep, server, context, fixStacktrace)
    } catch (err) {
      // tell external error handler which mod was imported with error
      importErrors.set(err, { importee: dep })

      throw err
    }
  }

  const ssrDynamicImport = (dep: string) => {
    // #3087 dynamic import vars is ignored at rewrite import path,
    // so here need process relative path
    if (dep[0] === '.') {
      dep = path.posix.resolve(path.dirname(url), dep)
    }
    return ssrImport(dep, { isDynamicImport: true })
  }

  function ssrExportAll(sourceModule: any) {
    for (const key in sourceModule) {
      if (key !== 'default' && key !== '__esModule') {
        Object.defineProperty(ssrModule, key, {
          enumerable: true,
          configurable: true,
          get() {
            return sourceModule[key]
          },
        })
      }
    }
  }

  let sourceMapSuffix = ''
  if (result.map && 'version' in result.map) {
    const moduleSourceMap = Object.assign({}, result.map, {
      mappings:
        ';'.repeat(asyncFunctionDeclarationPaddingLineCount) +
        result.map.mappings,
    })
    sourceMapSuffix = `\n//# ${SOURCEMAPPING_URL}=${genSourceMapUrl(moduleSourceMap)}`
  }

  try {
    const initModule = new AsyncFunction(
      `global`,
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      '"use strict";' +
        result.code +
        `\n//# sourceURL=${mod.id}${sourceMapSuffix}`,
    )
    await initModule(
      context.global,
      ssrModule,
      ssrImportMeta,
      ssrImport,
      ssrDynamicImport,
      ssrExportAll,
    )
  } catch (e) {
    mod.ssrError = e
    const errorData = importErrors.get(e)

    if (e.stack && fixStacktrace) {
      ssrFixStacktrace(e, moduleGraph)
    }

    server.config.logger.error(
      colors.red(
        `Error when evaluating SSR module ${url}:` +
          (errorData?.importee
            ? ` failed to import "${errorData.importee}"`
            : '') +
          `\n|- ${e.stack}\n`,
      ),
      {
        timestamp: true,
        clear: server.config.clearScreen,
        error: e,
      },
    )

    throw e
  } finally {
    pendingModuleDependencyGraph.delete(url)
  }

  return Object.freeze(ssrModule)
}

function addPendingModuleDependency(originUrl: string, depUrl: string): void {
  if (pendingModuleDependencyGraph.has(originUrl)) {
    pendingModuleDependencyGraph.get(originUrl)!.add(depUrl)
  } else {
    pendingModuleDependencyGraph.set(originUrl, new Set([depUrl]))
  }
}

function checkModuleDependencyExists(
  originUrl: string,
  targetUrl: string,
): boolean {
  const visited = new Set()
  const stack = [originUrl]

  while (stack.length) {
    const currentUrl = stack.pop()!

    if (currentUrl === targetUrl) {
      return true
    }

    if (!visited.has(currentUrl)) {
      visited.add(currentUrl)

      const dependencies = pendingModuleDependencyGraph.get(currentUrl)
      if (dependencies) {
        for (const depUrl of dependencies) {
          if (!visited.has(depUrl)) {
            stack.push(depUrl)
          }
        }
      }
    }
  }

  return false
}

// In node@12+ we can use dynamic import to load CJS and ESM
async function nodeImport(
  id: string,
  importer: string,
  resolveOptions: NodeImportResolveOptions,
  metadata?: SSRImportBaseMetadata,
) {
  let url: string
  let filePath: string | undefined
  if (id.startsWith('data:') || isExternalUrl(id) || isBuiltin(id)) {
    url = id
  } else {
    const resolved = tryNodeResolve(
      id,
      importer,
      { ...resolveOptions, tryEsmOnly: true },
      false,
      undefined,
      true,
    )
    if (!resolved) {
      const err: any = new Error(
        `Cannot find module '${id}' imported from '${importer}'`,
      )
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    filePath = resolved.id
    url = pathToFileURL(resolved.id).toString()
  }

  const mod = await import(url)

  if (resolveOptions.legacyProxySsrExternalModules) {
    return proxyESM(mod)
  } else if (filePath) {
    analyzeImportedModDifference(
      mod,
      id,
      isFilePathESM(filePath, resolveOptions.packageCache)
        ? 'module'
        : undefined,
      metadata,
    )
    return mod
  } else {
    return mod
  }
}

// rollup-style default import interop for cjs
function proxyESM(mod: any) {
  // This is the only sensible option when the exports object is a primitive
  if (isPrimitive(mod)) return { default: mod }

  let defaultExport = 'default' in mod ? mod.default : mod

  if (!isPrimitive(defaultExport) && '__esModule' in defaultExport) {
    mod = defaultExport
    if ('default' in defaultExport) {
      defaultExport = defaultExport.default
    }
  }

  return new Proxy(mod, {
    get(mod, prop) {
      if (prop === 'default') return defaultExport
      return mod[prop] ?? defaultExport?.[prop]
    },
  })
}

function isPrimitive(value: any) {
  return !value || (typeof value !== 'object' && typeof value !== 'function')
}
