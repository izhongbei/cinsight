import { parentPort } from 'node:worker_threads'
import { scanSource } from './scan'
import type { ScannedSymbol } from '../shared/types'

/**
 * worker_threads 入口（A）。
 *
 * 协议：
 *   主线程 → worker: `{ id: number, text: string }`
 *   worker → 主线程: `{ id: number, symbols: ScannedSymbol[] }` 或 `{ id: number, error: string }`
 */
interface ScanRequest {
  id: number
  text: string
}

interface ScanResponse {
  id: number
  symbols?: ScannedSymbol[]
  error?: string
}

if (parentPort) {
  const port = parentPort
  port.on('message', (message: ScanRequest) => {
    const response: ScanResponse = { id: message.id }
    try {
      response.symbols = scanSource(message.text)
    } catch (err) {
      response.error = err instanceof Error ? err.message : String(err)
    }
    port.postMessage(response)
  })
}

export {}
