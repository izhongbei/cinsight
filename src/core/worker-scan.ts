import { parentPort } from 'node:worker_threads'
import { hashContent64 } from './hash'
import { collectIdentifierHashes } from './nameindex'
import { scanIncludes, scanSource } from './scan'
import type { ScannedInclude, ScannedSymbol } from '../shared/types'

/**
 * worker_threads 入口（A）。
 *
 * 协议：
 *   主线程 → worker: `{ id: number, text: string }`
 *   worker → 主线程: `{ id, symbols, hashes, contentHash, includes }` 或 `{ id, error: string }`
 *   一次读取同时产出符号、标识符哈希、内容哈希与 include 列表（引用索引/分组不再二次读盘）。
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
      response.symbols = scanSource(message.text)
      response.hashes = collectIdentifierHashes(message.text)
      response.contentHash = hashContent64(message.text)
      response.includes = scanIncludes(message.text)
    } catch (err) {
      response.error = err instanceof Error ? err.message : String(err)
    }
    port.postMessage(response)
  })
}

export {}
