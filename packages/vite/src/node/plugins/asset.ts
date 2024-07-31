import path from 'node:path'
import { parse as parseUrl } from 'node:url'
import fsp from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import * as mrmime from 'mrmime'
import type {
  NormalizedOutputOptions,
  PluginContext,
  RenderedChunk,
} from 'rollup'
import MagicString from 'magic-string'
import colors from 'picocolors'
import {
  createToImportMetaURLBasedRelativeRuntime,
  toOutputFilePathInJS,
} from '../build'
import type { Plugin } from '../plugin'
import type { ResolvedConfig } from '../config'
import { checkPublicFile } from '../publicDir'
import {
  encodeURIPath,
  getHash,
  injectQuery,
  joinUrlSegments,
  normalizePath,
  rawRE,
  removeLeadingSlash,
  removeUrlQuery,
  urlRE,
} from '../utils'
import { DEFAULT_ASSETS_INLINE_LIMIT, FS_PREFIX } from '../constants'
import type { ModuleGraph } from '../server/moduleGraph'
import { cleanUrl, withTrailingSlash } from '../../shared/utils'

// referenceId is base64url but replaces - with $
export const assetUrlRE = /__VITE_ASSET__([\w$]+)__(?:\$_(.*?)__)?/g

const jsSourceMapRE = /\.[cm]?js\.map$/

const assetCache = new WeakMap<ResolvedConfig, Map<string, string>>()

// chunk.name is the basename for the asset ignoring the directory structure
// For the manifest, we need to preserve the original file path and isEntry
// for CSS assets. We keep a map from referenceId to this information.
export interface GeneratedAssetMeta {
  originalName: string
  isEntry?: boolean
}
export const generatedAssets = new WeakMap<
  ResolvedConfig,
  Map<string, GeneratedAssetMeta>
>()

// add own dictionary entry by directly assigning mrmime
export function registerCustomMime(): void {
  // https://github.com/lukeed/mrmime/issues/3
  mrmime.mimes['ico'] = 'image/x-icon'
  // https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Containers#flac
  mrmime.mimes['flac'] = 'audio/flac'
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Common_types
  mrmime.mimes['eot'] = 'application/vnd.ms-fontobject'
}

export function renderAssetUrlInJS(
  ctx: PluginContext,
  config: ResolvedConfig,
  chunk: RenderedChunk,
  opts: NormalizedOutputOptions,
  code: string,
): MagicString | undefined {
  const toRelativeRuntime = createToImportMetaURLBasedRelativeRuntime(
    opts.format,
    config.isWorker,
  )

  let match: RegExpExecArray | null
  let s: MagicString | undefined

  // Urls added with JS using e.g.
  // imgElement.src = "__VITE_ASSET__5aA0Ddc0__" are using quotes

  // Urls added in CSS that is imported in JS end up like
  // var inlined = ".inlined{color:green;background:url(__VITE_ASSET__5aA0Ddc0__)}\n";

  // In both cases, the wrapping should already be fine

  assetUrlRE.lastIndex = 0
  while ((match = assetUrlRE.exec(code))) {
    s ||= new MagicString(code)
    const [full, referenceId, postfix = ''] = match
    const file = ctx.getFileName(referenceId)
    chunk.viteMetadata!.importedAssets.add(cleanUrl(file))
    const filename = file + postfix
    const replacement = toOutputFilePathInJS(
      filename,
      'asset',
      chunk.fileName,
      'js',
      config,
      toRelativeRuntime,
    )
    const replacementString =
      typeof replacement === 'string'
        ? JSON.stringify(encodeURIPath(replacement)).slice(1, -1)
        : `"+${replacement.runtime}+"`
    s.update(match.index, match.index + full.length, replacementString)
  }

  // Replace __VITE_PUBLIC_ASSET__5aA0Ddc0__ with absolute paths

  const publicAssetUrlMap = publicAssetUrlCache.get(config)!
  publicAssetUrlRE.lastIndex = 0
  while ((match = publicAssetUrlRE.exec(code))) {
    s ||= new MagicString(code)
    const [full, hash] = match
    const publicUrl = publicAssetUrlMap.get(hash)!.slice(1)
    const replacement = toOutputFilePathInJS(
      publicUrl,
      'public',
      chunk.fileName,
      'js',
      config,
      toRelativeRuntime,
    )
    const replacementString =
      typeof replacement === 'string'
        ? JSON.stringify(encodeURIPath(replacement)).slice(1, -1)
        : `"+${replacement.runtime}+"`
    s.update(match.index, match.index + full.length, replacementString)
  }

  return s
}

/**
 * Also supports loading plain strings with import text from './foo.txt?raw'
 */
