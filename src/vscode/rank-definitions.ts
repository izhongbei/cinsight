/**
 * 定义候选排序（vscode 层入口）。
 *
 * 实现在 `src/core/rank-definitions.ts`（纯函数，core 与 vscode 共用）；这里只做
 * re-export，保留既有 import 路径与导出名不变。
 */
export { rankDefinitions, type RankContext } from '../core/rank-definitions'
