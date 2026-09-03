import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { HOME } from './fs'

/**
 * 轻量结构化 logger：
 * - console：按级别走 console.error/warn/log（开发期可见）
 * - 文件：追加到 <logDir>/main.log，单文件 >2MB 自动 rotate 保留 main.log.1
 * - 进程级：捕获 unhandledRejection / uncaughtException，**不杀进程**
 *
 * 远程上报未实现（接口预留：installReporter() 可注入第三方通道）。
 */

type Level = 'error' | 'warn' | 'info' | 'debug'

interface Entry {
  ts: string
  level: Level
  scope: string
  msg: string
  err?: { name: string; message: string; stack?: string }
}

let logDir = ''
let logPath = ''
let inited = false
let bytesWritten = 0
const MAX_BYTES = 2 * 1024 * 1024

function getLogDir(): string {
  if (logDir) return logDir
  // 优先 app.getPath('logs')（用户可见），开发期 fallback HOME 下的 .agenttower/logs
  try {
    logDir = app.getPath('logs')
  } catch {
    logDir = join(HOME, '.agenttower', 'logs')
  }
  return logDir
}

function ensureInit(): string {
  if (inited) return logPath
  const dir = getLogDir()
  mkdirSync(dir, { recursive: true })
  logPath = join(dir, 'main.log')
  try {
    bytesWritten = existsSync(logPath) ? statSync(logPath).size : 0
  } catch {
    bytesWritten = 0
  }
  inited = true
  return logPath
}

function rotate(): void {
  const old = `${logPath}.1`
  try {
    if (existsSync(old)) {
      // 已经有 .1，直接丢
      // （最简策略：单文件 rotate，保留 1 份历史；想要 N 份把这里改成循环）
    }
    renameSync(logPath, old)
  } catch {
    /* rotate 失败就继续写，新数据会追加到原文件 */
  }
  bytesWritten = 0
}

function formatErr(err: unknown): Entry['err'] {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { name: 'NonError', message: String(err) }
}

function write(entry: Entry): void {
  // 控制台（保持原行为，便于开发期阅读）
  const line = `[${entry.ts}] ${entry.level.toUpperCase()} ${entry.scope}: ${entry.msg}`
  if (entry.level === 'error') {
    console.error(line, entry.err ?? '')
  } else if (entry.level === 'warn') {
    console.warn(line, entry.err ?? '')
  } else {
    console.log(line)
  }
  // 文件
  try {
    ensureInit()
    if (bytesWritten > MAX_BYTES) rotate()
    const payload =
      JSON.stringify(entry) +
      (entry.err?.stack ? '\n  ' + entry.err.stack.replace(/\n/g, '\n  ') : '') +
      '\n'
    appendFileSync(logPath, payload)
    bytesWritten += Buffer.byteLength(payload, 'utf8')
  } catch {
    /* 日志写失败不能再 throw，否则会掩盖原异常 */
  }
}

function log(level: Level, scope: string, msg: string, err?: unknown): void {
  write({ ts: new Date().toISOString(), level, scope, msg, err: err !== undefined ? formatErr(err) : undefined })
}

export const logger = {
  error: (scope: string, msg: string, err?: unknown): void => log('error', scope, msg, err),
  warn: (scope: string, msg: string, err?: unknown): void => log('warn', scope, msg, err),
  info: (scope: string, msg: string): void => log('info', scope, msg),
  debug: (scope: string, msg: string, err?: unknown): void => log('debug', scope, msg, err)
}

let installed = false

/**
 * 装上进程级兜底。必须 main 进程启动早期调用一次。
 * 策略：未捕获错误/拒绝一律 logger.error，不退出（Electron 主进程崩溃会带走整个 app）。
 */
export function installProcessHandlers(): void {
  if (installed) return
  installed = true
  process.on('unhandledRejection', (reason) => {
    logger.error('process', 'unhandledRejection', reason)
  })
  process.on('uncaughtException', (err) => {
    logger.error('process', 'uncaughtException', err)
  })
}

/** 暴露日志目录给 settings/排错 UI */
export function getLogFilePath(): string {
  ensureInit()
  return logPath
}
