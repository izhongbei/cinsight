import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { SNAPSHOT_VERSION } from '../shared/types'
import type { FileRecord, SymbolTable } from '../shared/types'
import {
  createSymbolTable,
  getSymbolTableColumns,
  symbolTableFromColumns,
  type SymbolTableColumns,
} from './symbol-table'

/**
 * 二进制快照读写（v4，列式 + include 图 + 内容哈希 + 条件栈）。
 *
 * 布局（小端）：
 * ```
 * magic "SIDX"(4B) | version u32 | builtAt f64 | fileCount u32 | entryCount u32
 * nameCount u32 | rootsLen u32 | rootsJson
 * files:  [pathLen u32, path utf8, mtimeMs f64, size u32, hashLo u32, hashHi u32] × fileCount
 * names:  [len u32, utf8] × nameCount
 * conditions: count u32 | [len u32, utf8] × count   // 0 号固定为 ''（无条件）
 * nameIds u32[entryCount] | fileIndexes u32[entryCount]
 * lines u32[entryCount] | endLines u32[entryCount]
 * columns u16[entryCount] | kinds u8[entryCount] | conditionIds u32[entryCount]
 * nameOffsets u32[nameCount+1] | fileEntryOffsets u32[fileCount+1]
 * fileEntryIndexes u32[entryCount]
 * includeOffsets u32[fileCount+1] | includeTargets u32[edgeCount]
 * ```
 * 读取时直接映射成 TypedArray（不做对象化），149 万符号约 50MB 堆、加载 100ms 级；
 * 旧版本快照由版本号不匹配自然失效并触发重建。
 */

const MAGIC = 'SIDX'
const MAGIC_BYTES = 4
/** magic(4) + version(4) + builtAt(8) + fileCount(4) + entryCount(4) + nameCount(4) + rootsLen(4) */
const HEADER_BYTES = 32
/** 每条 entry 的定长部分：nameId/fileIndex/line/endLine(u32×4) + column(u16) + kind(u8) + conditionId(u32) */
const ENTRY_BYTES = 4 + 4 + 4 + 4 + 2 + 1 + 4
/** 每个 file 的定长部分：mtime(f64) + size(u32) + hashLo(u32) + hashHi(u32) */
const FILE_FIXED_BYTES = 8 + 4 + 4 + 4

