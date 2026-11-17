import { appendFile, mkdir, readFile, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import type { SymbolEntry, SymbolTable } from '../shared/types'
import { saveSnapshot } from './store'
import { KIND_CODES } from './symbol-table'

export const SNAPSHOT_DELTA_MAGIC = 'SIDD'
export const SNAPSHOT_DELTA_VERSION = 1
const HEADER_BYTES = 8
const KIND_NAMES = ['function', 'declaration', 'macro', 'struct', 'union', 'enum', 'typedef'] as const

export type SnapshotDeltaRecord =
  | {
      readonly kind: 'set'
      readonly path: string
      readonly mtimeMs: number
      readonly size: number
      readonly entries: readonly SymbolEntry[]
    }
  | { readonly kind: 'remove'; readonly path: string }

export function snapshotDeltaPath(basePath: string): string {
  return `${basePath}.delta`
}

/**
 * 编码一条 delta 记录，返回「头 + 记录体」的自描述块（头为 SIDD + 版本）。
 * 单独 decode 该返回值即可还原记录；append 到已有 delta 文件时只追加记录体。
 */
export function encodeSnapshotDeltaRecord(record: SnapshotDeltaRecord): Buffer {
  const body = encodeSnapshotDeltaBody(record)
  const buffer = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  buffer.write(SNAPSHOT_DELTA_MAGIC, 0, 'latin1')
  buffer.writeUInt32LE(SNAPSHOT_DELTA_VERSION, 4)
  body.copy(buffer, HEADER_BYTES)
  return buffer
}

function encodeSnapshotDeltaBody(record: SnapshotDeltaRecord): Buffer {
  const pathBytes = Buffer.from(record.path, 'utf8')
  const header = 1 + 4 + pathBytes.length
  if (record.kind === 'remove') {
    const buffer = Buffer.allocUnsafe(header)
    buffer.writeUInt8(1, 0)
    buffer.writeUInt32LE(pathBytes.length, 1)
    pathBytes.copy(buffer, 5)
    return buffer
  }
  let entryBytes = 0
  const encoded = record.entries.map((entry) => {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    entryBytes += 4 + nameBytes.length + 4 + 4 + 2 + 1
    return { entry, nameBytes }
  })
  const buffer = Buffer.allocUnsafe(header + 8 + 4 + 4 + entryBytes)
  let offset = 0
  buffer.writeUInt8(0, offset)
  offset += 1
  buffer.writeUInt32LE(pathBytes.length, offset)
  offset += 4
  pathBytes.copy(buffer, offset)
  offset += pathBytes.length
  buffer.writeDoubleLE(record.mtimeMs, offset)
  offset += 8
  buffer.writeUInt32LE(Math.min(record.size ?? 0, 0xffffffff), offset)
  offset += 4
  buffer.writeUInt32LE(encoded.length, offset)
  offset += 4
  for (const { entry, nameBytes } of encoded) {
    buffer.writeUInt32LE(nameBytes.length, offset)
    offset += 4
    nameBytes.copy(buffer, offset)
    offset += nameBytes.length
    buffer.writeUInt32LE(entry.line, offset)
    offset += 4
    buffer.writeUInt32LE(entry.endLine, offset)
    offset += 4
    buffer.writeUInt16LE(Math.min(entry.column, 0xffff), offset)
    offset += 2
    buffer.writeUInt8(KIND_CODES[entry.kind] ?? 0, offset)
    offset += 1
  }
  return buffer
}

function hasSnapshotDeltaHeader(buffer: Buffer): boolean {
  return (
    buffer.length >= HEADER_BYTES &&
    buffer.toString('latin1', 0, 4) === SNAPSHOT_DELTA_MAGIC &&
    buffer.readUInt32LE(4) === SNAPSHOT_DELTA_VERSION
  )
}

/**
 * 解析 delta 缓冲区。`records` 与 `decodeSnapshotDeltaRecords` 的返回值一致；
 * `end` 为最后一个完整记录的结束偏移（头部合法但无完整记录时为 HEADER_BYTES，
 * 头部非法时为 0），`end` 之后的字节是撕裂/不可解码的尾部。
 */
function parseSnapshotDeltaBuffer(buffer: Buffer): { records: SnapshotDeltaRecord[]; end: number } {
  if (!hasSnapshotDeltaHeader(buffer)) return { records: [], end: 0 }
  const records: SnapshotDeltaRecord[] = []
  let offset = HEADER_BYTES
  let end = HEADER_BYTES
  while (offset < buffer.length) {
    const recordStart = offset
    if (offset + 5 > buffer.length) break
    const kind = buffer.readUInt8(offset)
    const pathLength = buffer.readUInt32LE(offset + 1)
    offset += 5
    if (offset + pathLength > buffer.length) break
    const filePath = buffer.toString('utf8', offset, offset + pathLength)
    offset += pathLength
    if (kind === 1) {
      records.push({ kind: 'remove', path: filePath })
      end = offset
      continue
    }
    if (kind !== 0) break
    if (offset + 16 > buffer.length) { offset = recordStart; break }
    const mtimeMs = buffer.readDoubleLE(offset)
    offset += 8
    const size = buffer.readUInt32LE(offset)
    offset += 4
    const entryCount = buffer.readUInt32LE(offset)
    offset += 4
    const entries: SymbolEntry[] = []
    let truncated = false
    for (let index = 0; index < entryCount; index++) {
      if (offset + 4 > buffer.length) { truncated = true; break }
      const nameLength = buffer.readUInt32LE(offset)
      offset += 4
      if (offset + nameLength + 4 + 4 + 2 + 1 > buffer.length) { truncated = true; break }
      const name = buffer.toString('utf8', offset, offset + nameLength)
      offset += nameLength
      const line = buffer.readUInt32LE(offset)
      offset += 4
      const endLine = buffer.readUInt32LE(offset)
      offset += 4
      const column = buffer.readUInt16LE(offset)
      offset += 2
      const kindCode = buffer.readUInt8(offset)
      offset += 1
      entries.push({
        name,
        kind: KIND_NAMES[kindCode] ?? 'function',
        file: filePath,
        line,
        endLine,
        column,
      })
    }
    if (truncated) break
    records.push({ kind: 'set', path: filePath, mtimeMs, size, entries })
    end = offset
  }
  return { records, end }
}

export function decodeSnapshotDeltaRecords(buffer: Buffer): SnapshotDeltaRecord[] {
  return parseSnapshotDeltaBuffer(buffer).records
}

/** 进程内按 delta 文件路径串行化 append，避免 stat/读头/截断/追加序列交错。 */
const appendChains = new Map<string, Promise<void>>()

function withSnapshotDeltaAppendLock<T>(deltaPath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(deltaPath)
  const previous = appendChains.get(key) ?? Promise.resolve()
  const result = previous.then(task, task)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  appendChains.set(key, tail)
  void tail.then(() => {
    if (appendChains.get(key) === tail) appendChains.delete(key)
  })
  return result
}

export function appendSnapshotDelta(deltaPath: string, record: SnapshotDeltaRecord): Promise<number> {
  return withSnapshotDeltaAppendLock(deltaPath, () => appendSnapshotDeltaLocked(deltaPath, record))
}

async function appendSnapshotDeltaLocked(
  deltaPath: string,
  record: SnapshotDeltaRecord,
): Promise<number> {
  const encoded = encodeSnapshotDeltaRecord(record)
  const body = encoded.subarray(HEADER_BYTES)
  await mkdir(path.dirname(deltaPath), { recursive: true })
  let existing: Buffer | undefined
  try {
    existing = await readFile(deltaPath)
  } catch {
    existing = undefined
  }
  if (!existing || existing.length === 0) {
    await appendFile(deltaPath, encoded)
    return encoded.length
  }
  if (!hasSnapshotDeltaHeader(existing)) {
    // 撕裂的头部 / 坏 magic / 版本不符：整个文件都不可解码，直接整体覆盖（截断到 0 再写）。
    await writeFile(deltaPath, encoded)
    return encoded.length
  }
  const { end } = parseSnapshotDeltaBuffer(existing)
  if (end < existing.length) {
    // 尾部有未写完整的记录：先截断到最后一个完整记录边界，保证后续记录仍可解码。
    await truncate(deltaPath, end)
  }
  await appendFile(deltaPath, body)
  return body.length
}

export async function readSnapshotDeltas(deltaPath: string): Promise<SnapshotDeltaRecord[]> {
  try {
    return decodeSnapshotDeltaRecords(await readFile(deltaPath))
  } catch {
    return []
  }
}

export async function snapshotDeltaBytes(deltaPath: string): Promise<number> {
  try {
    return (await stat(deltaPath)).size
  } catch {
    return 0
  }
}

export async function removeSnapshotDelta(deltaPath: string): Promise<void> {
  await unlink(deltaPath).catch(() => undefined)
}

/** 把当前表写成新 base，并删除 delta（原子写：store.saveSnapshot 内部 .tmp+rename）。 */
export async function compactSnapshot(
  basePath: string,
  table: SymbolTable,
): Promise<{ baseBytes: number; deltaTruncated: boolean }> {
  const baseBytes = await saveSnapshot(basePath, table)
  const deltaPath = snapshotDeltaPath(basePath)
  const had = (await snapshotDeltaBytes(deltaPath)) > 0
  await removeSnapshotDelta(deltaPath)
  return { baseBytes, deltaTruncated: had }
}
