import chalk from 'chalk'
import { Server } from 'http'
import WebSocket from 'ws'
import { ErrorPayload, HMRPayload } from 'types/hmrPayload'
import { ResolvedConfig } from '..'

export const HMR_HEADER = 'vite-hmr'

export interface WebSocketServer {
  send(payload: HMRPayload): void
  close(): Promise<void>
}

// 创建websocket
export function createWebSocketServer(
  server: Server | null,
  config: ResolvedConfig
): WebSocketServer {
  // 声明wss 实例
  let wss: WebSocket.Server

  // 如果有http
  if (server) {
    wss = new WebSocket.Server({ noServer: true })
    // 监听upgrade
    server.on('upgrade', (req, socket, head) => {
      // 如果请求Sec-WebSocket-Protocol 为vite-hmr的话
      if (req.headers['sec-websocket-protocol'] === HMR_HEADER) {
        // 连接
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      }
    })
  } else {
    // vite dev server in middleware mode
    // 如果是中间件模式下的 需要单独起ws 服务，并且默认端口24678
    wss = new WebSocket.Server({
      port:
        (typeof config.server.hmr === 'object' && config.server.hmr.port) ||
        24678
    })
  }

  // 连接信息
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }))
    if (bufferedError) {
      socket.send(JSON.stringify(bufferedError))
      bufferedError = null
    }
  })

  wss.on('error', (e: Error & { code: string }) => {
    if (e.code !== 'EADDRINUSE') {
      config.logger.error(
        chalk.red(`WebSocket server error:\n${e.stack || e.message}`)
      )
    }
  })

  // On page reloads, if a file fails to compile and returns 500, the server
  // sends the error payload before the client connection is established.
  // If we have no open clients, buffer the error and send it to the next
  // connected client.
  let bufferedError: ErrorPayload | null = null

  return {
    send(payload: HMRPayload) {
      if (payload.type === 'error' && !wss.clients.size) {
        bufferedError = payload
        return
      }

      // 序列化信息 发送
      const stringified = JSON.stringify(payload)
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(stringified)
        }
      })
    },

    // 服务关闭 返回Promise
    close() {
      return new Promise((resolve, reject) => {
        wss.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    }
  }
}
