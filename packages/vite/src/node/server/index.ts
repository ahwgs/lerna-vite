import os from 'os'
import fs from 'fs'
import path from 'path'
import * as net from 'net'
import * as http from 'http'
import * as https from 'https'
import connect from 'connect'
import corsMiddleware from 'cors'
import chalk from 'chalk'
import { AddressInfo } from 'net'
import chokidar from 'chokidar'
import { resolveHttpServer } from './http'
import { resolveConfig, InlineConfig, ResolvedConfig } from '../config'
import {
  createPluginContainer,
  PluginContainer
} from '../server/pluginContainer'
import { FSWatcher, WatchOptions } from 'types/chokidar'
import { createWebSocketServer, WebSocketServer } from '../server/ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware, ProxyOptions } from './middlewares/proxy'
import { transformMiddleware } from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware
} from './middlewares/indexHtml'
import history from 'connect-history-api-fallback'
import {
  serveRawFsMiddleware,
  servePublicMiddleware,
  serveStaticMiddleware
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import { ModuleGraph, ModuleNode } from './moduleGraph'
import { Connect } from 'types/connect'
import { createDebugger, normalizePath } from '../utils'
import { errorMiddleware, prepareError } from './middlewares/error'
import { handleHMRUpdate, HmrOptions, handleFileAddUnlink } from './hmr'
import { openBrowser } from './openBrowser'
import launchEditorMiddleware from 'launch-editor-middleware'
import { TransformResult } from 'rollup'
import { TransformOptions, transformRequest } from './transformRequest'
import {
  transformWithEsbuild,
  ESBuildTransformResult
} from '../plugins/esbuild'
import { TransformOptions as EsbuildTransformOptions } from 'esbuild'
import { DepOptimizationMetadata, optimizeDeps } from '../optimizer'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { resolveSSRExternal } from '../ssr/ssrExternal'
import { ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { createMissingImporterRegisterFn } from '../optimizer/registerMissing'

export interface ServerOptions {
  host?: string
  port?: number
  /**
   * Enable TLS + HTTP/2.
   * Note: this downgrades to TLS only when the proxy option is also used.
   */
  https?: boolean | https.ServerOptions
  /**
   * Open browser window on startup
   */
  open?: boolean | string
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   */
  force?: boolean
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * chokidar watch options
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions
  /**
   * Configure custom proxy rules for the dev server. Expects an object
   * of `{ key: options }` pairs.
   * Uses [`http-proxy`](https://github.com/http-party/node-http-proxy).
   * Full options [here](https://github.com/http-party/node-http-proxy#options).
   *
   * Example `vite.config.js`:
   * ``` js
   * module.exports = {
   *   proxy: {
   *     // string shorthand
   *     '/foo': 'http://localhost:4567/foo',
   *     // with options
   *     '/api': {
   *       target: 'http://jsonplaceholder.typicode.com',
   *       changeOrigin: true,
   *       rewrite: path => path.replace(/^\/api/, '')
   *     }
   *   }
   * }
   * ```
   */
  proxy?: Record<string, string | ProxyOptions>
  /**
   * Configure CORS for the dev server.
   * Uses https://github.com/expressjs/cors.
   * Set to `true` to allow all methods from any origin, or configure separately
   * using an object.
   */
  cors?: CorsOptions | boolean
  /**
   * If enabled, vite will exit if specified port is already in use
   */
  strictPort?: boolean
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   */
  middlewareMode?: boolean
  /**
   * Prepend this folder to http requests, for use when proxying vite as a subfolder
   * Should start and end with the `/` character
   */
  base?: string
}

/**
 * https://github.com/expressjs/cors#configuration-options
 */
export interface CorsOptions {
  origin?:
    | CorsOrigin
    | ((origin: string, cb: (err: Error, origins: CorsOrigin) => void) => void)
  methods?: string | string[]
  allowedHeaders?: string | string[]
  exposedHeaders?: string | string[]
  credentials?: boolean
  maxAge?: number
  preflightContinue?: boolean
  optionsSuccessStatus?: number
}

export type CorsOrigin = boolean | string | RegExp | (string | RegExp)[]

export type ServerHook = (
  server: ViteDevServer
) => (() => void) | void | Promise<(() => void) | void>

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * @deprecated use `server.middlewares` instead
   */
  app: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: http.Server | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(url: string, html: string): Promise<string>
  /**
   * Util for transforming a file with esbuild.
   * Can be useful for certain plugins.
   */
  transformWithEsbuild(
    code: string,
    filename: string,
    options?: EsbuildTransformOptions,
    inMap?: object
  ): Promise<ESBuildTransformResult>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(url: string): Promise<Record<string, any>>
  /**
   * Fix ssr error stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * @internal
   */
  _optimizeDepsMetadata: DepOptimizationMetadata | null
  /**
   * Deps that are externalized
   * @internal
   */
  _ssrExternals: string[] | null
  /**
   * @internal
   */
  _globImporters: Record<
    string,
    {
      base: string
      pattern: string
      module: ModuleNode
    }
  >
  /**
   * @internal
   */
  _isRunningOptimizer: boolean
  /**
   * @internal
   */
  _registerMissingImport: ((id: string, resolved: string) => void) | null
  /**
   * @internal
   */
  _pendingReload: Promise<void> | null
}

export async function createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  // 加载开发配置文件
  const config = await resolveConfig(inlineConfig, 'serve', 'development')

  // 获取项目根目录（index.html 文件所在的位置）
  const root = config.root
  // 加载server配置 比如proxy hmr等等
  const serverConfig = config.server || {}
  const middlewareMode = !!serverConfig.middlewareMode

  // 利用 Connect 实现的中间件列表
  const middlewares = connect() as Connect.Server
  // 创建 http 服务
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares)
  // 创建websocket 服务
  const ws = createWebSocketServer(httpServer, config)

  const { ignored = [], ...watchOptions } = serverConfig.watch || {}
  // 创建文件监听器
  const watcher = chokidar.watch(path.resolve(root), {
    ignored: ['**/node_modules/**', '**/.git/**', ...ignored],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ...watchOptions
  }) as FSWatcher

  // 获取新增的插件
  const plugins = config.plugins
  // 继承rollup实现了一个迷你版的构解析构建工具
  const container = await createPluginContainer(config, watcher)

  // 创建一个图来维护模块之间的关系
  const moduleGraph = new ModuleGraph(container)

  // 关闭服务
  const closeHttpServer = createSeverCloseFn(httpServer)

  // 组装整个Vite Server
  const server: ViteDevServer = {
    config: config,
    middlewares,
    get app() {
      config.logger.warn(
        `ViteDevServer.app is deprecated. Use ViteDevServer.middlewares instead.`
      )
      return middlewares
    },
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    // 通过esbuild做转换
    transformWithEsbuild,
    // 转换请求
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    transformIndexHtml: null as any,
    ssrLoadModule(url) {
      if (!server._ssrExternals) {
        server._ssrExternals = resolveSSRExternal(
          config,
          server._optimizeDepsMetadata
            ? Object.keys(server._optimizeDepsMetadata.optimized)
            : []
        )
      }
      return ssrLoadModule(url, server)
    },
    ssrFixStacktrace(e) {
      if (e.stack) {
        e.stack = ssrRewriteStacktrace(e.stack, moduleGraph)
      }
    },
    // http server listen
    // 开启服务
    listen(port?: number, isRestart?: boolean) {
      return startServer(server, port, isRestart)
    },
    // 关闭文件监听
    // 关闭websocket
    // 关闭解析
    // 关闭http server
    async close() {
      await Promise.all([
        watcher.close(),
        ws.close(),
        container.close(),
        closeHttpServer()
      ])
    },
    _optimizeDepsMetadata: null,
    _ssrExternals: null,
    _globImporters: {},
    _isRunningOptimizer: false,
    _registerMissingImport: null,
    _pendingReload: null
  }

  // 解析开发环境index html
  server.transformIndexHtml = createDevHtmlTransformFn(server)

  const exitProcess = async () => {
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }

  process.once('SIGTERM', exitProcess)

  if (!process.stdin.isTTY) {
    process.stdin.on('end', exitProcess)
  }

  // 文件监听器 监听到change
  watcher.on('change', async (file) => {
    // 获取到改变的文件
    file = normalizePath(file)
    // invalidate module graph cache on file change
    // 文件改变 查出文件中的依赖 废弃依赖缓存
    moduleGraph.onFileChange(file)
    // 开启热更新
    if (serverConfig.hmr !== false) {
      try {
        // 热更新通知客户端文件更新
        await handleHMRUpdate(file, server)
      } catch (err) {
        ws.send({
          type: 'error',
          err: prepareError(err)
        })
      }
    }
  })

  watcher.on('add', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })

  watcher.on('unlink', (file) => {
    handleFileAddUnlink(normalizePath(file), server, true)
  })

  // apply server configuration hooks from plugins
  // 对外暴露 server 对象 ，方便用户拓展插件
  const postHooks: ((() => void) | void)[] = []
  for (const plugin of plugins) {
    if (plugin.configureServer) {
      postHooks.push(await plugin.configureServer(server))
    }
  }

  // Internal middlewares ------------------------------------------------------

  // request timer
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // cors (enabled by default)
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // 下面接入各种中间件

  // proxy 代理中间件
  const { proxy } = serverConfig
  if (proxy) {
    middlewares.use(proxyMiddleware(server))
  }

  // base
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(server))
  }

  // open in editor support
  // 鱿鱼丝做的打开编辑器的中间件 后面可以了解一下
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // hmr reconnect ping
  // 热更新心跳机制
  middlewares.use('/__vite_ping', (_, res) => res.end('pong'))

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  // 静态资源中间件 把/public 中资源起一个服务
  middlewares.use(servePublicMiddleware(config.publicDir))

  // main transform middleware
  // 文件转换中间件 很重要
  middlewares.use(transformMiddleware(server))

  // serve static files
  middlewares.use(serveRawFsMiddleware())
  middlewares.use(serveStaticMiddleware(root, config))

  // spa fallback
  // spa try file to index.html 防止history路由刷新404问题
  if (!middlewareMode) {
    middlewares.use(
      history({
        logger: createDebugger('vite:spa-fallback'),
        // support /dir/ without explicit index.html
        rewrites: [
          {
            from: /\/$/,
            to({ parsedUrl }: any) {
              const rewritten = parsedUrl.pathname + 'index.html'
              if (fs.existsSync(path.join(root, rewritten))) {
                return rewritten
              } else {
                return `/index.html`
              }
            }
          }
        ]
      })
    )
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  // 自定义hooks
  // configureServer 对外暴露 server
  postHooks.forEach((fn) => fn && fn())

  if (!middlewareMode) {
    // transform index.html
    // 转换index.html
    middlewares.use(indexHtmlMiddleware(server))
    // handle 404s
    middlewares.use((_, res) => {
      res.statusCode = 404
      res.end()
    })
  }

  // error handler
  middlewares.use(errorMiddleware(server, middlewareMode))

  // 依赖预构建
  const runOptimize = async () => {
    if (config.optimizeCacheDir) {
      server._isRunningOptimizer = true
      try {
        server._optimizeDepsMetadata = await optimizeDeps(config)
      } finally {
        server._isRunningOptimizer = false
      }
      server._registerMissingImport = createMissingImporterRegisterFn(server)
    }
  }

  if (!middlewareMode && httpServer) {
    // overwrite listen to run optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        // 开启插件
        await container.buildStart({})
        // 这里会进行依赖的预构建
        await runOptimize()
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }) as any

    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as AddressInfo).port
    })
  } else {
    await runOptimize()
  }

  return server
}

