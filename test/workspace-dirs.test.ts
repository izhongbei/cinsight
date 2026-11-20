/**
 * workspace-dirs 纯 fs 测试：真实 mkdtemp 工作区 + 真实符号链接，不使用任何 vscode mock。
 *
 * 符号链接在部分平台/权限下不可创建；此时整个用例 `t.skip`，而不是失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  listCandidateDirectories,
  mapOutsidePathToWorkspace,
} from '../src/core/workspace-dirs'

interface Fixture {
  readonly base: string
  readonly workspace: string
  readonly outside: string
}

/**
 * base/
 *   workspace/modules/sub/        （真实目录，会递归）
 *   workspace/.hidden/            （跳过）
 *   workspace/node_modules/pkg/   （跳过）
 *   workspace/out/                （跳过）
 *   workspace/dist -> outside/local（符号链接，按名字跳过）
 *   workspace/local -> outside/local
 *   workspace/public -> outside/public
 *   workspace/private -> outside/private
 *   workspace/modules/nested -> outside/nested
 *   outside/{local,public/private,nested}/...
 */
function createFixture(): Fixture | undefined {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'si-workspace-dirs-')))
  const workspace = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  const dirs = [
    path.join(workspace, 'modules', 'sub'),
    path.join(workspace, '.hidden'),
    path.join(workspace, 'node_modules', 'pkg'),
    path.join(workspace, 'out'),
    path.join(outside, 'local'),
    path.join(outside, 'public', 'nested'),
    path.join(outside, 'private', 'sub'),
    path.join(outside, 'nested', 'deep'),
  ]
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'modules', 'sub', 'a.c'), 'int a;\n')
  fs.writeFileSync(path.join(outside, 'private', 'sub', 'p.c'), 'int p;\n')

  const links: Array<[string, string]> = [
    ['local', path.join(outside, 'local')],
    ['public', path.join(outside, 'public')],
    ['private', path.join(outside, 'private')],
    ['dist', path.join(outside, 'local')],
    [path.join('modules', 'nested'), path.join(outside, 'nested')],
  ]
  try {
    for (const [name, target] of links) {
      fs.symlinkSync(target, path.join(workspace, name), 'dir')
    }
  } catch {
    fs.rmSync(base, { recursive: true, force: true })
    return undefined
  }
  return { base, workspace, outside }
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.base, { recursive: true, force: true })
}

test('workspace-dirs: listCandidateDirectories includes symlinked dirs without recursing', async (t) => {
  const fixture = createFixture()
  if (!fixture) {
    t.skip('symbolic links are not permitted on this platform')
    return
  }
  try {
    const candidates = await listCandidateDirectories(fixture.workspace)
    assert.deepEqual(candidates, [
      { path: 'local', symlink: true },
      { path: 'modules', symlink: false },
      { path: 'modules/nested', symlink: true },
      { path: 'modules/sub', symlink: false },
      { path: 'private', symlink: true },
      { path: 'public', symlink: true },
    ])
    // 符号链接只作为候选，不递归展开（否则会逃出工作区）。
    assert.ok(!candidates.some((c) => c.path.startsWith('local/')))
    assert.ok(!candidates.some((c) => c.path.startsWith('public/')))
    assert.ok(!candidates.some((c) => c.path.startsWith('private/')))
    assert.ok(!candidates.some((c) => c.path.startsWith('modules/nested/')))
    // 隐藏目录 / 跳过名 / 跳过名的符号链接都不出现。
    for (const skipped of ['.hidden', '.git', 'node_modules', 'out', 'dist']) {
      assert.ok(!candidates.some((c) => c.path === skipped), `${skipped} must be skipped`)
    }
  } finally {
    cleanup(fixture)
  }
})

test('workspace-dirs: listCandidateDirectories honours maxDepth', async (t) => {
  const fixture = createFixture()
  if (!fixture) {
    t.skip('symbolic links are not permitted on this platform')
    return
  }
  try {
    const candidates = await listCandidateDirectories(fixture.workspace, 1)
    assert.deepEqual(candidates, [
      { path: 'local', symlink: true },
      { path: 'modules', symlink: false },
      { path: 'private', symlink: true },
      { path: 'public', symlink: true },
    ])
  } finally {
    cleanup(fixture)
  }
})

test('workspace-dirs: mapOutsidePathToWorkspace keeps inside paths unchanged', async (t) => {
  const fixture = createFixture()
  if (!fixture) {
    t.skip('symbolic links are not permitted on this platform')
    return
  }
  try {
    const { workspace } = fixture
    assert.equal(await mapOutsidePathToWorkspace(workspace, workspace), '')
    assert.equal(await mapOutsidePathToWorkspace(workspace, path.join(workspace, 'modules')), 'modules')
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(workspace, 'modules', 'sub')),
      'modules/sub',
    )
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(workspace, 'modules', 'sub', '..')),
      'modules',
    )
    // 符号链接路径本身仍按工作区内路径返回。
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(workspace, 'private', 'x')),
      'private/x',
    )
  } finally {
    cleanup(fixture)
  }
})

test('workspace-dirs: mapOutsidePathToWorkspace maps symlink targets back', async (t) => {
  const fixture = createFixture()
  if (!fixture) {
    t.skip('symbolic links are not permitted on this platform')
    return
  }
  try {
    const { base, workspace, outside } = fixture
    // 顶层符号链接目标
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(outside, 'private', 'sub')),
      'private/sub',
    )
    assert.equal(await mapOutsidePathToWorkspace(workspace, path.join(outside, 'private')), 'private')
    // 目标尚不存在时用最近的已存在祖先映射
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(outside, 'private', 'sub', 'new')),
      'private/sub/new',
    )
    // 下一层符号链接（modules/nested -> outside/nested）
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(outside, 'nested', 'deep')),
      'modules/nested/deep',
    )
    // 工作区外的非符号链接目标 / 仅前缀相同的兄弟目录都不能映射。
    assert.equal(await mapOutsidePathToWorkspace(workspace, path.join(base, 'elsewhere')), undefined)
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, `${workspace}-other`),
      undefined,
    )
    assert.equal(
      await mapOutsidePathToWorkspace(workspace, path.join(outside, 'private-other')),
      undefined,
    )
  } finally {
    cleanup(fixture)
  }
})
