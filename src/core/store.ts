import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { SNAPSHOT_VERSION } from '../shared/types'
import type { FileRecord, IndexSnapshot, SymbolEntry, SymbolKind } from '../shared/types'

/**
 * 二进制快照读写（A）。小端。
 *
 * 布局（与 spec §4 一致，唯一偏差见下方 `builtAt` 说明）：
 * ```
 * magic "SIDX"(4B) | version u32 | builtAt f64 | fileCount u32 | entryCount u32
 * rootsLen u32 | rootsJson utf8
 * string table: count u32, 每个 [len u32, utf8 bytes]
 * files:   [stringId u32, mtimeMs f64, size u32] × fileCount
 * entries: [nameId u32, fileIdx u32, line u32, endLine u32, col u16, kind u8, pad u8] × entryCount
 * ```
 * 偏差：spec 写的是 `builtAt u32`，但 `Date.now()` 毫秒（~1.7e12）超出 u32 范围，
 * 这里存 f64（8B）以保证 roundtrip 精确；其余字段逐字节按 spec。
 */

const MAGIC = 'SIDX'
const MAGIC_BYTES = 4
const HEADER_BYTES = MAGIC_BYTES + 4 /* version */ + 8 /* builtAt */ + 4 /* fileCount */ + 4 /* entryCount */ + 4 /* rootsLen */
const FILE_RECORD_BYTES = 4 + 8 + 4
const ENTRY_BYTES = 4 + 4 + 4 + 4 + 2 + 1 + 1

const KINDS: readonly SymbolKind[] = ['function', 'declaration', 'macro']
const KIND_CODES: Record<SymbolKind, number> = { function: 0, declaration: 1, macro: 2 }

function kindToCode(kind: SymbolKind): number {
  const code = KIND_CODES[kind]
  if (code === undefined) throw new Error(`unknown symbol kind: ${String(kind)}`)
  return code
}

function codeToKind(code: number): SymbolKind {
  const kind = KINDS[code]
  if (kind === undefined) throw new Error(`invalid symbol kind code: ${code}`)
  return kind
}

function encodeSnapshot(snapshot: IndexSnapshot): Buffer {
  const rootsJson = Buffer.from(JSON.stringify(snapshot.roots), 'utf8')
  const strings: string[] = []
  const stringIds = new Map<string, number>()
  const intern = (value: string): number => {
    const existing = stringIds.get(value)
    if (existing !== undefined) return existing
    const id = strings.length
    stringIds.set(value, id)
    strings.push(value)
    return id
  }

  const fileStringIds = snapshot.files.map((file) => intern(file.path))
  const entryNameIds = snapshot.entries.map((entry) => intern(entry.name))
  const stringBuffers = strings.map((value) => Buffer.from(value, 'utf8'))

  const fileIndexOf = new Map<string, number>()
  snapshot.files.forEach((file, index) => fileIndexOf.set(file.path, index))

  let size = HEADER_BYTES + rootsJson.length + 4 /* string count */
  for (const buffer of stringBuffers) size += 4 + buffer.length
  size += snapshot.files.length * FILE_RECORD_BYTES
  size += snapshot.entries.length * ENTRY_BYTES

  const out = Buffer.alloc(size)
  let offset = 0

  out.write(MAGIC, offset, 'latin1')
  offset += MAGIC_BYTES
  out.writeUInt32LE(SNAPSHOT_VERSION, offset)
  offset += 4
  out.writeDoubleLE(snapshot.builtAt, offset)
  offset += 8
  out.writeUInt32LE(snapshot.files.length, offset)
  offset += 4
  out.writeUInt32LE(snapshot.entries.length, offset)
  offset += 4
  out.writeUInt32LE(rootsJson.length, offset)
  offset += 4
  rootsJson.copy(out, offset)
  offset += rootsJson.length

  out.writeUInt32LE(stringBuffers.length, offset)
  offset += 4
  for (const buffer of stringBuffers) {
    out.writeUInt32LE(buffer.length, offset)
    offset += 4
    buffer.copy(out, offset)
    offset += buffer.length
  }

  snapshot.files.forEach((file, index) => {
    out.writeUInt32LE(fileStringIds[index], offset)
    offset += 4
    out.writeDoubleLE(file.mtimeMs, offset)
    offset += 8
    out.writeUInt32LE(file.size, offset)
    offset += 4
  })

  snapshot.entries.forEach((entry, index) => {
    const fileIndex = fileIndexOf.get(entry.file)
    if (fileIndex === undefined) {
      throw new Error(`snapshot entry "${entry.name}" references unknown file: ${entry.file}`)
    }
    out.writeUInt32LE(entryNameIds[index], offset)
    offset += 4
    out.writeUInt32LE(fileIndex, offset)
    offset += 4
    out.writeUInt32LE(entry.line, offset)
    offset += 4
    out.writeUInt32LE(entry.endLine, offset)
    offset += 4
    out.writeUInt16LE(entry.column, offset)
    offset += 2
    out.writeUInt8(kindToCode(entry.kind), offset)
    offset += 1
    out.writeUInt8(0, offset)
    offset += 1
  })

  if (offset !== size) throw new Error(`snapshot size mismatch: ${offset} !== ${size}`)
  return out
}