/** 编码快照为 Buffer。 */
export function encodeSnapshot(table: SymbolTable): Buffer {
  const columns = getSymbolTableColumns(table)
  if (!columns) {
    // 外部实现：先按公开契约物化（含 v4 元数据）成列式再编码
    const includes = new Map<string, readonly string[]>()
    for (const file of table.files) {
      const targets = table.includedFiles(file.path)
      if (targets.length > 0) includes.set(file.path, targets)
    }
    const files = table.files.map((file) => {
      const hash = table.contentHashOf(file.path)
      return hash ? { ...file, contentHashLo: hash.lo, contentHashHi: hash.hi } : file
    })
    return encodeSnapshot(
      createSymbolTable(table.roots, files, table.toArray(), table.builtAt, table.version, {
        includes,
      }),
    )
  }
  const rootsJson = Buffer.from(JSON.stringify(table.roots), 'utf8')
  const fileCount = table.files.length
  const entryCount = columns.nameIds.length
  const nameCount = columns.names.length
  const conditionCount = columns.conditions.length

  let size = HEADER_BYTES + rootsJson.length
  const filePathBytes: number[] = []
  for (const file of table.files) {
    const length = Buffer.byteLength(file.path, 'utf8')
    filePathBytes.push(length)
    size += 4 + length + FILE_FIXED_BYTES
  }
  const nameBytes: number[] = []
  for (const name of columns.names) {
    const length = Buffer.byteLength(name, 'utf8')
    nameBytes.push(length)
    size += 4 + length
  }
  const conditionBytes: number[] = []
  size += 4
  for (const condition of columns.conditions) {
    const length = Buffer.byteLength(condition, 'utf8')
    conditionBytes.push(length)
    size += 4 + length
  }
  size += entryCount * ENTRY_BYTES
  size += (nameCount + 1) * 4
  size += (fileCount + 1) * 4
  size += entryCount * 4
  size += (fileCount + 1) * 4
  size += columns.includeTargets.length * 4

  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  buffer.write(MAGIC, offset, 'latin1')
  offset += MAGIC_BYTES
  buffer.writeUInt32LE(table.version, offset)
  offset += 4
  buffer.writeDoubleLE(table.builtAt, offset)
  offset += 8
  buffer.writeUInt32LE(fileCount, offset)
  offset += 4
  buffer.writeUInt32LE(entryCount, offset)
  offset += 4
  buffer.writeUInt32LE(nameCount, offset)
  offset += 4
  buffer.writeUInt32LE(rootsJson.length, offset)
  offset += 4
  buffer.set(rootsJson, offset)
  offset += rootsJson.length

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const file = table.files[fileIndex]!
    const length = filePathBytes[fileIndex]!
    buffer.writeUInt32LE(length, offset)
    offset += 4
    buffer.write(file.path, offset, 'utf8')
    offset += length
    buffer.writeDoubleLE(file.mtimeMs, offset)
    offset += 8
    buffer.writeUInt32LE(Math.min(file.size, 0xffffffff), offset)
    offset += 4
    buffer.writeUInt32LE(file.contentHashLo ?? 0, offset)
    offset += 4
    buffer.writeUInt32LE(file.contentHashHi ?? 0, offset)
    offset += 4
  }
  for (let nameId = 0; nameId < nameCount; nameId++) {
    const length = nameBytes[nameId]!
    buffer.writeUInt32LE(length, offset)
    offset += 4
    buffer.write(columns.names[nameId]!, offset, 'utf8')
    offset += length
  }
  // 条件字符串表（0 号为 ''）
  buffer.writeUInt32LE(conditionCount, offset)
  offset += 4
  for (let conditionId = 0; conditionId < conditionCount; conditionId++) {
    const length = conditionBytes[conditionId]!
    buffer.writeUInt32LE(length, offset)
    offset += 4
    buffer.write(columns.conditions[conditionId]!, offset, 'utf8')
    offset += length
  }

  const writeU32 = (values: Uint32Array): void => {
    for (let index = 0; index < values.length; index++) {
      buffer.writeUInt32LE(values[index]!, offset)
      offset += 4
    }
  }
  writeU32(columns.nameIds)
  writeU32(columns.fileIndexes)
  writeU32(columns.lines)
  writeU32(columns.endLines)
  for (let index = 0; index < entryCount; index++) {
    buffer.writeUInt16LE(columns.columns[index]!, offset)
    offset += 2
  }
  for (let index = 0; index < entryCount; index++) {
    buffer.writeUInt8(columns.kinds[index]!, offset)
    offset += 1
  }
  writeU32(columns.conditionIds)
  writeU32(columns.nameOffsets)
  writeU32(columns.fileEntryOffsets)
  writeU32(columns.fileEntryIndexes)
  writeU32(columns.includeOffsets)
  writeU32(columns.includeTargets)

  return buffer
}

