import { readFile as readFileAsync, rename, unlink, writeFile as writeFileAsync } from 'node:fs/promises'
import type { FileRecord, NameIndexData, ReadFileFn } from '../shared/types'
import { NAME_INDEX_VERSION } from '../shared/types'
import { stripSources } from './scan'

/**
 * 引用加速索引（name index）：按文件记录该文件出现过的所有 C 标识符的 32 位哈希，
 * 去重并升序存放。查找引用时只需对每个文件的切片做二分查找，命中候选文件才读盘，
 * 把「全仓库读一遍」降为「只读包含该标识符的少数文件」。
 *
 * 正确性：32 位哈希碰撞只会多出候选文件，读取后仍按词边界精确匹配，因此不会漏报，
 * 也不会产生误报；注释/字符串中的标识符在收集时就被剥离（与 findReferences 一致）。
 *
 * 文件布局（小端）：
 *   magic "SINM" (4B) | version u32 | fileCount u32 | totalHashes u32
 *   fileCount × [pathLen u32, path utf8]
 *   (fileCount+1) × offset u32
 *   totalHashes × hash u32
 */

const MAGIC = 'SINM'
const MAGIC_OFFSET = 0
const HEADER_BYTES = 16
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g

/** FNV-1a 32 位哈希；同一标识符在任何进程中结果一致。 */
export function hashIdentifier(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 收集文本中出现过的标识符哈希（注释/字符串内容不参与），去重后升序返回。 */
export function collectIdentifierHashes(text: string): Uint32Array {
  const stripped = stripSources(text)
  const seen = new Set<number>()
  IDENTIFIER_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IDENTIFIER_RE.exec(stripped)) !== null) {
    seen.add(hashIdentifier(match[0]))
  }
  const hashes = new Uint32Array(seen.size)
  let index = 0
  for (const hash of seen) hashes[index++] = hash
  hashes.sort()
  return hashes
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/** 在 [start, end) 的升序切片中查找 target。 */
function sliceContains(hashes: Uint32Array, start: number, end: number, target: number): boolean {
  let low = start
  let high = end
  while (low < high) {
    const mid = (low + high) >>> 1
    const value = hashes[mid]!
    if (value < target) low = mid + 1
    else high = mid
  }
  return low < end && hashes[low] === target
}

/** 返回可能包含该标识符的文件下标（按快照 files 顺序）。 */
export function candidatesForName(data: NameIndexData, name: string): number[] {
  const target = hashIdentifier(name)
  const result: number[] = []
  const fileCount = data.filePaths.length
  for (let file = 0; file < fileCount; file++) {
    const start = data.offsets[file]!
    const end = data.offsets[file + 1]!
    if (start === end) continue
    if (sliceContains(data.hashes, start, end, target)) result.push(file)
  }
  return result
}

/** 从不可变索引中取出每个文件切片（按路径），供增量构建复用。 */
export function fileSlicesByPath(data: NameIndexData): Map<string, Uint32Array> {
  const map = new Map<string, Uint32Array>()
  for (let file = 0; file < data.filePaths.length; file++) {
    const start = data.offsets[file]!
    const end = data.offsets[file + 1]!
    map.set(data.filePaths[file]!, data.hashes.subarray(start, end))
  }
  return map
}

function assemble(filePaths: readonly string[], slices: readonly Uint32Array[]): NameIndexData {
  const offsets = new Uint32Array(filePaths.length + 1)
  let total = 0
  for (let file = 0; file < filePaths.length; file++) {
    offsets[file] = total
    total += slices[file]?.length ?? 0
  }
  offsets[filePaths.length] = total
  const hashes = new Uint32Array(total)
  let cursor = 0
  for (const slice of slices) {
    if (slice) {
      hashes.set(slice, cursor)
      cursor += slice.length
    }
  }
  return { filePaths: [...filePaths], offsets, hashes }
}

/** 用新算出的哈希替换/追加某个文件的切片；未知路径直接追加到末尾。 */
export function upsertFileIndex(
  data: NameIndexData,
  filePath: string,
  hashes: Uint32Array,
): NameIndexData {
  const index = data.filePaths.indexOf(filePath)
  if (index < 0) {
    const paths = [...data.filePaths, filePath]
    const slices = fileSlicesByPath(data)
    const list = paths.map((path, position) =>
      position === paths.length - 1 ? hashes : (slices.get(path) ?? new Uint32Array(0)),
    )
    return assemble(paths, list)
  }
  const slices = fileSlicesByPath(data)
  slices.set(filePath, hashes)
  const list = data.filePaths.map((path) => slices.get(path) ?? new Uint32Array(0))
  return assemble(data.filePaths, list)
}

/** 删除某个文件的切片（文件被删除时使用）。 */
export function removeFileIndex(data: NameIndexData, filePath: string): NameIndexData {
  const index = data.filePaths.indexOf(filePath)
  if (index < 0) return data
  const paths = data.filePaths.filter((path) => path !== filePath)
  const slices = fileSlicesByPath(data)
  const list = paths.map((path) => slices.get(path) ?? new Uint32Array(0))
  return assemble(paths, list)
}

