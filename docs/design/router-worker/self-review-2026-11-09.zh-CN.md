# Router/Worker 实现自查与交接

日期：2026-11-09。作者自查，不是独立第三方评审。

## 结论

本轮补齐了稳定 ticket 的离线持久化绑定、保留检查点、带锚点的只读检查命令，以及真实本地验收命令到候选的证据一致性绑定。新增集成测试先持久化 intent/start，再执行临时 fixture 的改动或检查，最后落 close 并重新打开验证历史。

**Router/Worker 功能整体尚未完成，不能实际 rollout。** 现有成果可供离线开发与审查；未交付真实部署发布、独立模型会话、实际续用与用量结算。`launchable: false` 是新接口的契约标记，不是旧引擎的防运行沙箱。不能把 preview 的旧引擎 plan 字段直接拿去运行。

本轮没有发现需要紧急处置的已复现 P0/P1 缺陷；这不是对全部实现无高风险缺陷的保证。复现并修复一项 P2 问题，另列出实际启用前的 P1 能力缺口。缺口与缺陷分开，未把“尚未实现”描述成现有 specialist 模式发生故障。

## 审查对象与可核对快照

- 工作树：本分支的独立 `AI.Team-router-worker` checkout。
- 分支：`codex/router-worker-mode`
- 自查时 HEAD（打包提交前）：`8331e0921b8d8546c1ca3691a3dfa5e709b75971`。
- 这份初始自查使用当时未提交的工作树；后续实现已分批提交。最终 PR 准备记录见本文末节及 [PR 交接](pr-handoff.md)。未 push。
- Node：`v25.6.1`；本地 Claude CLI 只读探测为 `2.1.319`，未调用模型。
- 本次主要检查：候选/报告/命令记录接口、retry 状态机与 SQLite/registry 边界、失联与回滚负例、CLI 只读性及与旧路径的隔离。并执行全部现有回归。未声称逐行独立评审整个仓库。
- 实现快照包含 30 个文件：`src/router-worker/**`、`config/router-worker/**`、`tests/fixtures/router-worker/**`、`tests/router-worker-*.test.mjs`、五个 Router/Worker CLI（含 `team-mode.mjs`）、ADR 0008。对路径排序的 `{path,sha256}` 数组按 `JSON.stringify` 编码再计算 SHA-256：`sha256:4ab2e3b80d90128d7c6540bf69a9f7e1dea31b90f870017d407067485a08f012`。文档不计入该摘要，避免自引用；摘要不是签名或审批。

## 已复现并修复的问题

### SR-01 — 不支持的 Node 版本会先留下注册占位，再失败

- 类型：正确性 / 恢复可用性。
- 级别：P2，中等；状态：已修复并加回归。
- 位置：[`retry-registry.mjs`](../../../src/router-worker/retry-registry.mjs) 的 create/open 入口。
- 修复前证据：在隔离子进程模拟 Node 22 的版本值，先创建 registry 再注册 ticket；SQLite 层返回 `CAPABILITY_MISSING`，临时根目录却已经存在 `registry.json`、ticket claim 和 ticket 目录。再次正常注册无法自动完成，必须人工调查残留。
- 影响：不支持的运行环境会污染一次性初始化路径，给后续操作留下无法自动恢复的占位。没有证明数据泄露、越权运行或付费调用，因此不评级为安全紧急问题。
- 修复：在创建或打开 registry 的入口先检查 Node 24+，在任何路径占位之前拒绝。
- 验证：`unsupported runtime capability fails before claiming a registry or ticket path` 测试断言明确错误且临时目录为空。测试通过。该测试只覆盖版本门分支，不冒充完整 Node 22 运行验证。

## 已验证的新增行为