export function assetPlugin(config: ResolvedConfig): Plugin {
  registerCustomMime()

  let moduleGraph: ModuleGraph | undefined

  return {
    name: 'vite:asset',

    buildStart() {
      assetCache.set(config, new Map())
      generatedAssets.set(config, new Map())
    },

    configureServer(server) {
      moduleGraph = server.moduleGraph
    },

    resolveId(id) {
      if (!config.assetsInclude(cleanUrl(id)) && !urlRE.test(id)) {
        return
      }
      // imports to absolute urls pointing to files in /public
      // will fail to resolve in the main resolver. handle them here.
      const publicFile = checkPublicFile(id, config)
      if (publicFile) {
        return id
      }
    },

    async load(id) {
      if (id[0] === '\0') {
        // Rollup convention, this id should be handled by the
        // plugin that marked it with \0
        return
      }

      // raw requests, read from disk
      if (rawRE.test(id)) {
        const file = checkPublicFile(id, config) || cleanUrl(id)
        this.addWatchFile(file)
        // raw query, read file and return as string
        return `export default ${JSON.stringify(
          await fsp.readFile(file, 'utf-8'),
        )}`
      }

      if (!urlRE.test(id) && !config.assetsInclude(cleanUrl(id))) {
        return
      }

      id = removeUrlQuery(id)
      let url = await fileToUrl(id, config, this)

      // Inherit HMR timestamp if this asset was invalidated
      if (moduleGraph) {
        const mod = moduleGraph.getModuleById(id)
        if (mod && mod.lastHMRTimestamp > 0) {
          url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
        }
      }

      return {
        code: `export default ${JSON.stringify(encodeURIPath(url))}`,
        // Force rollup to keep this module from being shared between other entry points if it's an entrypoint.
        // If the resulting chunk is empty, it will be removed in generateBundle.
        moduleSideEffects:
          config.command === 'build' && this.getModuleInfo(id)?.isEntry
            ? 'no-treeshake'
            : false,
      }
    },

    renderChunk(code, chunk, opts) {
      const s = renderAssetUrlInJS(this, config, chunk, opts, code)

      if (s) {
        return {
          code: s.toString(),
          map: config.build.sourcemap
            ? s.generateMap({ hires: 'boundary' })
            : null,
        }
      } else {
        return null
      }
    },

    generateBundle(_, bundle) {
      // Remove empty entry point file
      for (const file in bundle) {
        const chunk = bundle[file]
        if (
          chunk.type === 'chunk' &&
          chunk.isEntry &&
          chunk.moduleIds.length === 1 &&
          config.assetsInclude(chunk.moduleIds[0])
        ) {
          delete bundle[file]
        }
      }

      // do not emit assets for SSR build
      if (
        config.command === 'build' &&
        config.build.ssr &&
        !config.build.ssrEmitAssets
      ) {
        for (const file in bundle) {
          if (
            bundle[file].type === 'asset' &&
            !file.endsWith('ssr-manifest.json') &&
            !jsSourceMapRE.test(file)
          ) {
            delete bundle[file]
          }
        }
      }
    },
  }
}

export async function fileToUrl(
  id: string,
  config: ResolvedConfig,
  ctx: PluginContext,
): Promise<string> {
  if (config.command === 'serve') {
    return fileToDevUrl(id, config)
  } else {
    return fileToBuiltUrl(id, config, ctx)
  }
}

function fileToDevUrl(id: string, config: ResolvedConfig) {
  let rtn: string
  if (checkPublicFile(id, config)) {
    // in public dir during dev, keep the url as-is
    rtn = id
  } else if (id.startsWith(withTrailingSlash(config.root))) {
    // in project root, infer short public path
    rtn = '/' + path.posix.relative(config.root, id)
  } else {
    // outside of project root, use absolute fs path
    // (this is special handled by the serve static middleware
    rtn = path.posix.join(FS_PREFIX, id)
  }
  const base = joinUrlSegments(config.server?.origin ?? '', config.base)
  return joinUrlSegments(base, removeLeadingSlash(rtn))
}

export function getPublicAssetFilename(
  hash: string,
  config: ResolvedConfig,
): string | undefined {
  return publicAssetUrlCache.get(config)?.get(hash)
}

export const publicAssetUrlCache = new WeakMap<
  ResolvedConfig,
  // hash -> url
  Map<string, string>
>()

export const publicAssetUrlRE = /__VITE_PUBLIC_ASSET__([a-z\d]{8})__/g

export function publicFileToBuiltUrl(
  url: string,
  config: ResolvedConfig,
): string {
  if (config.command !== 'build') {
    // We don't need relative base or renderBuiltUrl support during dev
    return joinUrlSegments(config.base, url)
  }
  const hash = getHash(url)
  let cache = publicAssetUrlCache.get(config)
  if (!cache) {
    cache = new Map<string, string>()
    publicAssetUrlCache.set(config, cache)
  }
  if (!cache.get(hash)) {
    cache.set(hash, url)
  }
  return `__VITE_PUBLIC_ASSET__${hash}__`
}

