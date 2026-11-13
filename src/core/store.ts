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
 * 二进制快照读写（v3，列式）。
 *
 * 布局（小端）：
 * ```
 * magic "SIDX"(4B) | version u32 | builtAt f64 | fileCount u32 | entryCount u32
 * nameCount u32 | rootsLen u32 | rootsJson
 * files:  [pathLen u32, path utf8, mtimeMs f64, size u32] × fileCount
 * names:  [len u32, utf8] × nameCount
 * nameIds u32[entryCount] | fileIndexes u32[entryCount]
 * lines u32[entryCount] | endLines u32[entryCount]
 * columns u16[entryCount] | kinds u8[entryCount]
 * nameOffsets u32[nameCount+1] | fileEntryOffsets u32[fileCount+1]
 * fileEntryIndexes u32[entryCount]
 * ```
 * 读取时直接映射成 TypedArray（不做对象化），149 万符号约 50MB 堆、加载 100ms 级；
 * 旧版本快照由版本号不匹配自然失效并触发重建。
 */

const MAGIC = 'SIDX'
const MAGIC_BYTES = 4
/** magic(4) + version(4) + builtAt(8) + fileCount(4) + entryCount(4) + nameCount(4) + rootsLen(4) */
const HEADER_BYTES = 32

/** 编码快照为 Buffer。 */
export function encodeSnapshot(table: SymbolTable): Buffer {
  const columns = getSymbolTableColumns(table)
  if (!columns) {
    // 外部实现：先转成列式再编码
    return encodeSnapshot(
      createSymbolTable(table.roots, table.files, table.toArray(), table.builtAt, table.version),
    )
  }
  const rootsJson = Buffer.from(JSON.stringify(table.roots), 'utf8')
  const fileCount = table.files.length
  const entryCount = columns.nameIds.length
  const nameCount = columns.names.length

  let size = HEADER_BYTES + rootsJson.length
  const filePathBytes: number[] = []
  for (const file of table.files) {
    const length = Buffer.byteLength(file.path, 'utf8')
    filePathBytes.push(length)
    size += 4 + length + 8 + 4
  }
  const nameBytes: number[] = []
  for (const name of columns.names) {
    const length = Buffer.byteLength(name, 'utf8')
    nameBytes.push(length)
    size += 4 + length
  }
  size += entryCount * (4 + 4 + 4 + 4 + 2 + 1)
  size += (nameCount + 1) * 4
  size += (fileCount + 1) * 4
  size += entryCount * 4

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
  }
  for (let nameId = 0; nameId < nameCount; nameId++) {
    const length = nameBytes[nameId]!
    buffer.writeUInt32LE(length, offset)
    offset += 4
    buffer.write(columns.names[nameId]!, offset, 'utf8')
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
  writeU32(columns.nameOffsets)
  writeU32(columns.fileEntryOffsets)
  writeU32(columns.fileEntryIndexes)

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
    if (offset + length + 12 > buffer.length) return undefined
    const path = buffer.toString('utf8', offset, offset + length)
    offset += length
    const mtimeMs = buffer.readDoubleLE(offset)
    offset += 8
    const size = buffer.readUInt32LE(offset)
    offset += 4
    files[fileIndex] = { path, mtimeMs, size }
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

  const nameOffsets = readU32Array(nameCount + 1)
  const fileEntryOffsets = readU32Array(fileCount + 1)
  const fileEntryIndexes = readU32Array(entryCount)
  if (!nameOffsets || !fileEntryOffsets || !fileEntryIndexes) return undefined
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
      fileEntryOffsets,
      fileEntryIndexes,
    },
  })
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
