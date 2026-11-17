/**
 * 64 位内容哈希：两个独立的 32 位 FNV-1a（不同 offset/prime），无 BigInt 开销。
 * 只用于「内容相同」的等价判断（多副本折叠）与增量复用，不用于安全场景。
 */
export interface ContentHash {
  readonly lo: number
  readonly hi: number
}

const FNV32_PRIME = 16777619
const MIX_PRIME = 2654435761

/** 对 UTF-16 码元逐字符混合，返回两个 32 位无符号分量。 */
export function hashContent64(text: string): ContentHash {
  let lo = 0x811c9dc5
  let hi = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    lo = Math.imul(lo ^ code, FNV32_PRIME) >>> 0
    hi = Math.imul(hi ^ code, MIX_PRIME) >>> 0
  }
  return { lo, hi }
}
