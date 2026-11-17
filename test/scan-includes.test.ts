import test from 'node:test'
import assert from 'node:assert/strict'
import { scanIncludes } from '../src/core/scan'

test('scanIncludes: quoted, angled and indented includes', () => {
  const text = [
    '#include "local.h"',
    '  #include <sys/types.h>',
    '/* #include "commented.h" */',
    '// #include "line-comment.h"',
    '#ifdef FOO',
    '#include "cond/foo.h"',
    '#endif',
  ].join('\n')
  assert.deepEqual(scanIncludes(text), [
    { path: 'local.h', line: 0, angled: false },
    { path: 'sys/types.h', line: 1, angled: true },
    { path: 'cond/foo.h', line: 5, angled: false },
  ])
})

test('scanIncludes: ignores string literals, allows leading/trailing comments and spaced directive', () => {
  const text = [
    'const char *s = "#include <string-fake.h>";',
    '/* prefix */ #include "after-comment.h"',
    '#include "trailing.h" /* note */',
    '#  include <spaced.h>',
  ].join('\n')
  assert.deepEqual(scanIncludes(text), [
    { path: 'after-comment.h', line: 1, angled: false },
    { path: 'trailing.h', line: 2, angled: false },
    { path: 'spaced.h', line: 3, angled: true },
  ])
})
