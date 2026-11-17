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
 * 单独 decode 该返回值即可还原记录。
 *
 * 注意：返回值自带文件头，**不能**直接 append 到非空 delta 文件（会在文件中段插入
 * 第二个头，使其后记录不可解码）。写文件请一律使用 `appendSnapshotDelta`。
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

export interface SnapshotDeltaScan {
  /** 最后一个完整记录的结束偏移（头部合法但无完整记录时为 HEADER_BYTES；头部非法时为 0）。 */
  readonly end: number
  /** `end` 之前的完整记录数。 */
  readonly recordCount: number
  /** 文件头（SIDD + 版本）是否合法。 */
  readonly valid: boolean
}

/**
 * 只按记录长度游标扫描 delta 尾部，**不解码路径 / 名字 / 条目**（不分配字符串或对象）。
 *
 * 用于 append 前校验尾部、把撕裂的记录尾部截断；成本是 O(delta 字节) 的单次顺序读，
 * 但不会物化任何 SymbolEntry。service 还会按 stat 大小缓存 `end`，正常情况下每次 append
 * 只需要一次 stat（见 `appendSnapshotDeltaDetailed`）。
 */
export function scanSnapshotDeltaEnd(buffer: Buffer): SnapshotDeltaScan {
  if (!hasSnapshotDeltaHeader(buffer)) return { end: 0, recordCount: 0, valid: false }
  let offset = HEADER_BYTES
  let end = HEADER_BYTES
  let recordCount = 0
  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) break
    const kind = buffer.readUInt8(offset)
    const pathLength = buffer.readUInt32LE(offset + 1)
    offset += 5
    if (offset + pathLength > buffer.length) break
    offset += pathLength
    if (kind === 1) {
      recordCount += 1
      end = offset
      continue
    }
    if (kind !== 0) break
    // set 记录：mtime(8) + size(4) + entryCount(4)
    if (offset + 16 > buffer.length) break
    const entryCount = buffer.readUInt32LE(offset + 12)
    offset += 16
    let truncated = false
    for (let index = 0; index < entryCount; index++) {
      if (offset + 4 > buffer.length) {
        truncated = true
        break
      }
      const nameLength = buffer.readUInt32LE(offset)
      const next = offset + 4 + nameLength + 4 + 4 + 2 + 1
      if (next > buffer.length) {
        truncated = true
        break
      }
      offset = next
    }
    if (truncated) break
    recordCount += 1
    end = offset
  }
  return { end, recordCount, valid: true }
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

/**
 * append 用的尾部缓存：本进程最后一次看到的 delta 大小 / 完整记录数 / 结束偏移 / ctime。
 *
 * - `size` 命中且 `ctimeMs` 未变（只由本进程写、期间也没人 chmod）时，append 只需 stat，
 *   不再读盘、不再扫描（稳态单次 append 与 delta 总大小无关）。
 * - 其他情况（新文件、被其他进程追加、被 chmod、进程重启）回退到「读 + 只按长度扫描」。
 * - ctime 用来发现元数据变化（例如文件被改成不可读）：此时必须走 readFile，让 EACCES 上抛，
 *   而不是把不可读文件当成可安全追加。
 */
interface SnapshotDeltaAppendCacheEntry {
  readonly size: number
  readonly end: number
  readonly recordCount: number
  readonly ctimeMs: number
}

const lastKnownDeltaEnd = new Map<string, SnapshotDeltaAppendCacheEntry>()

async function rememberDeltaState(
  key: string,
  deltaPath: string,
  fallbackSize: number,
  recordCount: number,
): Promise<SnapshotDeltaAppendCacheEntry> {
  let entry: SnapshotDeltaAppendCacheEntry = {
    size: fallbackSize,
    end: fallbackSize,
    recordCount,
    ctimeMs: 0,
  }
  try {
    const info = await stat(deltaPath)
    entry = { size: info.size, end: info.size, recordCount, ctimeMs: info.ctimeMs }
  } catch {
    // stat 失败（罕见）：保留保守估值，下一次 append 会因 ctime 不匹配而读盘重扫。
  }
  lastKnownDeltaEnd.set(key, entry)
  return entry
}

export interface SnapshotDeltaAppendResult {
  /** 本次实际写入的字节数（新文件 / 重建文件为头 + 记录体，已有文件为记录体）。 */
  readonly bytesWritten: number
  /** append 完成后文件的字节数（已计入被截断的撕裂尾部）。 */
  readonly size: number
  /** append 完成后文件中的完整记录数。 */
  readonly recordCount: number
  /** 文件头非法、整个文件被重建（旧内容已不可解码，因此不算丢失有效记录）。 */
  readonly reset: boolean
}

/**
 * 追加一条 delta 记录，返回本次实际写入的字节数（兼容旧 API）。
 * 需要同时拿到追加后的文件大小 / 记录数时用 `appendSnapshotDeltaDetailed`。
 *
 * 并发假设：串行化只在**当前进程内**、按 resolve 后的 delta 路径生效（见 `appendChains`）；
 * 跨进程（多个 VS Code 窗口共享 storage）的冲突由 service 层按预期大小/记录数检测并放弃
 * compaction，详见 `SymbolService`。
 *
 * 稳态成本：两次 stat（一次校验缓存、一次记录新状态），命中 `lastKnownDeltaEnd` 时不读
 * 文件；只有大小/ctime 变化时才读盘并用 `scanSnapshotDeltaEnd` 按长度扫描尾部（不物化
 * SymbolEntry）。
 */
