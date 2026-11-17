# AGENTS.md

本仓库摘自线上服务，包含两样东西，用于算法调整和回测：

- TD Sequential 9/13 图表标记引擎；
- 建在它上面的 AI 趋势面板，包括规则层和文案层。

背景、接口字段、面板的生成流程和已知口径都在 `README.md` 里，动手前先读一遍。

## 命令

- `npm run typecheck`：类型检查，覆盖 src、tests、scripts。
- `npm test`：全部单测，不联网。
- `npm run fetch-klines -- SYMBOL 5m,15m,1h,4h,1d [bars]`：从 Binance 公开接口拉 K 线到 `data/`，每个周期一个文件。`data/` 已被 gitignore。
- `npm run chart -- SYMBOL INTERVAL [limit]`：输出 9/13 标记接口现在的返回。
  - 加 `--file data/X.json --end <openTime> --limit 500`：输出接口在某根 K 线收盘时的返回。
- `npm run backtest -- --file data/X.json [--window 500] [--horizons 1,3,6,12,24] [--json]`：回测 9 和 13。
  - 不带 `--window`：全量历史一次算完。
  - `--window 500`：按线上方式逐根重放。
- `npm run insight -- SYMBOL [--at ISO|ms] [--lang zhCN|en|both] [--json]`：输出 AI 趋势面板，包括卡片、结论、各周期、复盘、关注。
  - 加 `--at`：读 `data/` 里五个周期的文件，输出过去某一时刻的面板。
  - 环境变量里有 `INSIGHT_LLM_BASE_URL` 和 `INSIGHT_LLM_API_KEY` 时，会额外调用 LLM 输出结论。
- `npm run view -- SYMBOL INTERVAL [--at ISO|ms] [--limit 500] [--compare baseline] [--out PATH]`：生成看图 HTML（K 线、标记、线、AI 趋势面板），并打印路径。
  - `--compare <ref>`：与某个 git 版本逐项对比。`baseline` tag 是线上现行算法。
  - 给用户看结果时，生成这个页面并告诉对方路径；能打开浏览器的话直接打开。

## 代码边界

**可以改**
- 引擎：`src/services/manager/demark/engine.ts`、`chart.ts`、`fixed-decimal.ts`。
- 面板规则层：`summary.ts`、`regime.ts`、`insight-facts.ts`、`strength.ts`、`protection.ts`。
- 面板文案层：`src/services/sync/signal-insight/` 下的 `card-phase.ts`、`wording.ts`、`insight-template.ts`、`insight-text.ts`、`lean.ts`、`llm-client.ts`（含系统提示词）。
- `binance-klines.ts`、`demark-service.ts`：取数和缓存。只有确实和数据准确性有关时才改。

**不能改**
- 导出函数的签名：`evaluateSequential`、`projectChart`、`buildChart`、`fetchClosedKlines`、`scaleRows`、`analyzeWindow`、`assembleSnapshot`、`templateSections`、`generateInsight`。
- `demark-types.ts`、`insight-types.ts` 里的响应结构。可以新增可选字段，但要在 PR 里说明。
- 文件路径和导出名。改动会按原路径搬回线上服务。
- 占位文件：`src/shared/utils/logger.ts`、`src/services/sync/signal-push/signal-push-task.ts`、`src/services/sync/signal-push/symbols.ts`。它们只为让代码在这里能跑，不会搬回去。

**其它要求**
- 算法和规则代码保持纯函数，不做 I/O、不读时钟。`src/` 不引入新的运行时依赖。
- 面板文案的硬约束由 `tests/unit/signal-insight/` 守着：不出现多空、看涨看跌这类词，不出现指标名，数字原样照抄。改文案时不能放松这些约束。

## 改动规则

- 先有能复现问题的测试，再改算法或规则。用例里写清以下几项：
  - symbol、周期、K 线时间（面板问题写时刻）；
  - 期望值、实际值；
  - 期望值的依据。
- 原有测试的期望值只有在确认原值错了时才改，并在 commit message 里说明原因。
  - `parity.test.ts`、`summary.test.ts`、`regime.test.ts` 的期望值来自 Python 参考实现，改它们要格外说明。
  - `__snapshots__` 只能在确认新输出正确后才更新。
- 每次改动行为后，用同一批 `data/` 文件跑改动前、改动后的输出，存到 `reports/<日期>-<主题>.json`，并在 `reports/README.md` 里附一段结论。
  - 改了 9/13：跑 `backtest --json`。
  - 改了面板：在几个有代表性的时刻跑 `insight --at ... --json`。
  - 再用 `view --compare baseline` 生成对比页，在 `reports/README.md` 里写明打开哪几页能看到这次改动的效果。
- 不要移动或删除 `baseline` tag。
- 提交前 `npm run typecheck` 和 `npm test` 必须全部通过。
- 不提交 `.env`、API key 和 `data/`。
- 代码、注释、commit message 用英文，commit 遵循 conventional commits（`fix(engine): ...`、`fix(insight): ...`）。
