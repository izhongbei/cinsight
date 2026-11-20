/**
 * VS Code 层小工具单测：匿名父类型（扫描器占位名 `<anonymous>`）应当视作「没有 parent」，
 * 悬停/搜索列表不能显示 `member of struct <anonymous>` / `enumerator of enum <anonymous>`。
 *
 * util.ts 顶层 `import * as vscode from 'vscode'`，node 单测没有真实宿主；在 require 之前
 * 用最小 CommonJS loader stub 提供 `l10n.t`（占位替换语义与 smoke 的 mock 一致）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'

import type { SymbolEntry, SymbolTable } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import { createSymbolTable } from '../src/core/symbol-table'

const fakeVscode = {
  l10n: {
    t: (message: string, ...args: unknown[]): string => {
      if (args.length === 0) return message
      return message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)] ?? ''))
    },
  },
}

interface Loader {
  _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown
}

const loader = Module as unknown as Loader
const originalLoad = loader._load
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode
  return originalLoad.call(Module, request, parent, isMain)
}

const { memberPhrase, parentKindOf } =
  require('../src/vscode/util') as typeof import('../src/vscode/util')

function entry(partial: Partial<SymbolEntry> & { name: string }): SymbolEntry {
  const line = partial.line ?? 0
  return {
    name: partial.name,
    kind: partial.kind ?? 'member',
    file: partial.file ?? 'inc/a.h',
    line,
    endLine: partial.endLine ?? line,
    column: partial.column ?? 0,
    ...(partial.parent !== undefined ? { parent: partial.parent } : {}),
  }
}

/** builtAt 单调递增：避免查询结果缓存跨用例串味。 */
let builtSeq = 0

function table(entries: readonly SymbolEntry[]): SymbolTable {
  const files = [...new Set(entries.map((item) => item.file))].map((path) => ({
    path,
    mtimeMs: 0,
    size: 0,
  }))
  return createSymbolTable(
    ['.'],
    files,
    entries,
    1_700_000_000_000 + ++builtSeq,
    SNAPSHOT_VERSION,
  )
}

test('memberPhrase: <anonymous> 父类型等同于没有 parent', () => {
  const bareEnumConstant = entry({ name: 'BARE', kind: 'enumConstant' })
  assert.equal(memberPhrase(bareEnumConstant), 'Enum Constant')
  assert.equal(
    memberPhrase({ ...bareEnumConstant, parent: '<anonymous>' }),
    'Enum Constant',
    'anonymous enum constant keeps the plain kind label',
  )

  const bareMember = entry({ name: 'raw', kind: 'member' })
  assert.equal(memberPhrase(bareMember), 'Member')
  assert.equal(
    memberPhrase({ ...bareMember, parent: '<anonymous>' }),
    'Member',
    'anonymous type member does not print "of struct <anonymous>"',
  )
  assert.equal(
    memberPhrase({ ...bareMember, parent: '<anonymous>' }, 'struct'),
    'Member',
    'a stale parent kind cannot reintroduce the anonymous parent',
  )

  // 具名父类型保持原有措辞。
  assert.equal(
    memberPhrase(entry({ name: 'len', kind: 'member', parent: 'sk_buff' }), 'struct'),
    'member of struct sk_buff',
  )
  assert.equal(
    memberPhrase(entry({ name: 'E_A', kind: 'enumConstant', parent: 'E' }), 'enum'),
    'enumerator of enum E',
  )
})

test('parentKindOf: <anonymous> 不解析出父类型，具名父类型不受影响', () => {
  const entries = [
    entry({ name: '<anonymous>', kind: 'struct', line: 0, column: 7 }),
    entry({ name: 'E', kind: 'enum', line: 2, column: 5 }),
  ]
  const snapshot = table(entries)

  // 即便表里恰好存在名为 `<anonymous>` 的符号，也不能当作真实父类型。
  assert.equal(
    parentKindOf(entry({ name: 'raw', kind: 'member', parent: '<anonymous>' }), snapshot),
    undefined,
  )
  assert.equal(
    parentKindOf(entry({ name: 'BARE', kind: 'enumConstant', parent: '<anonymous>' }), snapshot),
    undefined,
  )
  assert.equal(
    parentKindOf(entry({ name: 'E_A', kind: 'enumConstant', parent: 'E' }), snapshot),
    'enum',
  )
})