export function appendSnapshotDelta(deltaPath: string, record: SnapshotDeltaRecord): Promise<number> {
  return appendSnapshotDeltaDetailed(deltaPath, record).then((result) => result.bytesWritten)
}

export function appendSnapshotDeltaDetailed(
  deltaPath: string,
  record: SnapshotDeltaRecord,
): Promise<SnapshotDeltaAppendResult> {
  return withSnapshotDeltaAppendLock(deltaPath, () => appendSnapshotDeltaLocked(deltaPath, record))
}

/** 等待所有在途 appendSnapshotDelta 完成（compaction 前调用，避免删除尚未落盘的记录）。 */
export async function flushSnapshotDeltaAppends(): Promise<void> {
  while (appendChains.size > 0) {
    await Promise.all([...appendChains.values()])
  }
}

async function appendSnapshotDeltaLocked(
  deltaPath: string,
  record: SnapshotDeltaRecord,
): Promise<SnapshotDeltaAppendResult> {
  const key = path.resolve(deltaPath)
  const encoded = encodeSnapshotDeltaRecord(record)
  const body = encoded.subarray(HEADER_BYTES)
  await mkdir(path.dirname(deltaPath), { recursive: true })

  let existingSize = 0
  let existingCtimeMs = 0
  try {
    const info = await stat(deltaPath)
    existingSize = info.size
    existingCtimeMs = info.ctimeMs
  } catch (error) {
    // 只有「文件不存在」才视为空 delta 去新建；EACCES/EIO 等 stat 错误必须上抛。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (existingSize === 0) {
    await appendFile(deltaPath, encoded)
    await rememberDeltaState(key, deltaPath, encoded.length, 1)
    return { bytesWritten: encoded.length, size: encoded.length, recordCount: 1, reset: false }
  }

  const cached = lastKnownDeltaEnd.get(key)
  if (cached && cached.size === existingSize && cached.ctimeMs === existingCtimeMs) {
    // 只有本进程在写：无需读盘，直接追加。
    await appendFile(deltaPath, body)
    const size = existingSize + body.length
    const recordCount = cached.recordCount + 1
    await rememberDeltaState(key, deltaPath, size, recordCount)
    return { bytesWritten: body.length, size, recordCount, reset: false }
  }

  let existing: Buffer
  try {
    existing = await readFile(deltaPath)
  } catch (error) {
    // stat 与 read 之间文件被删除：当作新建处理；其他读错误（EACCES 等）必须上抛，
    // 否则会把已有有效记录的文件当成空文件整体覆盖（丢失历史）或插入第二个头。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await appendFile(deltaPath, encoded)
    await rememberDeltaState(key, deltaPath, encoded.length, 1)
    return { bytesWritten: encoded.length, size: encoded.length, recordCount: 1, reset: false }
  }

  const scan = scanSnapshotDeltaEnd(existing)
  if (!scan.valid) {
    // 撕裂的头部 / 坏 magic / 版本不符：整个文件都不可解码，直接整体覆盖（截断到 0 再写）。
    await writeFile(deltaPath, encoded)
    await rememberDeltaState(key, deltaPath, encoded.length, 1)
    return { bytesWritten: encoded.length, size: encoded.length, recordCount: 1, reset: true }
  }
  if (scan.end < existing.length) {
    // 尾部有未写完整的记录：先截断到最后一个完整记录边界，保证后续记录仍可解码。
    await truncate(deltaPath, scan.end)
  }
  await appendFile(deltaPath, body)
  const size = scan.end + body.length
  const recordCount = scan.recordCount + 1
  await rememberDeltaState(key, deltaPath, size, recordCount)
  return { bytesWritten: body.length, size, recordCount, reset: false }
}

export interface SnapshotDeltaReadResult {
  readonly records: SnapshotDeltaRecord[]
  /** 读文件失败（ENOENT 除外）时的错误文本；解码问题只体现在 `droppedBytes`。 */
  readonly error?: string
  /** 从第一个不可解码记录起被丢弃的尾部字节数（文件头非法时为整个文件大小）。 */
  readonly droppedBytes: number
}

/**
 * 读取并解码 delta，同时报告「读失败」与「尾部被丢弃的字节数」。
 * `readSnapshotDeltas` 是它的兼容包装（只返回 records）。
 */
export async function readSnapshotDeltasDetailed(deltaPath: string): Promise<SnapshotDeltaReadResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(deltaPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], droppedBytes: 0 }
    }
    return {
      records: [],
      error: error instanceof Error ? error.message : String(error),
      droppedBytes: 0,
    }
  }
  const { records, end } = parseSnapshotDeltaBuffer(buffer)
  return { records, droppedBytes: Math.max(0, buffer.length - end) }
}

export async function readSnapshotDeltas(deltaPath: string): Promise<SnapshotDeltaRecord[]> {
  return (await readSnapshotDeltasDetailed(deltaPath)).records
}

export async function snapshotDeltaBytes(deltaPath: string): Promise<number> {
  try {
    return (await stat(deltaPath)).size
  } catch {
    return 0
  }
}

export async function removeSnapshotDelta(deltaPath: string): Promise<void> {
  lastKnownDeltaEnd.delete(path.resolve(deltaPath))
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