| 能力 | 证据 | 不可外推的结论 |
|---|---|---|
| 稳定 ticket 绑定 | 同 repo/ticket 重开原库；删 ticket 目录仍有 root claim，拒绝重新初始化；换库拒绝 | 不能抵御删除整份可信状态或更换外部锚点 |
| 部分回滚检测 | 原 inode 写回旧的合法 SQLite 文件，保留较新 checkpoint 时拒绝 | 不证明完整防回滚、断电恢复或网络盘安全 |
| 失联响应处理 | DB 已提交而 checkpoint 落后时阻止新事件；相同事件重放不重计，允许补 checkpoint | 不证明失联模型已经停止，也不自动重派 |
| 并发一致性 | 两个真实子进程竞争同一版本，一个追加成功，另一个拒绝 | 只是日志一致性，不是产品 checkout 独占 |
| 只读检查 | 新命令验证独立锚点、claim、binding、checkpoint 和日志；缺文件不创建，错误不输出部分成功结果 | 原 raw-store inspector 不检查 registry；任何 inspect 成功都不是恢复授权 |
| 实际命令证据 | 固定 checker 读取临时 JSON，坏候选 exit 1、干净对照 exit 0；记录与配方、候选和 assignment 一致 | 不是真实 Claude 独立验收；会话/准入仍是 fixture |
| 证据拒绝 | 伪造 PASS、错 run/recipe/ticket、缺记录、验收后改候选都被拒绝 | 内部一致的序列化记录仍可能被伪造，尚无可信宿主来源证明 |

registry 不提供自动清理、reset、删除事件或清除 stop。SQLite 与 checkpoint 是两个提交步骤，不能声称跨文件原子。只有数据库回滚而保留外部 checkpoint 的情形被覆盖；checkpoint 也被一起回滚不在当前保证内。

## 未解决项：实际启用前的门槛

优先级针对未来启用，不代表当前未启用的离线工具已经造成事故。P1＝必须在实际启用前完成或明确缩小支持范围；P2＝受监督试点之前明确策略、保留限制。

| ID / 级别 | 类型 | 当前事实 | 下一步方案与验收条件 |
|---|---|---|---|
| G-01 / P1 | 部署完整性 | 目前只有 inert JSON 草稿；完整项目 profile、Markdown source adapter、读取闭包、治理 staffing 未完成 | 固定首批 stack/host，生成独立 staging 实例；真实 validator 的 deployment 模式通过；启用 workflow 逐项有责任人、触发和证据；原实例不变 |
| G-02 / P1 | 运行隔离 / 授权 | 不同 wrapper 名与记录引用不证明会话/工具独立；没有产品独占与完整 ignored/external 表面控制 | 实现经选定宿主验证的权限与执行边界；用临时 canary 做禁止动作测试；拿不到所有权或无法解释已有进程时零派发，不用 Bash prompt 充当沙箱 |
| G-03 / P1 | 恢复 / 正确性 | journal 支持重试记账，但 compiler 只编译首次 exec/check，真实恢复目标未绑定 | 在同票同 duty 中编译 continuation；仅续用已证明的原会话；缺会话、候选过期、未知执行均停止；修改模型/skill 不重置次数 |
| G-04 / P1 | 预算 / 生命周期 | 没有真实 harness 增量到 ticket 的幂等 settlement；host admission 只是声明 | 接原 measure/reconcile/lifecycle 路径；按真实 call/usage offset 去重；未知用量不当零；重复 close、crash/reopen、超支和 stop 后晚到用量测试通过 |
| G-05 / P1 | 治理接入 | count/Q5/Guardian 等被列为必需 host gate，但新模式尚无真实执行桥接 | 冻结完整原引擎 run 参数；mock 注入 verifier 前 Q5 停止、Guardian 缺失、重复交付、stop 竞态；每次调用与 lifecycle/count 对账一致 |
| G-06 / P2 | 存储威胁模型 / 运维 | 外部锚点如何保管、整份状态如何备份/回滚尚无部署策略 | owner 选择受信操作员边界或更强外部单调记录；明确禁止整份回滚后自动继续。不要为了“解决”此项凭空增加远端服务或新权限 |
| E-01 / P1 | 验证证据 / 发布 | 未执行真实模型 T2–T4；没有质量/时延/费用优势证据 | 完成上述代码后，单独批准隔离 target、样本、调用次数、预算和停止条件；先最小 smoke，KO 就停，不直接跑全批 |

上述 G-01～G-05 包含实质开发工作，**不是只要充值或点批准就全部完成**。真实 smoke 只是后续证据门，不能拿它掩盖未接入的代码。

## 原有路径影响

对以下路径执行 `git diff --exit-code HEAD -- ...` 返回 0：原 `run-n-rounds.js`、整个 `src/loop/`、`bootstrap-team.sh`、原 `preflight-run.mjs`、`role-skills.mjs` 和 `agents/skill-packs`。没有更改默认 specialist 入口或注册活动 wrapper。