const GIT_LFS_PREFIX = Buffer.from('version https://git-lfs.github.com')
function isGitLfsPlaceholder(content: Buffer): boolean {
  if (content.length < GIT_LFS_PREFIX.length) return false
  // Check whether the content begins with the characteristic string of Git LFS placeholders
  return GIT_LFS_PREFIX.compare(content, 0, GIT_LFS_PREFIX.length) === 0
}

/**
 * Register an asset to be emitted as part of the bundle (if necessary)
 * and returns the resolved public URL
 */
async function fileToBuiltUrl(
  id: string,
  config: ResolvedConfig,
  pluginContext: PluginContext,
  skipPublicCheck = false,
  forceInline?: boolean,
): Promise<string> {
  if (!skipPublicCheck && checkPublicFile(id, config)) {
    return publicFileToBuiltUrl(id, config)
  }

  const cache = assetCache.get(config)!
  const cached = cache.get(id)
  if (cached) {
    return cached
  }

  const file = cleanUrl(id)
  const content = await fsp.readFile(file)

  let url: string
  if (shouldInline(config, file, id, content, pluginContext, forceInline)) {
    if (config.build.lib && isGitLfsPlaceholder(content)) {
      config.logger.warn(
        colors.yellow(`Inlined file ${id} was not downloaded via Git LFS`),
      )
    }

    if (file.endsWith('.svg')) {
      url = svgToDataURL(content)
    } else {
      const mimeType = mrmime.lookup(file) ?? 'application/octet-stream'
      // base64 inlined as a string
      url = `data:${mimeType};base64,${content.toString('base64')}`
    }
  } else {
    // emit as asset
    const { search, hash } = parseUrl(id)
    const postfix = (search || '') + (hash || '')

    const referenceId = pluginContext.emitFile({
      // Ignore directory structure for asset file names
      name: path.basename(file),
      type: 'asset',
      source: content,
    })

    const originalName = normalizePath(path.relative(config.root, file))
    generatedAssets.get(config)!.set(referenceId, { originalName })

    url = `__VITE_ASSET__${referenceId}__${postfix ? `$_${postfix}__` : ``}` // TODO_BASE
  }

  cache.set(id, url)
  return url
}

export async function urlToBuiltUrl(
  url: string,
  importer: string,
  config: ResolvedConfig,
  pluginContext: PluginContext,
  forceInline?: boolean,
): Promise<string> {
  if (checkPublicFile(url, config)) {
    return publicFileToBuiltUrl(url, config)
  }
  const file =
    url[0] === '/'
      ? path.join(config.root, url)
      : path.join(path.dirname(importer), url)
  return fileToBuiltUrl(
    file,
    config,
    pluginContext,
    // skip public check since we just did it above
    true,
    forceInline,
  )
}

const shouldInline = (
  config: ResolvedConfig,
  file: string,
  id: string,
  content: Buffer,
  pluginContext: PluginContext,
  forceInline: boolean | undefined,
): boolean => {
  if (config.build.lib) return true
  if (pluginContext.getModuleInfo(id)?.isEntry) return false
  if (forceInline !== undefined) return forceInline
  let limit: number
  if (typeof config.build.assetsInlineLimit === 'function') {
    const userShouldInline = config.build.assetsInlineLimit(file, content)
    if (userShouldInline != null) return userShouldInline
    limit = DEFAULT_ASSETS_INLINE_LIMIT
  } else {
    limit = Number(config.build.assetsInlineLimit)
  }
  if (file.endsWith('.html')) return false
  // Don't inline SVG with fragments, as they are meant to be reused
  if (file.endsWith('.svg') && id.includes('#')) return false
  return content.length < limit && !isGitLfsPlaceholder(content)
}

const nestedQuotesRE = /"[^"']*'[^"]*"|'[^'"]*"[^']*'/

// Inspired by https://github.com/iconify/iconify/blob/main/packages/utils/src/svg/url.ts
function svgToDataURL(content: Buffer): string {
  const stringContent = content.toString()
  // If the SVG contains some text or HTML, any transformation is unsafe, and given that double quotes would then
  // need to be escaped, the gain to use a data URI would be ridiculous if not negative
  if (
    stringContent.includes('<text') ||
    stringContent.includes('<foreignObject') ||
    nestedQuotesRE.test(stringContent)
  ) {
    return `data:image/svg+xml;base64,${content.toString('base64')}`
  } else {
    return (
      'data:image/svg+xml,' +
      stringContent
        .trim()
        .replaceAll(/>\s+</g, '><')
        .replaceAll('"', "'")
        .replaceAll('%', '%25')
        .replaceAll('#', '%23')
        .replaceAll('<', '%3c')
        .replaceAll('>', '%3e')
        // Spaces are not valid in srcset it has some use cases
        // it can make the uncompressed URI slightly higher than base64, but will compress way better
        // https://github.com/vitejs/vite/pull/14643#issuecomment-1766288673
        .replaceAll(/\s+/g, '%20')
    )
  }
}