export interface BuildNameIndexOptions {
  readonly files: readonly FileRecord[]
  readonly previous?: NameIndexData
  /** 需要重新读取解析的文件路径；其余文件复用 previous 的切片 */
  readonly changedPaths: ReadonlySet<string>
  readonly readFile: ReadFileFn
  readonly signal?: AbortSignal
  readonly onProgress?: (done: number, total: number) => void
  readonly concurrency?: number
}

/** 构建倒排索引：变更文件重新读盘计算，未变更文件复用旧切片。 */
export async function buildNameIndex(options: BuildNameIndexOptions): Promise<NameIndexData> {
  const { files, previous, changedPaths, readFile, signal, onProgress } = options
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, files.length || 1))
  throwIfAborted(signal)

  const previousSlices = previous ? fileSlicesByPath(previous) : undefined
  const slices: (Uint32Array | undefined)[] = new Array(files.length)
  let done = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal)
      const index = cursor++
      if (index >= files.length) return
      const file = files[index]!
      const reusable = previousSlices?.get(file.path)
      if (reusable !== undefined && !changedPaths.has(file.path)) {
        slices[index] = reusable
      } else {
        let text: string | undefined
        try {
          text = await readFile(file.path)
        } catch {
          text = undefined
        }
        throwIfAborted(signal)
        slices[index] = text === undefined ? new Uint32Array(0) : collectIdentifierHashes(text)
      }
      done += 1
      onProgress?.(done, files.length)
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) workers.push(worker())
  await Promise.all(workers)
  throwIfAborted(signal)

  return assemble(
    files.map((file) => file.path),
    slices.map((slice) => slice ?? new Uint32Array(0)),
  )
}

/** 编码为二进制（小端）。 */
export function encodeNameIndex(data: NameIndexData): Buffer {
  const pathBytes = data.filePaths.map((path) => Buffer.byteLength(path, 'utf8'))
  let size = HEADER_BYTES
  for (const length of pathBytes) size += 4 + length
  size += (data.filePaths.length + 1) * 4
  size += data.hashes.length * 4

  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  buffer.write(MAGIC, offset, 'latin1')
  offset += 4
  buffer.writeUInt32LE(NAME_INDEX_VERSION, offset)
  offset += 4
  buffer.writeUInt32LE(data.filePaths.length, offset)
  offset += 4
  buffer.writeUInt32LE(data.hashes.length, offset)
  offset += 4

  for (let file = 0; file < data.filePaths.length; file++) {
    const path = data.filePaths[file]!
    const length = pathBytes[file]!
    buffer.writeUInt32LE(length, offset)
    offset += 4
    buffer.write(path, offset, 'utf8')
    offset += length
  }
  for (let file = 0; file <= data.filePaths.length; file++) {
    buffer.writeUInt32LE(data.offsets[file]!, offset)
    offset += 4
  }
  for (let index = 0; index < data.hashes.length; index++) {
    buffer.writeUInt32LE(data.hashes[index]!, offset)
    offset += 4
  }
  return buffer
}

/** 解码；magic/版本/长度不合法时返回 undefined（不抛异常）。 */
export function decodeNameIndex(buffer: Buffer): NameIndexData | undefined {
  if (buffer.length < HEADER_BYTES) return undefined
  if (buffer.toString('latin1', MAGIC_OFFSET, MAGIC_OFFSET + 4) !== MAGIC) return undefined
  const version = buffer.readUInt32LE(4)
  if (version !== NAME_INDEX_VERSION) return undefined
  const fileCount = buffer.readUInt32LE(8)
  const totalHashes = buffer.readUInt32LE(12)
  if (fileCount > 10_000_000 || totalHashes > 400_000_000) return undefined

  let offset = HEADER_BYTES
  const filePaths: string[] = new Array(fileCount)
  for (let file = 0; file < fileCount; file++) {
    if (offset + 4 > buffer.length) return undefined
    const length = buffer.readUInt32LE(offset)
    offset += 4
    if (offset + length > buffer.length) return undefined
    filePaths[file] = buffer.toString('utf8', offset, offset + length)
    offset += length
  }

  const offsetsBytes = (fileCount + 1) * 4
  if (offset + offsetsBytes + totalHashes * 4 !== buffer.length) return undefined
  const offsets = new Uint32Array(fileCount + 1)
  for (let file = 0; file <= fileCount; file++) {
    offsets[file] = buffer.readUInt32LE(offset)
    offset += 4
  }
  if (offsets[fileCount] !== totalHashes) return undefined
  for (let file = 0; file < fileCount; file++) {
    if (offsets[file]! > offsets[file + 1]!) return undefined
  }
  const hashes = new Uint32Array(totalHashes)
  for (let index = 0; index < totalHashes; index++) {
    hashes[index] = buffer.readUInt32LE(offset)
    offset += 4
  }
  return { filePaths, offsets, hashes }
}

/** 读取索引文件；缺失或损坏返回 undefined。 */
export async function loadNameIndex(file: string): Promise<NameIndexData | undefined> {
  try {
    const buffer = await readFileAsync(file)
    return decodeNameIndex(buffer)
  } catch {
    return undefined
  }
}

/** 原子写盘，返回写入字节数。 */
export async function saveNameIndex(file: string, data: NameIndexData): Promise<number> {
  const buffer = encodeNameIndex(data)
  const temporary = `${file}.tmp`
  try {
    await writeFileAsync(temporary, buffer)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return buffer.length
}
