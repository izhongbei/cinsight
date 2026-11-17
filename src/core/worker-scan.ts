import { parentPort } from 'node:worker_threads'
import { hashContent64 } from './hash'
import { collectIdentifierHashes } from './nameindex'
import { scanIncludesFromStripped, scanSource, stripSources } from './scan'
import type { ScannedInclude, ScannedSymbol } from '../shared/types'

/**
 * worker_threads 入口（A）。
 *
 * 协议：
 *   主线程 → worker: `{ id: number, text: string }`
 *   worker → 主线程: `{ id, symbols, hashes, contentHash, includes }` 或 `{ id, error: string }`
 *   一次读取同时产出符号、标识符哈希、内容哈希与 include 列表（引用索引/分组不再二次读盘）。
 *
 * 每个文件只做一次 `stripSources`：符号与 include/条件元数据共用同一份剥离结果。
 */
interface ScanRequest {
  id: number
  text: string
}

interface ScanResponse {
  id: number
  symbols?: ScannedSymbol[]
  hashes?: Uint32Array
  contentHash?: { lo: number; hi: number }
  includes?: ScannedInclude[]
  error?: string
}

if (parentPort) {
  const port = parentPort
  port.on('message', (message: ScanRequest) => {
    const response: ScanResponse = { id: message.id }
    try {
      const text = message.text
      const stripped = stripSources(text)
      response.symbols = scanSource(text, stripped)
      response.hashes = collectIdentifierHashes(text, stripped)
      response.contentHash = hashContent64(text)
      // worker 不返回条件时间线，只从同一份 stripped 取 include，避免多余的第二次条件扫描
      response.includes = scanIncludesFromStripped(stripped, text)
    } catch (err) {
      response.error = err instanceof Error ? err.message : String(err)
    }
    port.postMessage(response)
  })
}

export {}