新模块复用了 Loop 目录内的 snapshot、gate record 与本地 runner 工具，不是接入 Loop/Graph supervisor/live provider，也没有更改它们。设计中“不接入 Loop 引擎”不应解释为禁止复用无状态工具；同时不能把这种复用算成新模式已有运行宿主。

“无源文件 diff + 既有回归通过”支持兼容性判断，不等于所有真实部署都已测试。kit 校验中的 deployment 项明确跳过，不能宣称已部署团队通过验收。

## 回归记录

- `node --test tests/router-worker-retry-registry.test.mjs`：14/14 通过。
- `node --test tests/router-worker-offline-flow.test.mjs`：3/3 通过（同时由整库回归覆盖）。
- `node --test tests/*.test.mjs`：740 项，738 通过，0 失败，2 跳过，约 51.3 秒。启用了现有 watchdog 所需的本机进程查询权限；没有并行运行第二份 watchdog suite。
- 两个跳过都是当前 Node 25 下不适用的 Node < 24 capability 负例，不是待修失败。新增 registry 的版本门另有隔离子进程回归。
- `bash scripts/validate-team.sh .`：KIT-VALID；预实例化/真实部署检查按 kit 模式跳过。
- 临时测试仓库中的 fixture baseline commit 不等于提交本工作树。没有真实模型/API、产品部署、提交或推送。

## 下一次开发的明确入口

1. 确认首批宿主和范围：建议本地 Claude Code + Node 24+、有人值守、串行、一次性隔离 Git 副本；首个项目只用不含敏感数据的 Node fixture。此确认不包含付费或发布许可。
2. 先完成 G-01 的 staging 生成与源码适配，不加 activate；一张卡只处理一个 concrete fixture 与它的完整治理读取集合。人工审核期望文件不能由待测生成器即时生成。
3. G-02/G-05 分开处理执行所有权/权限与原引擎停机桥接；mock 验收包括“缺条件时零调用”。不得借机改旧 engine 契约。
4. G-03/G-04 分成续用与结算两张卡，每张包含失联/重复/重开负例；拿不到可信 session 或 usage 就保留 unknown。
5. 完成这些离线开发后再申请最小真实 smoke 预算；授权未到时仍不运行。默认模式切换、已有产品迁移和并发池不在首版卡片内。

不要按通过测试的数量估算“完成百分比”。当前通过的是可枚举的离线不变量；真实部署和恢复结算仍是独立里程碑。

## PR 准备复核 — 2026-11-09

本次按用户要求收敛到可评审的 **offline-foundation PR**，不改变上文未完成的真实运行门槛。没有为制造“新发现”而把已明确声明的限制重新算作缺陷；本轮复核未复现新的阻断离线契约的问题。

- 已 fetch 并核对 `origin/main`：仍为 `8331e09`，分支起点无上游落后。
- 使用本机已有 Node 22.23.4 跑完整套件：740 项，553 通过、187 跳过、0 失败，约 19.6 秒。跳过包含需要较新运行时的能力测试，不能解释为它们在 Node 22 上已经验证通过。
- 使用本机已有 Node 24.22.2 跑完整套件：740 项，738 通过、2 跳过、0 失败，约 42.6 秒。SQLite 正常能力路径在这一轮执行。
- 对已提交代码 `234a7c0` 创建全新临时本地 clone，再用 Node 24.22.2 跑全量：同样 740 项、738 通过、2 跳过、0 失败，约 46.0 秒；确认没有依赖原工作树的未提交源文件。临时副本已删除。
- `measure-context.sh`：PM 约 18,612/25,000，原 worker 约 9,502/10,000，均通过。这是原读取集合的兼容检查，不是新部署完整上下文的证明。
- ShellCheck warning 级别检查通过；原 pinned skill verify 通过；三例 mock probe 与设计描述一致。
- 新增英文 [PR 范围与评审指南](pr-handoff.md) 和根 README 的离线入口；未增加 CI 权限、bot 写入或活动 wrapper。
- 实现分为设计/治理、编译/方法、preflight、草稿/候选、重试状态机、持久化/真实本地命令记录六个提交，最终文档独立提交。作者只在工作分支本地 commit，没有 push 或创建 PR。
- 远端 Linux/macOS CI 矩阵和全历史 secret scan 尚未执行；须在 PR 上等待现有 `ci-required`，不能用本地通过代替。