/** 解码快照；magic/版本/长度不合法时返回 undefined（不抛）。 */
export function decodeSnapshot(buffer: Buffer): SymbolTable | undefined {
  if (buffer.length < HEADER_BYTES) return undefined
  if (buffer.toString('latin1', 0, MAGIC_BYTES) !== MAGIC) return undefined
  const version = buffer.readUInt32LE(4)
  if (version !== SNAPSHOT_VERSION) return undefined
  const builtAt = buffer.readDoubleLE(8)
  const fileCount = buffer.readUInt32LE(16)
  const entryCount = buffer.readUInt32LE(20)
  const nameCount = buffer.readUInt32LE(24)
  const rootsLength = buffer.readUInt32LE(28)
  let offset = HEADER_BYTES

  if (offset + rootsLength > buffer.length) return undefined
  const rootsJson = buffer.toString('utf8', offset, offset + rootsLength)
  offset += rootsLength
  let roots: readonly string[]
  try {
    roots = JSON.parse(rootsJson) as string[]
  } catch {
    return undefined
  }

  const files: FileRecord[] = new Array(fileCount)
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    if (offset + 4 > buffer.length) return undefined
    const length = buffer.readUInt32LE(offset)
    offset += 4
    if (offset + length + FILE_FIXED_BYTES > buffer.length) return undefined
    const filePath = buffer.toString('utf8', offset, offset + length)
    offset += length
    const mtimeMs = buffer.readDoubleLE(offset)
    offset += 8
    const size = buffer.readUInt32LE(offset)
    offset += 4
    const contentHashLo = buffer.readUInt32LE(offset)
    offset += 4
    const contentHashHi = buffer.readUInt32LE(offset)
    offset += 4
    // 0/0 = 未记录：不 materialize 可选字段（与旧数据形状一致）
    files[fileIndex] =
      contentHashLo === 0 && contentHashHi === 0
        ? { path: filePath, mtimeMs, size }
        : { path: filePath, mtimeMs, size, contentHashLo, contentHashHi }
  }

  const names: string[] = new Array(nameCount)
  for (let nameId = 0; nameId < nameCount; nameId++) {
    if (offset + 4 > buffer.length) return undefined
    const length = buffer.readUInt32LE(offset)
    offset += 4
    if (offset + length > buffer.length) return undefined
    names[nameId] = buffer.toString('utf8', offset, offset + length)
    offset += length
  }

  if (offset + 4 > buffer.length) return undefined
  const conditionCount = buffer.readUInt32LE(offset)
  offset += 4
  const conditions: string[] = new Array(conditionCount)
  for (let conditionId = 0; conditionId < conditionCount; conditionId++) {
    if (offset + 4 > buffer.length) return undefined
    const length = buffer.readUInt32LE(offset)
    offset += 4
    if (offset + length > buffer.length) return undefined
    conditions[conditionId] = buffer.toString('utf8', offset, offset + length)
    offset += length
  }
  if (conditionCount === 0) return undefined // 0 号 '' 必须存在

  const readU32Array = (count: number): Uint32Array | undefined => {
    if (offset + count * 4 > buffer.length) return undefined
    const array = new Uint32Array(count)
    for (let index = 0; index < count; index++) {
      array[index] = buffer.readUInt32LE(offset)
      offset += 4
    }
    return array
  }

  const nameIds = readU32Array(entryCount)
  const fileIndexes = readU32Array(entryCount)
  const lines = readU32Array(entryCount)
  const endLines = readU32Array(entryCount)
  if (!nameIds || !fileIndexes || !lines || !endLines) return undefined

  if (offset + entryCount * 2 > buffer.length) return undefined
  const columnsArray = new Uint16Array(entryCount)
  for (let index = 0; index < entryCount; index++) {
    columnsArray[index] = buffer.readUInt16LE(offset)
    offset += 2
  }
  if (offset + entryCount > buffer.length) return undefined
  const kindsArray = new Uint8Array(entryCount)
  for (let index = 0; index < entryCount; index++) {
    kindsArray[index] = buffer.readUInt8(offset)
    offset += 1
  }
  const conditionIds = readU32Array(entryCount)
  if (!conditionIds) return undefined
  for (let index = 0; index < entryCount; index++) {
    if (conditionIds[index]! >= conditionCount) return undefined
  }

  const nameOffsets = readU32Array(nameCount + 1)
  const fileEntryOffsets = readU32Array(fileCount + 1)
  const fileEntryIndexes = readU32Array(entryCount)
  if (!nameOffsets || !fileEntryOffsets || !fileEntryIndexes) return undefined

  const includeOffsets = readU32Array(fileCount + 1)
  if (!includeOffsets) return undefined
  for (let index = 0; index < fileCount; index++) {
    if (includeOffsets[index]! > includeOffsets[index + 1]!) return undefined
  }
  const edgeCount = includeOffsets[fileCount]!
  const includeTargets = readU32Array(edgeCount)
  if (!includeTargets) return undefined
  for (let index = 0; index < edgeCount; index++) {
    if (includeTargets[index]! >= fileCount) return undefined
  }

  if (offset !== buffer.length) return undefined

  return symbolTableFromColumns({
    version,
    roots,
    builtAt,
    files,
    columns: {
      names,
      nameOffsets,
      nameIds,
      fileIndexes,
      lines,
      endLines,
      columns: columnsArray,
      kinds: kindsArray,
      conditions,
      conditionIds,
      fileEntryOffsets,
      fileEntryIndexes,
      contentHashLo: readHashColumn(files, 'contentHashLo'),
      contentHashHi: readHashColumn(files, 'contentHashHi'),
      includeOffsets,
      includeTargets,
    },
  })
}

/** 从 FileRecord 还原哈希列（解码时文件记录已带 hash 字段）。 */
function readHashColumn(files: readonly FileRecord[], key: 'contentHashLo' | 'contentHashHi'): Uint32Array {
  const column = new Uint32Array(files.length)
  for (let index = 0; index < files.length; index++) column[index] = files[index]![key] ?? 0
  return column
}

/** 读取快照文件；缺失或损坏返回 undefined。 */
export async function loadSnapshot(file: string): Promise<SymbolTable | undefined> {
  try {
    const buffer = await fsp.readFile(file)
    return decodeSnapshot(buffer)
  } catch {
    return undefined
  }
}

/** 原子写盘，返回写入字节数。 */
export async function saveSnapshot(file: string, table: SymbolTable): Promise<number> {
  const buffer = encodeSnapshot(table)
  const temporary = `${file}.tmp`
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(temporary, buffer)
    await fsp.rename(temporary, file)
  } catch (error) {
    await fsp.unlink(temporary).catch(() => undefined)
    throw error
  }
  return buffer.length
}