function decodeSnapshot(buffer: Buffer): IndexSnapshot {
  const total = buffer.length
  const ensure = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message)
  }
  const readU32 = (offset: number): { value: number; next: number } => {
    ensure(offset + 4 <= total, 'unexpected end of snapshot (u32)')
    return { value: buffer.readUInt32LE(offset), next: offset + 4 }
  }

  ensure(total >= HEADER_BYTES, 'snapshot too short')
  ensure(buffer.toString('latin1', 0, MAGIC_BYTES) === MAGIC, 'bad magic')
  let offset = MAGIC_BYTES

  let cursor = readU32(offset)
  offset = cursor.next
  ensure(cursor.value === SNAPSHOT_VERSION, 'snapshot version mismatch')
  const version = cursor.value

  ensure(offset + 8 <= total, 'unexpected end of snapshot (builtAt)')
  const builtAt = buffer.readDoubleLE(offset)
  offset += 8
  ensure(Number.isFinite(builtAt), 'invalid builtAt')

  cursor = readU32(offset)
  offset = cursor.next
  const fileCount = cursor.value
  cursor = readU32(offset)
  offset = cursor.next
  const entryCount = cursor.value
  cursor = readU32(offset)
  offset = cursor.next
  const rootsLen = cursor.value

  ensure(offset + rootsLen <= total, 'roots out of bounds')
  const rootsRaw = buffer.toString('utf8', offset, offset + rootsLen)
  offset += rootsLen
  let roots: string[]
  try {
    const parsed: unknown = JSON.parse(rootsRaw)
    ensure(Array.isArray(parsed), 'roots is not an array')
    ensure(
      (parsed as unknown[]).every((item) => typeof item === 'string'),
      'roots contains non-string',
    )
    roots = parsed as string[]
  } catch (err) {
    throw new Error(`invalid roots json: ${err instanceof Error ? err.message : String(err)}`)
  }

  cursor = readU32(offset)
  offset = cursor.next
  const stringCount = cursor.value
  ensure(stringCount <= (total - offset) / 4, 'string table out of bounds')
  const strings: string[] = new Array(stringCount)
  for (let i = 0; i < stringCount; i++) {
    cursor = readU32(offset)
    offset = cursor.next
    const length = cursor.value
    ensure(offset + length <= total, 'string out of bounds')
    strings[i] = buffer.toString('utf8', offset, offset + length)
    offset += length
  }

  ensure(offset + fileCount * FILE_RECORD_BYTES + entryCount * ENTRY_BYTES <= total, 'table out of bounds')

  const files: FileRecord[] = new Array(fileCount)
  for (let i = 0; i < fileCount; i++) {
    cursor = readU32(offset)
    offset = cursor.next
    const stringId = cursor.value
    ensure(stringId < strings.length, 'file path string id out of range')
    ensure(offset + 8 + 4 <= total, 'unexpected end of snapshot (file)')
    const mtimeMs = buffer.readDoubleLE(offset)
    offset += 8
    const size = buffer.readUInt32LE(offset)
    offset += 4
    ensure(Number.isFinite(mtimeMs), 'invalid file mtime')
    files[i] = { path: strings[stringId], mtimeMs, size }
  }

  const entries: SymbolEntry[] = new Array(entryCount)
  for (let i = 0; i < entryCount; i++) {
    cursor = readU32(offset)
    offset = cursor.next
    const nameId = cursor.value
    cursor = readU32(offset)
    offset = cursor.next
    const fileIdx = cursor.value
    cursor = readU32(offset)
    offset = cursor.next
    const line = cursor.value
    cursor = readU32(offset)
    offset = cursor.next
    const endLine = cursor.value
    ensure(offset + 2 + 1 + 1 <= total, 'unexpected end of snapshot (entry)')
    const column = buffer.readUInt16LE(offset)
    offset += 2
    const kindCode = buffer.readUInt8(offset)
    offset += 1
    offset += 1 // padding
    ensure(nameId < strings.length, 'entry name string id out of range')
    ensure(fileIdx < files.length, 'entry file index out of range')
    entries[i] = { name: strings[nameId], kind: codeToKind(kindCode), file: files[fileIdx].path, line, endLine, column }
  }

  ensure(offset === total, 'trailing bytes in snapshot')
  return { version, roots, builtAt, files, entries }
}

/** 读取快照；文件不存在、损坏或版本不符一律返回 undefined（不抛异常）。 */
export async function loadSnapshot(file: string): Promise<IndexSnapshot | undefined> {
  let buffer: Buffer
  try {
    buffer = await fsp.readFile(file)
  } catch {
    return undefined
  }
  try {
    return decodeSnapshot(buffer)
  } catch {
    return undefined
  }
}

/** 原子写快照（`.tmp` + rename），返回写入字节数。 */
export async function saveSnapshot(file: string, snapshot: IndexSnapshot): Promise<number> {
  const buffer = encodeSnapshot(snapshot)
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fsp.writeFile(temp, buffer)
    await fsp.rename(temp, file)
  } catch (err) {
    try {
      await fsp.unlink(temp)
    } catch {
      // 临时文件可能本来就没写成功，忽略清理失败
    }
    throw err
  }
  return buffer.length
}
