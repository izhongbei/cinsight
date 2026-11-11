import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { matchesGlob, compileExclude } from '../src/core/exclude'
import { isIndexableFile, walkFiles } from '../src/core/walk'
import { DEFAULT_EXCLUDE } from '../src/shared/types'
import type { FileRecord, IndexProgress } from '../src/shared/types'

/** dist/test/../../test/fixtures -> <project>/test/fixtures（tsc 不拷贝夹具） */
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
}

type WalkOptions = Parameters<typeof walkFiles>[0]

function baseOptions(dir: string, extra: Partial<WalkOptions> = {}): WalkOptions {
  return {
    workspaceRoot: dir,
    roots: ['.'],
    exclude: [...DEFAULT_EXCLUDE],
    maxFileSizeKB: 4096,
    followSymlinks: false,
    ...extra,
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// ---------------------------------------------------------------- matchesGlob

test('walk-exclude: ** matches across directories', () => {
  assert.equal(matchesGlob('proj/build/a.c', '**/build/**'), true)
  assert.equal(matchesGlob('proj/src/a.c', '**/build/**'), false)
  assert.equal(matchesGlob('build/a.c', '**/build/**'), true, 'leading **/ may match zero dirs')
})

test('walk-exclude: **/ inside a pattern requires at least one directory', () => {
  assert.equal(matchesGlob('a/b/c.c', 'a/**/*.c'), true)
  assert.equal(matchesGlob('a/c.c', 'a/**/*.c'), false)
  assert.equal(matchesGlob('a/x/y/c.c', 'a/**/*.c'), true)
})

test('walk-exclude: tmp pattern and wildcard suffix', () => {
  assert.equal(matchesGlob('x/tmp/y.h', '**/tmp/**'), true)
  assert.equal(matchesGlob('x/tmpdir/y.h', '**/tmp/**'), false)
  assert.equal(matchesGlob('x/y.c', '**/*.c'), true)
  assert.equal(matchesGlob('y.c', '**/*.c'), true)
  assert.equal(matchesGlob('x/y.c', '**/*.h'), false)
})

test('walk-exclude: literal dir pattern matches any level', () => {
  assert.equal(matchesGlob('x/build/a.c', 'build'), true)
  assert.equal(matchesGlob('proj/build/a.c', 'build/'), true)
  assert.equal(matchesGlob('x/builder/a.c', 'build'), false)
  assert.equal(matchesGlob('proj/build/a.c', 'proj/build'), true)
})

test('walk-exclude: leading slash anchors at workspace root', () => {
  assert.equal(matchesGlob('build/a.c', '/build/**'), true)
  assert.equal(matchesGlob('proj/build/a.c', '/build/**'), false)
})

test('walk-exclude: compileExclude with empty patterns never matches', () => {
  const isExcluded = compileExclude([])
  assert.equal(isExcluded('any/path.c'), false)
  assert.equal(isExcluded('build/a.c'), false)
})

test('walk-exclude: compileExclude combines patterns', () => {
  const isExcluded = compileExclude(['**/build/**', '**/generated/*.c'])
  assert.equal(isExcluded('proj/build/a.c'), true)
  assert.equal(isExcluded('proj/generated/x.c'), true)
  assert.equal(isExcluded('proj/src/x.c'), false)
})

// ------------------------------------------------------------ isIndexableFile

test('walk-exclude: isIndexableFile only accepts exact lowercase extensions', () => {
  assert.equal(isIndexableFile('a.c'), true)
  assert.equal(isIndexableFile('a.C'), false)
  assert.equal(isIndexableFile('a.txt'), false)
  assert.equal(isIndexableFile('a.hpp'), true)
  assert.equal(isIndexableFile('dir/a.cpp'), true)
  assert.equal(isIndexableFile('dir/a.hh'), true)
  assert.equal(isIndexableFile('dir/a.inl'), true)
  assert.equal(isIndexableFile('dir/a.cc'), true)
  assert.equal(isIndexableFile('dir/noext'), false)
})

// ------------------------------------------------------------------- walkFiles

test('walk-exclude: walkFiles honours default excludes and sorts paths', async () => {
  const root = path.join(FIXTURES, 'walk')
  const files = await walkFiles(baseOptions(root))
  assert.deepEqual(files.map((f: FileRecord) => f.path), ['sub/a.c', 'sub/b.h'])
  for (const f of files) {
    assert.equal(typeof f.mtimeMs, 'number')
    assert.ok(f.size > 0)
  }
})

test('walk-exclude: walkFiles can start from a sub root', async () => {
  const root = path.join(FIXTURES, 'walk')
  const files = await walkFiles(baseOptions(root, { roots: ['sub'] }))
  assert.deepEqual(files.map((f: FileRecord) => f.path), ['sub/a.c', 'sub/b.h'])
})

test('walk-exclude: walkFiles respects custom exclude patterns', async () => {
  const root = path.join(FIXTURES, 'walk')
  // 自定义 exclude 完全替换默认值：只排掉 sub，build/tmp 仍会被索引
  const files = await walkFiles(baseOptions(root, { exclude: ['**/sub/**'] }))
  assert.deepEqual(files.map((f: FileRecord) => f.path), ['build/c.c', 'tmp/d.h'])
  const onlyBuild = await walkFiles(baseOptions(root, { exclude: ['**/sub/**', '**/tmp/**'] }))
  assert.deepEqual(onlyBuild.map((f: FileRecord) => f.path), ['build/c.c'])
})

test('walk-exclude: walkFiles skips files above maxFileSizeKB', async () => {
  const dir = tempDir('si-walk-size-')
  try {
    writeFiles(dir, {
      'small.c': 'int a;\n',
      'big.c': `int b;\n${'/* pad */\n'.repeat(300)}`,
    })
    const files = await walkFiles(baseOptions(dir, { maxFileSizeKB: 1 }))
    assert.deepEqual(files.map((f: FileRecord) => f.path), ['small.c'])
    const all = await walkFiles(baseOptions(dir, { maxFileSizeKB: 4096 }))
    assert.deepEqual(all.map((f: FileRecord) => f.path), ['big.c', 'small.c'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('walk-exclude: walkFiles skips symlinks unless followSymlinks', async () => {
  const dir = tempDir('si-walk-link-')
  try {
    writeFiles(dir, { 'real.c': 'int real(void);\n' })
    fs.symlinkSync(path.join(dir, 'real.c'), path.join(dir, 'link.c'))
    const noFollow = await walkFiles(baseOptions(dir, { followSymlinks: false }))
    assert.deepEqual(noFollow.map((f: FileRecord) => f.path), ['real.c'])
    const follow = await walkFiles(baseOptions(dir, { followSymlinks: true }))
    assert.deepEqual(follow.map((f: FileRecord) => f.path), ['link.c', 'real.c'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('walk-exclude: walkFiles reports progress every 500 files', async () => {
  const dir = tempDir('si-walk-progress-')
  try {
    for (let i = 0; i < 620; i++) {
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.c`), 'int x;\n')
    }
    const events: IndexProgress[] = []
    const files = await walkFiles(
      baseOptions(dir, {
        onProgress: (p: IndexProgress) => events.push(p),
      }),
    )
    assert.equal(files.length, 620)
    assert.ok(events.length >= 1, 'expected at least one progress event')
    assert.ok(
      events.every((e) => e.phase === 'walk'),
      'walk progress phase must be "walk"',
    )
    assert.ok(
      events.some((e) => e.done === 500),
      `expected a done=500 event, got ${JSON.stringify(events)}`,
    )
    assert.ok(events.some((e) => e.done === 620), 'final progress event expected')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('walk-exclude: walkFiles rejects with AbortError when pre-aborted', async () => {
  const root = path.join(FIXTURES, 'walk')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(walkFiles(baseOptions(root, { signal: controller.signal })), isAbortError)
})

test('walk-exclude: walkFiles rejects when aborted during walk', async () => {
  const root = path.join(FIXTURES, 'walk')
  const controller = new AbortController()
  await assert.rejects(
    walkFiles(
      baseOptions(root, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ),
    isAbortError,
  )
})
