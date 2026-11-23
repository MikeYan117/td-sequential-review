# 底部判断 skill：使用与优化流程

`SKILL.md` 是给 AI agent 用的 skill，用来回答「BTC 现在是不是见底了」这类问题。它分五步给出五行中文结论：

1. 15 分钟方向；
2. 多周期共振；
3. New Trend；
4. 技术指标确认；
5. 链上卖盘枯竭。

这份文档说明三件事：怎么把 skill 跑起来、怎么用固定的历史时刻测试它、改完之后怎么交付。

## 你的工作范围

- **可以改**：只改 `skills/market-bottom-assessment/` 这个目录。可以改 `SKILL.md`，也可以在这个目录下新建 `eval/` 存放测试集。
- **不要改**：`src/`、`scripts/`、`tests/` 和仓库根目录的文档。那部分是九转算法本身，另有人在优化。如果你发现九转数据本身有错，在 PR 里写清楚现象，不要自己改算法。
- **目标**：让 skill 在一组固定的历史时刻上给出正确、稳定、格式一致的五行结论；每次修改都能用同一组时刻对比前后差异。

## 开始前的准备

1. Clone 仓库并安装依赖，确认测试通过。需要联网（npm 和 fapi.binance.com），在沙箱里运行时先放开网络。

   ```bash
   git clone https://github.com/gaawai-l/td-sequential-review.git
   cd td-sequential-review
   npm install
   npm test
   ```

2. 拉 BTC 五个周期的历史 K 线。这里拉 20000 根，5m 周期大约能覆盖 70 天，测试时刻要落在这个范围内。`data/` 已被 gitignore。

   ```bash
   npm run fetch-klines -- BTCUSDC 5m,15m,1h,4h,1d 20000
   ```

3. 在你的 agent 里接好链上数据 MCP 和指标面板。先用实时问题试一次，确认两者都能返回数据。
4. 让 agent 使用这个 skill，有两种方式，选一种即可：
   - 在对话里直接让它读 `skills/market-bottom-assessment/SKILL.md`，并严格按里面的流程回答。
   - 把这个目录复制到你的 agent 的 skills 目录，例如 Claude Code 的 `~/.claude/skills/`。不要复制进本仓库的 `.agents/` 或 `.claude/` 再提交，否则另一位开发者的 agent 也会自动加载它。

## 九转数据从哪来

skill 第 1 到 3 步需要的九转读数（`td-sequential-v2`），全部可以用本仓库在任意历史时刻离线复现：

```bash
# T 时刻每个周期的 9/13 状态、Setup 步数、Risk Level、TDST、New Trend
npm run insight -- BTCUSDC --at 2026-11-20T08:00:00Z --json > /tmp/insight.json

# 同一时刻的 K 线图，可以肉眼核对标记
npm run view -- BTCUSDC 15m --at 2026-11-20T08:00:00Z
```

`--at T` 表示只用 T 时刻之前已收盘的 K 线，和 skill「只用已收盘 K 线」的要求一致。比如 T 是 08:00，15m 的最后一根就是 07:45 开盘、08:00 收盘的那根。

JSON 里每个周期在 `snapshot.timeframes[i]` 下，`interval` 取 5m、15m、1h、4h、1d。skill 用到的读数对应如下：

| skill 里的概念 | JSON 字段 |
|---|---|
| 当前 Setup 方向与步数（`第 N/9 步`） | `summary.setupRun`（`side`、`count`、`active`、`completed`），`summary.setupStep` |
| Countdown 进度 | `summary.phase`、`summary.countdownStep` |
| 最近一次确认的 9 或 13 | `summary.lastSignal`（`kind`、`side`、`at`），`state.setup9At`、`state.qualified13At` |
| 合格 13 的 Risk Level | `summary.risk.riskLevel`、`summary.risk.risk13At` |
| 13 之后已过多少根 K 线 | `summary.barsSinceQualified13` |
| TDST | `summary.risk.tdst` |
| New Trend | `newTrend`（`present`、`trend`、`step`、`confirmed`），和 SKILL.md 里 `select15mDirection` 的输入完全一致 |
| 窗口截止时刻与最新收盘价 | `summary.asOf`（收盘时间）、`summary.close` |

**时间换算的坑**
- JSON 里的 `at`、`setup9At`、`qualified13At` 都是那根 K 线的**开盘**时间，单位是毫秒、UTC。
- skill 要求从信号的**收盘**时刻算起，所以确认时刻是 `at + 周期长度`。
- `state.qualified13SecondsAgo` 是从开盘时间算到 `asOf` 的，比 skill 说的距今多一根 K 线。
- skill 对外显示用新加坡时间（UTC+8）。

