import { parentPort } from 'node:worker_threads'
import { collectIdentifierHashes } from './nameindex'
import { scanSource } from './scan'
import type { ScannedSymbol } from '../shared/types'

/**
 * worker_threads 入口（A）。
 *
 * 协议：
 *   主线程 → worker: `{ id: number, text: string }`
 *   worker → 主线程: `{ id, symbols: ScannedSymbol[], hashes: Uint32Array }` 或 `{ id, error: string }`
 *   一次读取同时产出符号与标识符哈希（引用索引不再二次读盘）。
 */
interface ScanRequest {
  id: number
  text: string
}

interface ScanResponse {
  id: number
  symbols?: ScannedSymbol[]
  hashes?: Uint32Array
  error?: string
}

if (parentPort) {
  const port = parentPort
  port.on('message', (message: ScanRequest) => {
    const response: ScanResponse = { id: message.id }
    try {
      response.symbols = scanSource(message.text)
      response.hashes = collectIdentifierHashes(message.text)
    } catch (err) {
      response.error = err instanceof Error ? err.message : String(err)
    }
    port.postMessage(response)
  })
}

export {}