// 下面就是开启服务 关闭服务的方法

async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
  isRestart: boolean = false
): Promise<ViteDevServer> {
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server || {}
  let port = inlinePort || options.port || 3000
  let hostname = options.host || 'localhost'
  if (hostname === '0.0.0.0') hostname = 'localhost'
  const protocol = options.https ? 'https' : 'http'
  const info = server.config.logger.info
  const base = server.config.base

  return new Promise((resolve, reject) => {
    const onError = (e: Error & { code?: string }) => {
      if (e.code === 'EADDRINUSE') {
        if (options.strictPort) {
          httpServer.removeListener('error', onError)
          reject(new Error(`Port ${port} is already in use`))
        } else {
          info(`Port ${port} is in use, trying another one...`)
          httpServer.listen(++port)
        }
      } else {
        httpServer.removeListener('error', onError)
        reject(e)
      }
    }

    httpServer.on('error', onError)

    httpServer.listen(port, options.host, () => {
      httpServer.removeListener('error', onError)

      info(
        chalk.cyan(`\n  vite v${require('vite/package.json').version}`) +
          chalk.green(` dev server running at:\n`),
        {
          clear: !server.config.logger.hasWarned
        }
      )
      const interfaces = os.networkInterfaces()
      Object.keys(interfaces).forEach((key) =>
        (interfaces[key] || [])
          .filter((details) => details.family === 'IPv4')
          .map((detail) => {
            return {
              type: detail.address.includes('127.0.0.1')
                ? 'Local:   '
                : 'Network: ',
              host: detail.address.replace('127.0.0.1', hostname)
            }
          })
          .forEach(({ type, host }) => {
            const url = `${protocol}://${host}:${chalk.bold(port)}${base}`
            info(`  > ${type} ${chalk.cyan(url)}`)
          })
      )

      // @ts-ignore
      if (global.__vite_start_time) {
        info(
          chalk.cyan(
            // @ts-ignore
            `\n  ready in ${Date.now() - global.__vite_start_time}ms.\n`
          )
        )
      }

      // @ts-ignore
      const profileSession = global.__vite_profile_session
      if (profileSession) {
        profileSession.post('Profiler.stop', (err: any, { profile }: any) => {
          // Write profile to disk, upload, etc.
          if (!err) {
            const outPath = path.resolve('./vite-profile.cpuprofile')
            fs.writeFileSync(outPath, JSON.stringify(profile))
            info(
              chalk.yellow(
                `  CPU profile written to ${chalk.white.dim(outPath)}\n`
              )
            )
          } else {
            throw err
          }
        })
      }

      if (options.open && !isRestart) {
        const path = typeof options.open === 'string' ? options.open : base
        openBrowser(
          `${protocol}://${hostname}:${port}${path}`,
          true,
          server.config.logger
        )
      }

      resolve(server)
    })
  })
}

function createSeverCloseFn(server: http.Server | null) {
  if (!server) {
    return () => {}
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}