**例子**：`--at 2026-11-20T08:00:00Z` 时，15m 的读数是：
- `lastSignal` 为 buy 13，开盘 07:15、收盘 07:30，到 08:00 已过 30 分钟；
- `risk.riskLevel` 为 60698.9；
- `newTrend` 为下跌、第 3/9 步、未确认。

按 `select15mDirection` 的规则：New Trend 还没确认，而 13 不到 60 分钟，所以 15 分钟方向取「向上，依据是刚出现的 13」，同时提示有一个反向 New Trend 正在形成。

## 工作流程

### 1. 建测试集

挑 10 到 20 个历史时刻，类型要覆盖全：

- 事后看确实是阶段底的时刻；
- 下跌途中的反弹：应判为「短期反弹候选」，不能说见底；
- 13 出现后很快被 Risk Level 判失效；
- 刚出 13、还在 60 分钟观察窗口内；
- 没有任何 9 或 13 的平静时段；
- 数据缺失或延迟：应输出「未取得」或「无法判断」。

每个时刻建一个目录 `eval/cases/<编号>-<简述>/`，里面放这几样：

- `case.md`：截止时刻 T（UTC），为什么选它，你认为正确的结论（底部规模和状态），以及依据。
- `insight.json`：`npm run insight -- BTCUSDC --at T --json` 的输出。
- `onchain.json`：链上 MCP 在 T 时刻的读数。**只存数值和时间，不要存接口名、地址、token。**
  - 如果 MCP 支持按历史时刻查询，就按 T 查。
  - 如果不支持，就只能在当下做实时用例：当场把读数存下来，这个用例从此就固定了。
- `indicators.json`：指标面板在 T 时刻的读数，存法同上。

### 2. 跑一遍，存答案

对每个用例，给 agent 同样的话：

```text
分析截止时间是 <T，UTC>。只能使用这个时刻之前已收盘的数据。
九转读数用 eval/cases/<用例>/insight.json，链上读数用 onchain.json，指标读数用 indicators.json，不要再去取实时数据。
按 skills/market-bottom-assessment/SKILL.md 回答：BTC 现在见底了吗？
```

把回答存成 `eval/cases/<用例>/answer-<SKILL.md 当时的 commit 短 sha>.md`。

### 3. 逐条检查

在 `eval/README.md` 里用一张表记录每个用例检查表的结果：

- 是否严格五行，顺序和开头标签对；
- 第一行是否以「趋势衰减」或「趋势反转」开头，「待确认」是否用得对；
- 15 分钟方向和 `select15mDirection` 的规则是否一致；
- 置信度起点、升降次数是否符合 SKILL.md，最多只调一次；
- 信号年龄是否从收盘时刻算起，是否用新加坡时间；
- 有没有用到未收盘的 K 线，或 T 之后的数据；
- 底部规模标签是否和高周期方向一致，有没有把反弹说成见底；
- 链上一行的格式：百分比、等级、距今时长、百分位，有没有混入日期或钟点；
- 有没有出现接口名、主机名、URL；
- 数据缺失时是否如实写「未取得」，而不是硬给结论。

### 4. 改 skill，再跑一遍

- 每次只改一类问题。改完对**全部**用例重跑，用新的 commit sha 存答案，和上一版逐个对比。
- 在 `eval/README.md` 记三件事：这次改了什么、哪些用例变好、哪些变差。
- 变差的用例不能放着不管：要么修好，要么在记录里写明为什么接受。
- 同一个用例多跑几次，结论不一致的，说明规则写得不够确定，要在 SKILL.md 里写得更具体。

### 5. 交付

1. 把仓库 fork 到你自己的 GitHub 账号，推一个分支上去，向 `gaawai-l/td-sequential-review` 的 `main` 提 Pull Request。PR 里只应包含 `skills/market-bottom-assessment/` 下的改动。
2. PR 描述写清楚：
   - SKILL.md 改了哪些规则，每条的理由；
   - 测试集有多少个用例、覆盖哪几类；
   - 最终版本的检查结果汇总，以及还没解决的问题。

## 注意

- 不要提交 `data/`、`.env`，也不要提交任何 MCP 地址、token 或 key。这是公开仓库。
- 不要动 `baseline` tag，不要改 `src/`。
- SKILL.md 本身要求对外输出不出现数据接口的名称和地址。测试集文件也照此办理。
