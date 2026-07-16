# AI.Team 质量改进与整改计划

> 面向仓库维护者的可执行改进文档
>
> 审计对象：[Wahsekim/AI.Team](https://github.com/Wahsekim/AI.Team)
>
> 固定快照：[`9aba9fca34da3cf64f5a957305ac8e34b081cae3`](https://github.com/Wahsekim/AI.Team/commit/9aba9fca34da3cf64f5a957305ac8e34b081cae3)
>
> 审计日期：2026-07-13

## 1. 文档目的

本文件不是重复做一次仓库点评，而是把已经验证的问题转化为可以实施的整改工作：

- 每个问题给出源码证据和影响；
- 能确定解决办法的，给出推荐方案和验收标准；
- 需要维护者决定产品方向或法律事项的，明确列为待确认问题；
- 最后给出可独立合并的 PR 顺序、测试矩阵和发布门槛。

本次检查覆盖完整仓库树、GitHub 项目元数据、Claude Code 官方文档、Shell/JavaScript 语法检查、validator 正常与残缺部署测试，以及 `run-n-rounds.js` 的 mock runtime 故障注入测试。没有执行会消耗 Claude 额度的完整 `start team`，因此真实付费端到端运行仍需仓库自己补充验证。

## 2. 当前定位与目标定位

### 当前实际定位

AI.Team 目前是一个 **Claude Code 软件交付治理模板**，而不是通用多 Agent runtime：

- 62 个文件、5,530 行；
- 4,712 行为 Markdown；
- 可执行部分只有一个 320 行 Dynamic Workflow 和 5 个共 496 行的 Shell 脚本；
- 主要能力是 PM、角色提示词、QA 门禁、ADR、生命周期账本、失败类型和人工治理流程。

### 推荐目标定位

README 应明确将产品定义为：

> A testable, installable governance kit for Claude Code software-delivery agents.

不建议继续暗示它是：

- 通用的多模型 Agent framework；
- 已经完全无人值守的执行系统；
- 可由 `validator exit 0` 证明健康的生产级系统。

### 建议发布目标

在完成本文件全部 P0 项前，不发布稳定版本。完成后先发布 `v0.1.0-alpha`，至少经过一个公开示例项目的 10 次代表性 dispatch，再决定是否进入 beta。

## 3. 优先级定义

| 优先级 | 含义 |
|---|---|
| P0 / 严重 | 阻止合法复用、正确安装或可靠执行，或可能造成安全事故；发布 alpha 前必须完成 |
| P1 / 高 | 不一定立即造成错误，但会显著影响安全、成本、维护或使用体验；进入机密、持续或无人值守使用前应完成 |
| P2 / 中 | 不阻塞受控实验，但会影响长期演进、可信度、生态或合规成熟度 |

“问题类型”描述问题所属的主要质量维度；一个问题可能跨多个维度。文中的重要性是对当前固定快照的风险判断，不是实施工作量。

### 问题分类与重要性总览

| ID | 问题 | 问题类型 | 重要性 |
|---|---|---|---|
| P0-01 | 缺少许可证与来源授权 | 法律合规 / 开源治理 | 严重（P0） |
| P0-02 | 部署布局、cwd 与产品路径冲突 | 架构 / 集成 / 可用性 | 严重（P0） |
| P0-03 | Claude frontmatter 与版本声明不准确 | 运行时兼容性 / 成本控制 | 严重（P0） |
| P0-04 | Engine 输入未严格校验 | 正确性 / 输入校验 | 严重（P0） |
| P0-05 | Engine 状态模型会产生假绿 | 正确性 / 可靠性 | 严重（P0） |
| P0-06 | Guardian 异常会丢失恢复证据 | 容错 / 可恢复性 | 严重（P0） |
| P0-07 | 故障注入测试与 CI 缺失 | 测试质量 / 工程治理 | 严重（P0） |
| P0-08 | Validator 可接受残缺部署 | 质量门禁 / 正确性 | 严重（P0） |
| P0-09 | Secret、权限与 prompt injection 边界不足 | 安全 / 隐私 | 严重（P0） |
| P1-01 | Watchdog 存在路径与 PID 风险 | 安全 / 可靠性 | 高（P1） |
| P1-02 | Bootstrap/Upgrade 不确定且不幂等 | 安装体验 / 可维护性 | 高（P1） |
| P1-03 | 账本 reconciliation 非原子、不可幂等 | 数据一致性 / 可恢复性 | 高（P1） |
| P1-04 | 默认成本高且缺乏真实经济指标 | 成本 / 实用性 | 高（P1） |
| P1-05 | 文档与 prompt 上下文负担过重 | 可维护性 / 性能 | 高（P1） |
| P1-06 | 发布与供应链流程缺失 | 供应链安全 / 项目治理 | 高（P1） |
| P2-01 | 缺少公开示例与可复现实验 | 开发者体验 / 可验证性 | 中（P2） |
| P2-02 | “运行三个月”缺少可核验证据 | 可信度 / 产品声明 | 中（P2） |
| P2-03 | 跨 runtime 目标不明确 | 产品战略 / 架构 | 中（P2） |
| P2-04 | 数据保留、脱敏与删除政策缺失 | 隐私 / 合规 | 中（P2） |

## 4. P0：发布前必须解决

### P0-01 明确许可证、版权和来源授权

**问题类型：** 法律合规 / 开源治理 · **重要性：** 严重（P0）

**证据**

- [仓库元数据](https://api.github.com/repos/Wahsekim/AI.Team)中的 `license` 为 `null`；
- 仓库没有 `LICENSE`、SPDX 标识或明确版权授权；
- 项目称内容来自一个未公开的 source workspace，但无法核验原始权利人和第三方内容来源：[source-map](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/docs/source-map.md#L1-L14)。

**影响**

无许可证时，公开可见或可 fork 不等于获得自由使用、修改和分发许可。GitHub 的[官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)明确指出默认版权保留。

**推荐整改**

1. 维护者先确认 source workspace 的全部内容均有权再许可。
2. 选择并添加明确许可证；若希望最大化复用，通常可在 MIT 或 Apache-2.0 中选择。
3. 添加：
   - `LICENSE`；
   - `NOTICE` 或 `THIRD_PARTY_NOTICES.md`；
   - README License 小节；
   - 每个来自外部 persona/template 的来源与许可记录。
4. 若无法确认某些源文件的权利，先移除或重写，不要仅靠 provenance 说明继续分发。

**验收标准**

- GitHub 能自动识别许可证；
- README 明确允许的使用方式；
- 所有非原创内容都有来源和许可；
- `source-map.md` 能回答“谁拥有原始内容、以什么许可被移入本仓库”。

**待维护者确认**

1. 计划采用 MIT、Apache-2.0，还是其他许可证？
2. 原 source workspace 的版权归属是什么？是否包含第三方 agent persona？
3. 是否愿意公开一个经过脱敏的原始实例作为 provenance 和效果证据？

---

### P0-02 统一部署布局、cwd 和产品仓库访问方式

**问题类型：** 架构 / 集成 / 可用性 · **重要性：** 严重（P0）

**证据**

README 要求 `AI.Team/` 与产品仓库并列，并在 `AI.Team/` 内启动 Claude Code：[README](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/README.md#L35-L61)。但 wrapper 又引用 `AI.Team/agents/...` 和 `AI.Team/profiles/...`：[role-wrapper.template.md](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/agents/role-wrapper.template.md#L18-L37)。

Claude Code subagent 从主会话 cwd 启动，[官方文档](https://code.claude.com/docs/en/sub-agents)确认这一点。因此从 `AI.Team/` 启动时，上述路径会变成不存在的 `AI.Team/AI.Team/...`。产品又是 sibling repo，README 没有要求 `--add-dir`。

**推荐整改：短期兼容方案**

1. 继续从 `AI.Team/` 启动，但将 wrapper 内团队文件路径改成仓库根相对路径：

   ```text
   agents/<role>.md
   profiles/project.md
   profiles/stack.md
   agents/templates.md
   ```

2. bootstrap 将产品路径规范化为绝对路径，并写入 `profiles/project.md`。
3. README 给出唯一、可复制的启动命令：

   ```bash
   claude --add-dir /absolute/path/to/MyProduct
   ```

4. 所有 brief 明确传入 `team_root` 和 `product_repo_path`，不依赖目录名恰好叫 `AI.Team`。
5. 新增 `scripts/check-runtime-layout.sh`：检查 cwd、团队根、产品根、wrapper discovery 和写权限。

**推荐整改：长期方案**

把治理层安装到产品仓库内部，例如 `.ai-team/`，而 `.claude/agents/` 保持在产品仓库根。这样 Claude 的 cwd、Git、worktree、权限和 subagent discovery 都围绕同一个真实项目根工作。另一种长期选择是将本项目封装为 Claude Code plugin。

**验收标准**

- README 的全新安装步骤可以从空目录逐字执行；
- builder subagent 能读取团队角色文件，也能读取和修改产品仓库文件；
- 项目目录名改变后仍可工作；
- 产品仓库路径包含空格时仍可工作；
- `claude /doctor` 能发现所有 active wrappers；
- CI 至少用两个目录布局运行 smoke test。

**待维护者确认**

未来的唯一受支持布局是“side-by-side”、产品内 `.ai-team/`，还是 Claude plugin？不要长期同时维护三个一等布局。

---

### P0-03 修正 Claude frontmatter 和兼容性声明

**问题类型：** 运行时兼容性 / 成本控制 · **重要性：** 严重（P0）

**证据**

wrapper 使用未在官方字段列表中的：

```yaml
reasoning_effort: high
token_budget: ...
```

源码：[role-wrapper.template.md](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/agents/role-wrapper.template.md#L1-L37)。Claude Code 当前支持的是 `effort`、`maxTurns` 等字段：[官方字段表](https://code.claude.com/docs/en/sub-agents)。Dynamic Workflows 又要求 Claude Code 2.1.154+，而 README 只写“2.1.x”：[官方 Workflow 文档](https://code.claude.com/docs/en/workflows)。

**影响**

- 角色 reasoning 档位可能未生效；
- 所谓每 agent token cap 不是硬限制；
- 用户容易误以为成本保护已经由 runtime 执行；
- 低于最低版本的 2.1.x 会在 workflow 路径失败。

**推荐整改**

1. `reasoning_effort` 改为 `effort`。
2. 从 frontmatter 删除 `token_budget`。
3. 使用 `maxTurns` 限制失控回合数；token estimate 继续作为 brief 中的软目标，但必须明确标注 advisory。
4. 真正的硬预算只在 runtime 明确支持的层面实现，例如 workflow budget 或 Agent SDK 的 USD budget。
5. README 明确：
   - 最低 Claude Code 版本；
   - 哪些功能需要付费计划/API；
   - Dynamic Workflows 的开启方式；
   - 哪些 frontmatter 字段是硬控制，哪些只是提示词约定。
6. 新增 `scripts/check-claude-compat.sh`，解析 `claude --version` 并检查最低版本。
7. 在 `docs/harness-assumptions.md` 增加真实兼容矩阵，而不只写“2.1.x”。

**验收标准**

- `claude /doctor` 不报告未知字段；
- 一个 probe agent 能证明不同 `effort` 和 `maxTurns` 设置被识别；
- README 不再使用“hard cap”描述普通 wrapper 的提示词 token budget；
- 低版本会在 bootstrap 前得到明确失败，而不是运行中失败。

---

### P0-04 为 `run-n-rounds` 增加严格输入验证

**问题类型：** 正确性 / 输入校验 · **重要性：** 严重（P0）

**证据**

当前只执行 `const rounds = A.rounds || 0`，没有正整数校验：[源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/workflows/run-n-rounds.js#L46-L76)。故障注入实测：

- `rounds=2.5` 会 dispatch 3 次；
- `rounds=-1` 不 dispatch，却返回 `count-complete`、`allPassed=true`、`remainingRounds=-1`。

**推荐整改**

在任何 `phase()` 或 `agent()` 调用前验证并规范化完整 args：

```js
function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
```

至少验证：

- `rounds`：正安全整数，并设置合理上限；
- `nextLifecycleNumber`：正安全整数；
- `budgetCeilingTokens`：正有限数，不允许 `0`、负数、`NaN`、`Infinity`；
- `date`：严格 `YYYY-MM-DD` 且为真实日期；
- `plan`：非空数组；
- 每个 plan item：对象、非空 `ticket`、`agentType`、`brief`；
- verification 配置必须显式，不允许依赖字段缺失的 truthy/falsy 语义；
- 限制 ticket、agentType 和日志字段长度并拒绝换行控制字符。

建议把 args schema 独立写入 `docs/engine.schema.json` 或同等机器可读文件，并让文档、测试、runtime 共用一份定义。

**验收标准**

- fractional、negative、zero、NaN、Infinity、超大 rounds 全部在 0 次 dispatch 前失败；
- malformed plan 不调用任何 agent；
- 错误对象包含稳定的 error code；
- 输入 fuzz 测试不能突破最大 dispatch 次数；
- 日志字段不能注入新的 Markdown 标题或路径。

---

### P0-05 重构 Engine 状态模型，消除假绿

**问题类型：** 正确性 / 可靠性 · **重要性：** 严重（P0）

**证据**

当前多个状态共用 `null` 或布尔值，导致：

- worker 抛错后没有 result、没有 fix queue，却可能已经改过文件；
- code-shipping worker 的 `terminalStop` 在 verifier 前 break，并硬编码 `needsFixRetest:false`：[源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/workflows/run-n-rounds.js#L160-L185)；
- verifier missing 和 non-code verification not applicable 都使用 `verifierPass=null`；
- `passedCount` 通过 `verifierPass !== false` 计算，把 missing verifier 算作通过：[汇总源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/workflows/run-n-rounds.js#L293-L303)。

**推荐状态模型**

不要再用一个 nullable boolean 表示多个含义。每次 iteration 在 worker 启动前就创建记录：

```js
{
  workerStatus: 'not_started' | 'running' | 'succeeded' | 'error' | 'terminal_stop',
  verificationStatus:
    'required' |
    'not_applicable' |
    'passed' |
    'failed' |
    'missing' |
    'error' |
    'blocked_by_worker_error',
  sideEffects: 'none_reported' | 'known' | 'unknown',
  needsRecovery: boolean,
  error: { code, message } | null
}
```

**具体规则**

1. worker 启动前先 push `running` result；异常也必须关闭该 result。
2. worker 抛错一律设置 `sideEffects:'unknown'`。
3. code-shipping worker 抛错必须进入 recovery/verification queue，不能标记 DOA。
4. `terminalStop` 只控制“是否继续下一 iteration”，不能跳过当前 iteration 的安全收尾：
   - 如果可能改过代码，先 verifier 或进入 recovery queue；
   - 然后停止后续迭代。
5. verification 默认应为 required；只有显式的 `verificationMode:'none'` 加非空原因，才能标记 not applicable。
6. 删除含义模糊的 `passedCount`，改为：
   - `workerSucceededCount`；
   - `verificationRequiredCount`；
   - `verificationPassedCount`；
   - `recoveryRequiredCount`。
7. `allPassed` 必须同时满足：
   - 没有 worker error；
   - 没有 unknown side effects；
   - 所有 required verification 均为 passed；
   - recovery queue 为空；
   - guardian 未返回 unavailable/halt-and-investigate。

**验收标准**

- 不存在 code-shipping worker 未通过 verifier 但 `allPassed=true` 的路径；
- worker 在修改文件后抛错时，返回结构明确要求人工恢复和重新验证；
- terminalStop 的代码任务仍被验证；
- 每个 iteration 不论成功、异常或取消都有 lifecycle record；
- 状态字段没有一个值承担两个业务含义。

---

### P0-06 Guardian 失败时仍必须返回恢复包

**问题类型：** 容错 / 可恢复性 · **重要性：** 严重（P0）

**证据**

Guardian 调用没有 `try/catch`：[源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/workflows/run-n-rounds.js#L268-L274)。实测 guardian unavailable 会让整个 workflow reject，已完成 workers 的 results、fix queue 和 paste-ready 日志都无法返回。

**推荐整改**

1. 在 Guardian 调用前先完成 results、recovery queue 和基础 reconciliation block。
2. Guardian 使用 fail-closed fallback：

   ```js
   let guardian = {
     status: 'unavailable',
     verdict: 'main-session-action-required',
     findings: ['guardian execution failed'],
   }
   ```

3. 捕获并返回 `guardianError`，但不要丢弃前序执行证据。
4. `nextInvocationBlocked=true`，直到 main session 处理 Guardian 缺失。
5. 日志中明确区分 guardian verdict 与 guardian unavailable。

**验收标准**

- Guardian 抛错、超时、返回 null、schema invalid 时，workflow 都返回结构化恢复包；
- 已完成 iteration 数、token、文件和 recovery queue 不丢失；
- Guardian 不可用时绝不能 `allPassed=true`；
- 下一轮运行被明确阻断。

---

### P0-07 将故障注入测试真正加入仓库和 CI

**问题类型：** 测试质量 / 工程治理 · **重要性：** 严重（P0）

**证据**

仓库没有测试目录、测试 fixture、package manifest 或 CI。文档虽然要求在信任 engine 前进行 injected-failure chaos tests，但未提供任何实现：[engine.md](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/docs/engine.md#L158-L165)。

**推荐整改**

新增一个不调用真实模型的 Workflow test harness。它读取真实 `run-n-rounds.js`，将 workflow body 包装到 `AsyncFunction`，注入 mock：

- `agent()`；
- `budget`；
- `phase()`；
- `log()`；
- `args`。

建议目录：

```text
tests/
  workflow-harness.mjs
  run-n-rounds.test.mjs
  fixtures/
    complete-deployment/
    incomplete-deployment/
    fresh-kit/
```

最低测试矩阵：

| 场景 | 期望 |
|---|---|
| `rounds=1/3` 正常路径 | 精确 dispatch N 次 |
| fractional/negative/zero rounds | 0 次 dispatch，明确输入错误 |
| plan 为空或 item 缺字段 | 0 次 dispatch |
| worker 正常、非代码任务 | verification not applicable，不进入 fix queue |
| worker 正常、代码任务 | verifier 必须运行 |
| worker 抛错 | side effects unknown，进入 recovery |
| code worker terminalStop | 当前 iteration 仍验证或进入 recovery |
| verifier false | `allPassed=false` |
| verifier missing/throw | `allPassed=false`，进入 recovery |
| verifier pass 但 commands 为空 | fail-closed |
| verifier pass 但 exit code 非零 | fail-closed |
| budget 初始已接近阈值 | 不产生错误的 DOA 假设 |
| 单 iteration overshoot | 明确 overshoot 状态和阻断 |
| Guardian throw/null/schema error | 返回恢复包，阻断下一轮 |
| plan shorter than N | needsGrooming 正确 |
| 重复 reconciliation | 不生成重复 lifecycle 编号 |

CI 至少运行：

- Node 测试；
- `bash -n`；
- ShellCheck；
- validator fixture tests；
- secret scan；
- Markdown/link check；
- Ubuntu，关键 Shell 再加 macOS job。

**验收标准**

- 上述测试全部进入仓库且在 PR 必须通过；
- main 分支启用 required status checks；
- 每个已知 false-green case 都有回归测试；
- 不调用 Claude API即可验证 Engine 的确定性逻辑。

---

### P0-08 将 Validator 从 grep 检查器升级为部署完整性门禁

**问题类型：** 质量门禁 / 正确性 · **重要性：** 严重（P0）

**证据**

validator 只通过 `charter.md` 是否存在判断 deployed mode：[源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/scripts/validate-team.sh#L33-L47)。残缺部署即使缺 profiles、verify discipline、memory、pm-decisions 和 wrappers，仍能 exit 0。缺失的 `memory/pm.md` 甚至会被 staleness 检查跳过后报告 PASS：[源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/scripts/validate-team.sh#L274-L300)。

**推荐整改**

1. 增加显式模式：

   ```bash
   validate-team.sh --mode kit .
   validate-team.sh --mode deployment .
   ```

2. deployment mode 建立 mandatory artifact matrix：
   - `charter.md`；
   - `profiles/project.md`；
   - `profiles/stack.md`；
   - `agents/roster.md`；
   - `agents/_shared/verify-discipline.md`；
   - UI 项目需要 `browser-access.md`；
   - `agents/lifecycle.md`；
   - `agents/lessons.md`；
   - `memory/pm.md`；
   - `pm-decisions.md`；
   - `decisions/README.md`；
   - 每个 active role 的 wrapper；
   - enabled workflow 需要的角色和 evidence surface。
3. 缺失 mandatory artifact 必须 FAIL，不得从 staleness 或 placeholder 检查中静默跳过。
4. 输出中区分：
   - `KIT-VALID`；
   - `DEPLOYMENT-READY`；
   - `DEPLOYMENT-INCOMPLETE`。
5. 可选增加 `--json`，方便 CI 和后续 installer 解析。
6. 将完整性规则做成可测试数据表，而不是继续增长一串条件分支。

**验收标准**

- 上一轮构造的残缺部署必须 exit 1；
- 从完整 fixture 每次删除一个 mandatory artifact，测试都必须失败；
- fresh kit 在 `--mode kit` 可通过，在 `--mode deployment` 必须失败；
- 不得出现“文件不存在但报告它是 fresh”的矛盾输出；
- README 不再将所有 exit 0 统称为 healthy。

---

### P0-09 修复 secret、权限和不可信输入边界

**问题类型：** 安全 / 隐私 · **重要性：** 严重（P0）

**证据**

- browser 模板要求填写 `SMOKE_CREDENTIAL`：[模板](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/agents/_shared/browser-access.template.md#L53-L57)，但 `.gitignore` 只忽略 `.DS_Store`；
- 推荐权限只禁止 `git commit` 和 `git push`：[设置片段](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/docs/harness-assumptions.md#L52-L87)；
- tracker、旧 handoff、worker notes 会被 verbatim 加入后续 prompt；
- Guardian prompt 直接拼入 worker notes 和 ticket 文本：[源码](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/.claude/workflows/run-n-rounds.js#L245-L273)。

**推荐整改**

1. 将 `SMOKE_CREDENTIAL` 改为 `SMOKE_CREDENTIAL_REF`；真实值只来自环境变量、Keychain 或 secret manager。
2. `.gitignore` 至少覆盖：
   - `.env*`，但保留 `.env.example`；
   - `*.local.md`；
   - 本地 credentials 文件；
   - screenshots、watchdog logs、hang logs；
   - 临时 lifecycle/reconciliation 文件。
3. 增加 `SECURITY.md`，描述安全报告方式、支持版本和 secret 泄漏响应。
4. role wrapper 使用官方 `tools`、`disallowedTools`、`permissionMode` 做最小权限；只读角色不得拥有 Write/Edit。
5. 注意 Bash 本身仍能写文件，因此高风险或机密项目应运行在 disposable container/VM、只读挂载或 worktree isolation 中，不能只靠提示词。
6. 将外部 ticket、repo 文档和 worker 输出标记为不可信数据：
   - 加结构化边界；
   - 限制长度；
   - 禁止将其中的指令当成系统指令；
   - 不再无选择地 verbatim 传递。
7. Guardian 只接收受控结构化字段；原始 notes 放入清晰的数据容器，不得与 Guardian 指令同层拼接。
8. 安全/隐私 profile 必须在第一次扫描产品代码前完成，不允许默认 `unknown` 后继续处理机密仓库。

**验收标准**

- 仓库和 fixture 的 secret scan 通过；
- smoke 密钥不会出现在 Git diff、prompt 日志或截图路径中；
- 一个包含“ignore previous instructions”的恶意 issue/worker note 不能改变 Guardian schema 结果；
- read-only agent 无法通过 Write/Edit 修改文件；
- 机密项目文档明确要求隔离运行环境，而非声称 prompt 就是安全边界。

## 5. P1：可靠性、安全和使用体验

### P1-01 加固或重新设计 Watchdog

**问题类型：** 安全 / 可靠性 · **重要性：** 高（P1）

**已复现问题**

`session_id` 未校验即拼入文件路径：[heartbeat.sh](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/scripts/watchdog/heartbeat.sh#L15-L31)。输入 `../../pwned` 可以在 heartbeat 目录之外创建文件。Stop 脚本还会读取 PID 后直接 TERM/KILL，没有验证 PID 归属。

**推荐整改**

- session ID 只允许 `[A-Za-z0-9._-]{1,128}`；拒绝 `/`、`..`、换行和控制字符；
- `umask 077`；
- 创建文件前验证规范化路径仍位于 heartbeat 根目录；
- PID 必须是纯数字，并验证对应 command/session；
- JSONL 使用真正的 JSON encoder，不用字符串插值；
- AppleScript 参数安全传递，不把 session ID 拼入代码字符串；
- 增加 stale PID、PID reuse、路径穿越、引号/换行和恢复后继续监控测试；
- 优先采用 project-local hook 配置，避免复制可执行脚本到全局 `~/.claude/scripts`；若必须全局安装，应提供版本、校验和和 uninstall。

**验收标准**

- 路径穿越测试无法在根目录外创建、移动或删除文件；
- stop 不能杀死非本 watchdog 进程；
- 恢复 heartbeat 后 watchdog 仍继续监控；
- Linux 和 macOS 行为都有测试。

---

### P1-02 提供幂等 Bootstrap/Upgrade 工具

**问题类型：** 安装体验 / 可维护性 · **重要性：** 高（P1）

当前空项目 bootstrap 有约 16 个主要步骤：[文档](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/docs/bootstrap-empty-project.md#L17-L106)，但完全依赖 PM 自己复制模板和填占位符。

**推荐能力**

```text
ai-team init --product /path --mode existing --config team.yaml --dry-run
ai-team validate --mode deployment
ai-team upgrade --from 0.1 --to 0.2
```

工具应：

- 使用机器可读 `team.yaml` 或 JSON Schema；
- 只询问真正需要 owner 决定的字段；
- 生成 wrappers、profiles、charter 和 shared discipline；
- 提供机器可读的 `lean`、`standard`、`autonomous` preset，并为全部 workflow ID 产生确定状态；
- 默认使用 `lean`（PM + 1 builder + QA），不自动启用动态 Engine、Watchdog 或并行 worker；
- 只有 runtime 能力检测通过且用户显式选择时，才启用 `autonomous`；能力不足时输出可执行的降级方案；
- 不写入任何真实 secret；
- 支持 `--dry-run`；
- 重复执行不覆盖人工内容；
- 记录 `template_version`；
- 在完成后自动运行 layout、Claude compatibility 和 deployment validation。

**验收标准**

- 空项目和现有项目 fixture 都能一条命令初始化；
- 第二次执行无非预期 diff；
- 中途失败可以安全重试；
- 三个 preset 对全部 workflow 都有确定状态，preset 切换产生稳定、可审查的 diff；
- 默认安装不启动后台 Watchdog，也不会在用户不知情时扩大并发或自治权限；
- 旧实例可以通过显式 migration 升级。

---

### P1-03 为批次和账本增加 run ID、幂等性和原子 reconciliation

**问题类型：** 数据一致性 / 可恢复性 · **重要性：** 高（P1）

当前 Engine 返回后仍要求 PM 手工粘贴 lifecycle/messages、重建 pm-decisions、同步 tracker：[PM engine contract](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/agents/pm.md#L185-L218)。`nextLifecycleNumber` 又由外部传入，没有锁或幂等键。

**推荐整改**

- 每次 workflow 生成唯一 `runId`；
- 每个 iteration 使用 `runId + iteration` 作为幂等键；
- Engine 产出机器可读 reconciliation JSON；
- 新增 `scripts/reconcile-run`：
  - 检查 run 是否已应用；
  - 原子写临时文件后 rename；
  - 防止重复编号和重复 tracker transition；
  - 失败时能够回滚或重新应用；
- Markdown 账本作为 JSON 状态的可读投影，而不是唯一事务存储。

**验收标准**

- 同一 run 重复 reconcile 不会产生重复条目；
- 崩溃后重试不会跳号或覆盖其他 run；
- 两个会话竞争同一 lifecycle number 时，其中一个明确失败；
- reconciliation 有自动测试。

---

### P1-04 降低默认成本并记录真实经济指标

**问题类型：** 成本 / 实用性 · **重要性：** 高（P1）

当前默认单 worker soft/hard cap 为 200k/250k，代码任务通常是 builder + QA，guardian 又建议使用最强模型：[预算表](https://github.com/Wahsekim/AI.Team/blob/9aba9fca34da3cf64f5a957305ac8e34b081cae3/charter.template.md#L93-L119)。当前 wrapper token cap 又没有 runtime 硬保证。

**推荐整改**

- 默认只启用 PM + 1 builder + QA；其他角色按真实触发器启用；
- 大幅降低初始 tier seed，以 5–10 个代表性任务重新校准；
- 每次 close 记录：
  - input tokens；
  - output tokens；
  - cache write/read；
  - 估算 USD；
  - wall time；
  - retry 次数；
  - 通过 verifier 前的缺陷数量；
- 增加每 session、每 ticket、每日/每月 USD ceiling；
- 比较基线：单 Agent + 常规 CI 与 AI.Team 的成本、缺陷逃逸率和交付时间；
- README 给出真实小/中/大任务成本样例，而不是只有 token 上限。

**验收标准**

- 用户能在运行前看到预计最大费用；
- 超过 USD/token ceiling 时 runtime 可机械停止；
- 默认配置不会一次启用所有高成本角色；
- 发布说明包含公开 benchmark 方法和结果。

---

### P1-05 减少文档和 prompt 上下文负担

**问题类型：** 可维护性 / 性能 · **重要性：** 高（P1）

当前 PM 单轮有 18 个步骤，要读取或局部读取十余类文件；32 个 workflow 大多是协议文本而不是可执行流程。这会增加冷启动成本，也提高模型漏执行某条规则的概率。

**推荐整改**

- 保留一个短小的 `CLAUDE.md` 路由页；
- 将角色流程改成按需加载的 skills/reference，而不是每次都加入上下文；
- 只让 active workflow 出现在运行时索引；
- 将单一来源值放进机器可读配置，Markdown 自动生成引用；
- 合并重复的“不可做”条款；
- 对每个角色建立 context budget，并在 CI 测量 prompt 字节/token 变化；
- 每条规则标记为：runtime-enforced、hook-enforced、test-enforced 或 advisory，避免把提示词规则称为机械控制。

**验收标准**

- PM 和 builder 的最小启动上下文有明确上限；
- 同一规范不再出现在多个 authority surface；
- 维护者能列出所有真正 runtime-enforced 的规则；
- 规则删除/移动不会破坏 wrapper 链接。

---

### P1-06 建立发布和供应链流程

**问题类型：** 供应链安全 / 项目治理 · **重要性：** 高（P1）

当前仓库只有一个未签名 initial-import commit，无 tag、release、CI、保护分支或兼容矩阵。

**推荐整改**

- 采用 SemVer 和 `CHANGELOG.md`；
- main 开启 branch protection 和 required checks；
- 增加 `CODEOWNERS`、`CONTRIBUTING.md`、issue/PR templates；
- 发布 signed tag、release notes 和源码校验和；
- README 安装命令必须 pin release/tag，不鼓励直接执行 mutable main 中的全局 hook；
- 增加支持版本表和 deprecation policy；
- 可选添加 OpenSSF Scorecard、CodeQL、secret scanning 和 release provenance。

**验收标准**

- 用户可安装固定版本；
- 每个 release 能追溯通过的测试和 Claude compatibility；
- 破坏性模板变化有 migration notes；
- main 不能绕过 CI 直接合并。

## 6. P2：长期演进建议

### P2-01 提供公开示例部署和可复现实验

**问题类型：** 开发者体验 / 可验证性 · **重要性：** 中（P2）

**推荐整改**

新增至少一个极小的 demo product，展示：

- bootstrap；
- 一个代码 ticket；
- builder → verifier；
- 一次 verifier failure 和 recovery；
- 一个 owner decision；
- lifecycle/reconciliation 输出；
- 成本和耗时。

用录制的 fixture/mocks 保证 CI 可重复，不依赖真实 API。另提供一份可选的真实 Claude 运行报告。

**验收标准**

- 从 clean clone 到完成第一个 builder → QA ticket 的人工操作时间不超过 15 分钟，不计模型响应时间；
- 示例在 CI 中可重复初始化、验证和清理；
- 示例不要求 Jira、Linear、生产账号或其他外部付费凭据；
- 至少包含一次 verifier failure → fix/retest 的可核验记录。

### P2-02 将“真实项目运行三个月”变成可核验证据

**问题类型：** 可信度 / 产品声明 · **重要性：** 中（P2）

**问题与推荐整改**

当前该说法只能视为作者自述。建议发布脱敏数据：

- dispatch 数量；
- 任务类型；
- 模型和版本；
- 成本；
- verifier failure 和缺陷逃逸率；
- 与单 Agent 基线对比；
- 已知失败事件和修复时间。

若无法公开证据，应把 README 表述改成“derived from an internal project”，不要使用 production-validated 作为质量保证。

**验收标准**

- README 中每个经验性质量声明都链接到公开方法、数据或报告；
- 报告说明样本范围、任务类型、模型版本、失败定义和数据缺口；
- 无法验证的宣传性措辞被删除或明确标记为维护者自述。

### P2-03 明确是否追求跨 runtime

**问题类型：** 产品战略 / 架构 · **重要性：** 中（P2）

**推荐整改**

若目标始终是 Claude Code，应删除含糊的跨运行时“portable”暗示，集中做好 Claude plugin/workflow 体验。

若目标是跨 Codex、Cursor、Claude 等运行时，应先定义抽象接口：

- spawn；
- structured output；
- budget；
- permissions；
- lifecycle events；
- workspace isolation；
- tracker adapter。

然后为每个 runtime 写 adapter。当前 Markdown fallback 不等于真正可移植。

**验收标准**

- 用 ADR 明确唯一产品方向、受支持 runtime 和不支持范围；
- 若选择 Claude-only，README、布局和测试不再暗示未经验证的可移植性；
- 若选择跨 runtime，每个 adapter 都通过同一组 spawn、权限、预算和生命周期 contract tests。

**待维护者确认**

Claude Code 专用与跨 runtime 没有同时低成本实现的方案，必须由维护者选择一个作为未来 1–2 个版本的主路线。

### P2-04 数据保存、脱敏和删除策略

**问题类型：** 隐私 / 合规 · **重要性：** 中（P2）

**推荐整改**

为 lifecycle、messages、memory、screenshots、stdout 和 hang logs 定义：

- 数据分类；
- 默认脱敏规则；
- 保存期限；
- archive 与删除；
- owner 删除请求；
- 不允许进入模型上下文的字段；
- provider/data residency 配置。

“append-only”应允许合规删除或加密销毁，不能与数据最小化要求冲突。

**验收标准**

- 每类 artifact 都有负责人、存储位置、访问范围和默认 TTL；
- 自动化测试证明 token、cookie、Authorization header、邮箱等不会以原值进入持久日志；
- retention job 能删除过期测试数据，并为 legal hold 给出明确例外记录；
- 删除、脱敏或加密销毁后，账本仍能保留不含敏感内容的审计摘要。

## 7. 建议的 PR 拆分顺序

| PR | 内容 | 依赖 | 完成标志 |
|---|---|---|---|
| PR-01 | LICENSE、NOTICE、README 定位和来源说明 | 维护者法律决定 | 可合法复用，声明准确 |
| PR-02 | 修正 cwd/layout、wrapper paths、`--add-dir`、frontmatter 和最低版本 | PR-01 可并行 | 全新 layout smoke 通过 |
| PR-03 | Engine 输入验证与显式状态模型 | 无 | 所有 false-green 回归测试通过 |
| PR-04 | Guardian fallback 和完整 recovery package | PR-03 | Guardian 故障不丢证据 |
| PR-05 | Workflow mock harness、故障注入测试和基础 CI | PR-03/04 | PR required checks 生效 |
| PR-06 | Validator v2、deployment fixtures 和机器可读输出 | PR-05 | 残缺部署全部 fail |
| PR-07 | Secret references、最小权限、prompt injection 边界和 SECURITY.md | PR-02 | secret/injection tests 通过 |
| PR-08 | Watchdog 安全修复与跨平台测试 | PR-05 | traversal/PID 测试通过 |
| PR-09 | 幂等 bootstrap/upgrade 工具 | PR-02/06 | 新旧项目一条命令初始化 |
| PR-10 | run ID、原子 reconciliation、账本幂等性 | PR-03/06 | 崩溃与重试测试通过 |
| PR-11 | 成本指标、低成本默认值和 benchmark | PR-03/05 | 可比较单 Agent 基线 |
| PR-12 | demo、release pipeline、signed alpha release | 前述 P0 | `v0.1.0-alpha` 可复现安装 |

## 8. `v0.1.0-alpha` 发布门槛

发布前必须同时满足：

- [ ] 许可证和来源授权明确；
- [ ] 唯一支持的目录布局写清并通过 smoke test；
- [ ] wrappers 无未知 Claude frontmatter 字段；
- [ ] 明确最低 Claude Code 版本和付费功能要求；
- [ ] fractional/negative/malformed args 不会 dispatch；
- [ ] worker error、terminalStop、missing verifier、Guardian error 都不能产生假绿；
- [ ] code-shipping 未通过 verifier 时绝不可能 `allPassed=true`；
- [ ] Guardian 失败仍返回完整恢复包；
- [ ] validator 能拒绝每一种缺失 mandatory artifact 的部署；
- [ ] 故障注入测试、ShellCheck、secret scan 和 link check 在 CI required；
- [ ] smoke credential 不会落入 Git、prompt 或日志；
- [ ] watchdog 路径和 PID 测试通过，或 alpha 默认不安装 watchdog；
- [ ] 一个公开 demo 从 init 到 builder/QA/recovery 全程通过；
- [ ] 成本报告能够显示真实 token 和估算 USD；
- [ ] README 不再把 advisory prompt rule 描述为机械安全控制；
- [ ] 安装使用固定 tag/release，而不是 mutable main。

## 9. 仍需维护者回答的问题

这些问题没有适合由审计者代替产品所有者决定的唯一答案：

1. **许可证与权利**：原 source workspace 是否全部由你拥有？计划使用什么许可证？
2. **核心产品形态**：AI.Team 是 Claude Code 专用治理 kit，还是未来要跨 runtime？
3. **唯一目录布局**：side-by-side、产品内 `.ai-team/`，还是 Claude plugin？
4. **信任边界**：是否明确支持机密/企业代码？如果支持，允许哪些模型供应商、地区和 MCP？
5. **自治程度**：所谓 unattended 是否允许修改代码、执行迁移、运行网络命令？哪些动作必须人类批准？
6. **成本目标**：一个普通 feature ticket 可接受的 token、USD 和 wall-time 上限是什么？
7. **支持平台**：macOS、Linux、Windows/WSL 哪些属于正式支持？
8. **Tracker 范围**：Jira/Linear/GitHub 是真实 connector，还是仅流程约定？
9. **持久化要求**：账本需要永久保存，还是必须支持脱敏、TTL 和删除？
10. **效果证据**：是否能公开脱敏的三个月运行数据或示例实例？

## 10. 最终建议

本仓库最值得保留的是：

- 权威层级和 single-source 思路；
- Minimum Viable Team；
- 独立 verifier；
- owner contract 与 SAFE-MODE；
- 对 Agent 失败模式的系统总结；
- 记录估算与实际差异的反馈闭环。

最需要改变的是：

- 不再把提示词协议等同于机械控制；
- 不再让错误、缺失状态或 Guardian 故障产生绿色结果；
- 将部署、验证、测试、权限和恢复做成可执行且可回归的代码；
- 将“作者经验”转化为公开、可复现的测试和证据。

完成 P0 后，AI.Team 才适合作为实验性治理工具试用；完成 P1 并积累公开运行数据后，才有条件讨论关键项目和更高自治等级。
