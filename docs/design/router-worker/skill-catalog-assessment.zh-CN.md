# Router/Worker 技能目录选型与注入方案

日期：2026-11-06。状态：**候选选型，未安装、未改 renderer/lock、未获逐项采用批准**。

配套设计：[Router/Worker 实施方案](README.zh-CN.md)。本文件不改变其串行首版、PM-only-commit、独立验收及权限边界。

## 1. 检查范围与证据边界

通过 GitHub 完整递归目录（`truncated=false`）枚举并读取全部 SKILL.md 的 frontmatter/结构，覆盖：

- [Matt Pocock](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills)：39 个，包含 engineering、productivity、misc 和 in-progress，不把实验目录当稳定发行承诺。
- [Pstack](https://github.com/cursor/plugins/tree/2776ddd2355d6d6c8747d3964600f28daf62f049/pstack)：58 个主目录 skill，另有 Benny 自动化的 3 个，共 61 个。范围不含 cursor/plugins 的其他插件。
- 进一步读候选方法正文、全部 24 个 principle 正文，以及 eval、runtime-forensics、trace-forensics、visual-parity、hillclimb、pause-safely、session-pickup 等 playbook。检查支持文件目录，辨别脚本、运行时与模型依赖。

这是完整目录筛选与重点候选的语义评审，**不是全部脚本/引用文件的逐行安全审计，也没有执行上游脚本或做模型效果测试**。采用前必须读完入选方法实际依赖闭包、核对许可证、适配后测试；未深读的条件候选不能直接进入部署 allowlist。

本地基线为 `main@8331e09` 合入的技能包，不代表本次拉取了最新 AI.Team main。本次 Matt 上游 SHA 与本地 pin 相同；Pstack 上游仓库 SHA 从本地 pin `bb68f2365eceafa0cb2d253112f675acf5f144cc` 变为 `2776ddd2355d6d6c8747d3964600f28daf62f049`，但本地已选的五个文件（含 LICENSE）逐个 SHA-256 比较均未变化。`node scripts/role-skills.mjs verify` 通过。**上游仓库有新提交不等于我们的已选方法发生变化。**

## 2. 注入架构：分配方法，不再分配职业

按 `mode × duty × task-kind × project-capability` 选择；不再把 debug 只绑定 frontend/backend。以下“设计、研究、性能”均为任务类型，不要求新建常驻岗位。

| 接收者 | 注入内容 | 不应接收 |
|---|---|---|
| PM/Router | 已审核方法的简短目录；当前正在做的需求澄清、规格、切票、交接方法 | 全部技能正文；替代 AI.Team 的新 orchestrator；上游自定模型与预算 |
| 执行 worker | 一个任务主方法 + 必要辅助方法、项目栈约定、授权/停止/交付合同 | 整套 PM 规划流程；嵌套派工；tracker 写入、commit/push/deploy 权限 |
| 独立 check | 项目真实验收配方、与风险匹配的评审/影响/测量方法 | 作者的 PASS 结论作为事实；自由修改产品、验收基线或批准范围 |
| Coach | 批量复盘和规则改进方法，授权的生命周期/用量/失败证据 | 每个错误自动启动改造；自行改 charter/预算/模型；自动吸收上游规则 |
| Auditor/Guardian/Security 职责 | 原检查表与对应的局部辅助方法；仍满足独立性 | 用通用 code-review 冒充安全审计；因加载 skill 就认为治理职责已覆盖 |
| 初始化/维护任务的 worker | 为当前项目生成或维护验收方法；只写授权的配置/测试目录，交 PM 审核 | bootstrap 无提示安装工具、改全局配置、开自动化、发布服务 |

所有人仍读必要硬规则。按需披露针对方法，不用于隐藏安全控制。初期建议零或一个主方法、最多一个辅助方法；必需依赖由编译器提前审核/展开并统一计入上下文预算，不能用“辅助引用”绕过大小限制。方法运行中需要新技能，退回 PM 重新选择，不能自己调用任意 Skill 工具。

PM 目录只暴露该项目已批准且环境可执行的方法，不把 100 个 description 全放进冷启动上下文。Skill 名称用来源限定，避免 Matt 与 Pstack 同名 `tdd`/`teach` 发生碰撞。

## 3. 优先适配的最小集合

“优先”表示值得先实现和做消融验证，不代表默认对每个任务注入。

| 能力 | 来源方法 | 接收者/触发 | 产物与适配要求 |
|---|---|---|---|
| 规格草案 | Matt `to-spec` | PM，范围已讨论清楚 | 沿用现有 draft-only 摘录；不自动发布 issue |
| 垂直切票 | Matt `to-tickets` | PM，已批准目标超出一个可验收块 | 保留依赖和验收条件；不是按 UI/API 岗位切分；tracker 操作由 PM 的既有授权处理 |
| 有证据的诊断 | Matt `diagnosing-bugs` | exec，原因未知的 bug/性能回归 | 红色复现→假设→修复→回归；保留当前 guard；人工问题经 PM，HITL 脚本不自动执行；预算/停因压过“继续尝试”文字 |
| 测试驱动实现 | Matt `tdd` | exec，新行为或适合 test-first 的修复 | 优先作为统一 TDD 主方法。读取 tests.md/mocking.md 等入选依赖；在 ticket/stack 预先确认 seam，不让 worker 每个测试都追问 owner；不自动调用其他 skill |
| 接口设计 | Pstack `architect` 的已审核参考摘录 | 设计范围的 exec，跨模块接口待定 | caller-first 用法、取舍、类型/边界草图；不运行 arena。当前摘录是 Design only，不无声当成“设计后自动实现”的授权 |
| 需求与规范双轴评审 | Matt `code-review` 摘录 | 独立 check | 同一个 check 内分两个输出维度；首版不复制并行双子 agent 编排。固定验收候选必须包含 staged/unstaged/untracked 产品变化，不能仅用 upstream 的 `base...HEAD` 漏掉未提交代码；规范启发式不是硬错误 |
| 下游影响核验 | Pstack `blast-radius` | 独立 check，共享契约/持久化/生命周期改动 | 复现关键安全假设；保留“不确定”分类；不调用 arena/why/unslop。普通文案无需额外注入 |
| 项目真实验收配方 | Pstack `create-verification-skill` 的生成方法 | 初始化/专门维护任务 | 生成 launch/doctor/drive/evidence/cleanup 和功能地图；优先复用已有 stack 与测试，不造平行真相源。写入 AI.Team 可移植路径，不硬编码 `.cursor/skills`；真实跑过才称可用 |
| 批量复盘 | Matt `retro` 摘录 | Coach，原触发队列到期 | 从实际用量、失败和工作记录找环境问题；提改进方案。不要照抄“实现者不读 coding standards”，必要项目规范仍在执行 brief 中 |
| 证据与数值校验 | Pstack `principle-explain-the-number`，必要时 `benchmark-checklist` | Auditor/性能 check/实验负责人 | 检查失败率、工作是否真的执行、样本数与噪声；OS 命令适配实际环境。性能 checklist 的重复次数不能不经批准变成昂贵 LLM 全样本运行 |

首批新增可拆成三小组：① TDD + 双轴 review；② 项目 verify 配方生成与运行；③ retro + 测量校验。现有五个方法先保持兼容，新增逐组验证，不一次引入整个上游集合。

## 4. 有价值但按需启用的能力

### PM/Router 的规划与交付

- **Matt `grilling` / `grill-with-docs`**：只有存在实质产品决策时使用。选一个入口，不叠加同义别名；移除自动探索子 agent，问题按预算与决策影响收束，不把每项小任务变成完整采访。
- **Matt `domain-modeling`**：PM 协调术语/领域关系；设计 worker 可提草案。沿用项目已有 glossary/ADR 路径及审批，不由 skill 新建第二个 ADR 体系或替 owner 决定业务。
- **Matt `triage`**：借需求分类、复现和 agent-ready brief；保留原 tracker 生命周期与授权，不强制引入它的标签状态机，也不自动关闭 issue。
- **Matt `wayfinder`**：大型不确定项目的“决策依赖图”可借鉴；不照搬 100K/session、每会话只做一票、并行 research push 分支等规定。它是规划辅助，不是替代 loop/graph 引擎。
- **Pstack `sharpen` / `in-your-own-words`**：用于模糊 brief 的证据要求与目标复述；改写需保留原目标和禁止项，新增工作仅作为建议。
- **Matt `handoff`；Pstack `ketchup` / `show-me-your-work` 的输出方法**：交接、用户状态说明、决策证据。映射到既有 PM checkpoint/ledger，不另开权威 TSV；临时目录摘要不能替代持久化预算/重试状态。
- **Matt `pr`；Pstack `technical-writing` / `unslop`**：PM 准备交付说明，文档 worker 写用户文档时选用。先选一种主写作方法，不叠加整套风格规范；不因此发布 PR/改变项目缩进规范。
- **Matt `to-questionnaire` / `wizard`**：owner 需要向第三方取决策，或必须本人进行凭据/服务设置时使用。wizard 生成与实际执行分离；审查模板副作用，凭据脱敏，外部写入单独授权。

### 执行与设计 worker

- **Matt `research`**：采用一手证据和引用产物的方法，去掉“再起后台 agent”；当前 worker 自己做已授权研究。
- **Pstack `how` / `why`**：取局部代码流与设计历史调查方法。去掉并行 investigators、硬编码模型、自动 MCP 探索和扩大权限的要求；知识不足标 unknown，不凭空解释历史。
- **Matt `codebase-design`**：当模块边界或测试 seam 有实质问题时，配合 architect 取局部定义；不强迫全项目放弃现有 service/API 等领域术语。
- **Matt `prototype`**：隔离目录中的有界 UI/逻辑实验，帮助 owner 做决定；移除自动 commit、发 issue 和自动把决定落进产品代码。prototype 可以不做完整产品测试，但不能作为生产交付豁免。
- **Pstack `typescript-best-practices`**：仅 TS 项目适用；与已有 stack/lint 合并，必需 principle 和 patterns.md 一并审核，不引导纯 JS 项目迁移 TS。
- **Pstack `principle-model-the-domain`、`principle-boundary-discipline`、`principle-type-system-discipline`**：状态、边界与类型任务按需注入；不能用“内部无条件信任”删除授权/恢复/并发必须重检的控制。
- **Pstack `principle-make-operations-idempotent`、`principle-separate-before-serializing-shared-state`**：适合预算预留、重复交付、恢复、迁移；前者不授予自动重试权限，后者不授权并发。
- **Pstack `principle-build-the-lever`、`principle-sequence-verifiable-units`**：批量修改用可重跑工具，小步验证；去掉 worker commit/rebase 和自动创建新 delegate skill 的路径。
- **Pstack `principle-attack-the-premise`**：反复失败时验证共同假设；不延长原重试上限。

### 验证、审计与技能维护

- **Pstack `maintain-verification-skill`**：独立维护项目 verify 配方和功能地图，区分文档漂移与产品缺陷；去掉源代码读者 fan-out、自动 PR，维护过程不能把产品 bug 改写成新预期。
- **Pstack `create-formal-verification-skill` / `maintain-formal-verification-skill` / `statechart`**：高风险状态机、并发、恢复进入第二阶段。模型必须对应真实代码，记录边界和未覆盖项，变异测试证明能失败。不得把 TLA+ 模型通过等同于 LLM 行为或整个系统正确；工具安装、脚本依赖和资源上限独立批准。
- **Pstack `interrogate`**：适配为单独 check 的对抗性验证方法，去掉 arena fan-out 和模型选择。可执行复现是强证据，但不能因无法运行就静默丢弃静态证实的权限漏洞；单列已证实、未证实和环境阻塞。
- **Pstack `correct` / `reflect`**：Coach 分析重复缺陷、提出机械控制；由 PM 派批准的实现任务。不要“每次纠正立刻改规则”、自行 commit 或批量改第三方锁定快照。
- **Matt `writing-for-agents`**：Coach/技能维护任务审查触发描述、引用、完成条件和上下文成本。不是所有 worker 的常驻文章，也不能据其文风建议删除硬安全规则。

## 5. Playbook 也有方法价值，但不导入整套 poteto-mode

[Pstack playbooks](https://github.com/cursor/plugins/tree/2776ddd2355d6d6c8747d3964600f28daf62f049/pstack/skills/poteto-mode/playbooks) 除入口 skill 之外有可提取方法：

| Playbook | 可借鉴部分 | AI.Team 适配边界 |
|---|---|---|
| `eval` | 预登记标准、对模型名盲评、任务形式自然、从日志/产物验证而非自报 | 由隔离实验驱动器串行运行；不照搬多模型 fan-out。隐藏评分细则不能隐藏用户验收要求、权限和 stop 条件；实现证据优先于模型裁判。仅访问本试验日志 |
| `runtime-forensics` / `trace-forensics` | 真实 profile/trace、缩小证据、回溯源码、区分假设与确认 | 有界诊断任务；不自动派子 agent，不因原文称 read-only 就允许热改运行中产品；所有插桩按环境授权 |
| `visual-parity` | 先固定基线，再比较同状态截图 | 仅用于已批准的视觉等价任务；不修改基线讨好测试；设备/字体/动画噪声须先控制并预登记容差，不机械要求所有平台零像素差；不无限 loop |
| `hillclimb` | 冻结测量、一次假设一次实验、性能改善同时守住正确性 | PM 用原预算/停止/小 commit 规则安排；去掉持续自治、硬编码模型、自动并行和发布；不通过超出预算“突破平台期” |
| `pause-safely` / `session-pickup` | 安全边界、状态证据、恢复点 | 只取 checklist，不能在 worker 暂停时 commit，也不能把旧 transcript 当高于当前磁盘事实的权威；采用本分支迁移/对账协议 |

这些是后续可提取的方法，不意味着引入 Pstack 的整套 orchestrate、autopilot、shipping 或 watcher。

## 6. 不原样采用及去重规则

1. **第二套编排系统不导入**：Matt `ask-matt`、`implement-spec`、`chief-of-staff`、`claude-handoff`；Pstack `poteto-mode`、`arena`、`swarm` 等会重定义派工、会话、模型或发布流程。允许读它们的设计，不允许作为 worker 的入口协议。
2. **安装/自动化不作为运行技能**：`setup-matt-pocock-skills`、`setup-pstack`、Benny、`make-bot-ui` 等需要专门采用决定；不改全局环境、模型 roster 或启用外部 webhook。
3. **同名同义方法只选一个主路径**：Matt TDD 为首批主方法；Pstack `tdd` 可作为后续“已有便宜复现入口”的轻量回归候选，但不能借其 skip 建议绕过配置的验收。`teach`、grill 别名、写作方法也不叠加。
4. **原则尽量并入现有规则，而不是永久追加 prompt**：M4/M5 已覆盖的“证明真实结果”、M6 已覆盖的根因/缺陷类扫描，记录来源与局部增益即可。只有测得缺口才增加指令。
5. **保留旧模式优先于删除旧路径原则**：`principle-migrate-callers-then-delete-legacy-apis` 的适用前提是没有外部兼容承诺，本分支不满足。`principle-outcome-oriented-execution` 的中间破坏和 `principle-redesign-from-first-principles` 的广泛改造不能覆盖现有兼容性要求。
6. **不把可逆当作已授权**：`principle-never-block-on-the-human` 仅可取“在已授权范围内继续不受阻的工作”；安全、费用、产品方向和权限决策仍须停等，不能因代码可回滚而先做。
7. **不直接修改 vendor 文件**：保留原文、pin、许可证；所有选段、去依赖、权限收束放版本化适配层。生成方法明确标识上游源与 AI.Team adaptation revision，不把裁剪稿冒充原版。

## 7. 完整目录处置索引

标记：**A** 优先适配；**B** 有具体任务才评审启用；**C** 只取方法/合入已有规则，不新增独立运行入口；**D** 本分支不纳入。A/B 均非“原样安全”。同一行列出的每个名称适用该行结论。

### Matt：39 个

路径以 `skills/` 为根。

| 目录/skill | 结论 | 去向/原因 |
|---|---|---|
| engineering/ask-matt | D | 第二套路由入口；AI.Team 自有 capability catalog |
| engineering/code-review | A | check，需求/规范两轴，去 fan-out |
| engineering/codebase-design | B | 设计 worker，局部模块与 seam |
| engineering/diagnosing-bugs | A | exec/debug，复用现有适配 |
| engineering/domain-modeling | B | PM/设计草案，沿用 ADR 权限 |
| engineering/grill-with-docs | B | PM 澄清，组合 grilling/domain-modeling；不重复装别名 |
| engineering/implement-spec | D | 自带任务图派工/集成/发布流程 |
| engineering/implement | C | 只取实现次序，移除自动 commit 和技能链，非新入口 |
| engineering/improve-codebase-architecture | B | 专门架构审计；去 fan-out，限定范围；不自动重构 |
| engineering/pr | B | PM 交付文稿，不自动 PR |
| engineering/prototype | B | 隔离、有界试验，不直接成为生产产物 |
| engineering/research | B | 研究 worker，去二次派发 |
| engineering/retro | A | Coach，批量有证据复盘 |
| engineering/setup-matt-pocock-skills | D | 与 bootstrap/tracker 配置重叠 |
| engineering/tdd | A | exec 的统一主测试方法 |
| engineering/to-spec | A | PM，沿用 draft-only |
| engineering/to-tickets | A | PM，沿用 draft-only |
| engineering/triage | B | PM intake，映射原状态机 |
| engineering/wayfinder | C | PM 决策依赖图，不导入其调度/分支流程 |
| engineering/wizard | B | owner 设置辅助，独立安全审查模板 |
| in-progress/chief-of-staff | D | 实验编排系统 |
| in-progress/claude-handoff | D | 自动后台接管与现有恢复冲突 |
| in-progress/loop-me | C | 可借 workflow 需求澄清，不另建循环规格系统 |
| in-progress/setup-ts-deep-modules | B | 明确 TS 架构治理任务才采用；新增工具另批 |
| in-progress/software-factory | C | 架构词汇参考，非运行协议 |
| in-progress/writing-beats, writing-fragments, writing-shape | D | 内容写作实验，不属团队执行最小集 |
| misc/git-guardrails-claude-code | B | 宿主安全集成研究；非通用模型技能，hook 不能独自证明 PM-only 写权限 |
| misc/migrate-to-shoehorn | B | 仅该 TS 测试数据迁移任务；非常驻依赖 |
| misc/scaffold-exercises | D | 教学练习专用 |
| misc/setup-pre-commit | B | 显式项目工具任务；不强制 Husky/JS 栈，不覆写已有 hooks |
| productivity/grill-me | C | grilling 的别名，不重复注入 |
| productivity/grilling | B | PM，owner 决策澄清 |
| productivity/handoff | B | PM checkpoint 的摘要方法，不替代状态账本 |
| productivity/teach | B | owner 明确要解释/教学，非执行默认 |
| productivity/to-questionnaire | B | PM 为外部决策者准备问题，不自动发送 |
| productivity/wait-what | C | 用户沟通重述，不占独立工程方法预算 |
| productivity/writing-for-agents | B | Coach/技能维护，按需读 |

### Pstack：58 个主 skill + 3 个 Benny skill

以下前两表路径以 `pstack/skills/` 为根。

| skill（非 principle） | 结论 | 去向/原因 |
|---|---|---|
| architect | A | 继续用已审核设计参考摘录 |
| arena | D | 多候选/多模型编排，不由 worker 执行 |
| automate-me | B | owner 明确要定制方法时，由技能维护任务评审 |
| benchmark-checklist | A | 测量 check/Auditor，不盲目扩大付费试验次数 |
| blast-radius | A | 独立影响验证 |
| bro | C | 简洁表达，无需单独入口 |
| correct | B | Coach 提案与另行授权的结构修复 |
| create-formal-verification-skill | B | 高风险控制面验证生成任务 |
| create-verification-skill | A | 项目初始化/验收能力缺口，生成后实跑 |
| figure-it-out | C | 有界实验/计划方法，不替代 PM/engine |
| how | B | 代码理解 worker，去模型与 fan-out |
| in-your-own-words | C | PM brief 澄清，短提示即可 |
| interrogate | B | 单独对抗 check，非自动 arena |
| ketchup-video | D | 视频交付不属最小工程集 |
| ketchup | B | PM 对 owner 状态/决策说明 |
| maintain-formal-verification-skill | B | 专门验证维护任务；不得弱化不变量 |
| maintain-verification-skill | B | 验收配方/地图维护，去 fan-out/自动 PR |
| make-bot-ui | D | Grok Bot/webhook/Tailscale 专用，扩大部署面 |
| no-comments | C | 先由项目 lint/规范检查，勿增加 Comment Sicko 子 agent |
| poteto-help | D | Pstack 产品入口帮助，不是团队能力 |
| poteto-mode | D | 整套编排不导入，部分 playbook 单独适配 |
| recall | B | PM 有范围的恢复摘要，去跨聊天扫描及 fan-out |
| reflect | B | Coach 局部方法，去三子 agent 和自动 skill 修改 |
| setup-pstack | D | 不覆写模型 roster 或全局 always-applied rule |
| sharpen | B | PM 任务澄清，不扩大 scope |
| show-me-your-work | C | 证据字段映射现有 ledger，禁止第二个权威日志 |
| statechart | B | 形式模型诊断；工具链、依赖与模型边界另审 |
| swarm | D | 第二套并发控制 |
| tdd | B | 轻量 bug 回归备选，不与 Matt 同时启用 |
| teach | B | owner 解释任务，去 how/why 嵌套编排 |
| technical-writing | B | 文档 worker/PM，项目风格优先 |
| typescript-best-practices | B | TS 栈专用，依赖闭包须审核 |
| unslop | B | 用户文稿润色，不影响技术证据与风险表达 |
| why | B | 历史依据调查，外部读取须授权，去 fan-out |

| principle 名称（均加 `principle-` 前缀） | 结论 | 去向/限制 |
|---|---|---|
| attack-the-premise | B | exec 失败假设检查，不延长 retry |
| boundary-discipline | B | 编译器/接口设计，不删除动态安全检查 |
| build-the-lever | B | 重复编辑/证据工具，成本相称，不建新框架 |
| encode-lessons-in-structure | C | 并入 Coach/M6 方法，勿删除仍需保留的授权规则 |
| exhaust-the-design-space | B | owner 批准的新颖设计试验，限制候选/成本 |
| experience-first | C | 对齐现有 M5，用户方向不由 worker 决定 |
| explain-the-number | A | 测量与 eval 证据校验 |
| fix-root-causes | C | 与 diagnosing/M6 去重 |
| foundational-thinking | B | 设计 worker，避免把小任务扩成基础设施建设 |
| guard-the-context-window | C | 与现有上下文门控合并，不允许 worker 再派工 |
| laziness-protocol | C | 简化启发式，不驱动无关删除 |
| make-operations-idempotent | B | 生成、恢复、预算/报告结算 |
| migrate-callers-then-delete-legacy-apis | D | 本分支必须保留旧接口/模式 |
| minimize-reader-load | B | 可维护性审查，不能只凭一层 wrapper 就报告缺陷 |
| model-the-domain | B | 状态机与核心数据结构 |
| never-block-on-the-human | C | 仅已授权非阻塞工作；owner gate 不变 |
| outcome-oriented-execution | D | 不接受以目标完成为由破坏兼容路径 |
| prove-it-works | C | M4/M5 已有；局部证据改进而非重复整篇 |
| redesign-from-first-principles | B | 明确授权的设计任务；非所有改动默认重设计 |
| separate-before-serializing-shared-state | B | 未来并发/恢复设计，保留 PM 单写日志 |
| sequence-verifiable-units | C | 小步验收映射原过程，不自动 rebase/commit |
| subtract-before-you-add | C | 去重参考，不删除旧模式和防御性控制 |
| test-behavior-not-implementation | B | exec/check 测试质量；与 TDD 摘录去重 |
| type-system-discipline | B | 类型化代码与协议；非改语言授权 |

`pstack/automations/benny/skills/`：`setup-benny`、`triage-issue-reports`、`reproduce-and-fix-issues` 均为 **D**：依赖 Benny 的 Slack/automation/control 配置，涉及外部标签、工单或 PR 副作用；不是可直接注入通用 worker 的方法。以后若需要事件 intake，另立集成设计。

## 8. 适配与更新的实现要求

1. 保持现有 `brief(role, task)` 输出和五条路由，新增模式入口以审核后的 method ID 为输入；不往所有旧角色 allowlist 追加 worker。
2. 每条 method 记录来源 commit、原文件 hashes、适配版本、依赖/引用文件、触发与排除、允许 duty、所需环境/工具、输出证据、体积和测试。catalog 元数据不能给权限。
3. skill 的隐含依赖要么作为已审闭包提前渲染，要么明确删掉并解释等价替代；不得留下 arena/why 等悬空指令。只加载方法所需引用，不把整个上游包扔进 brief。
4. 每次派发冻结源码 pin、适配层、catalog、最终 brief 的 digest；上游更新在途不生效。接管/复验时版本变动按新候选与策略重新核验，不能偷换方法。
5. 继续只读上游检查、PM 审阅 diff、测试后由 PM commit。新增技能不会自动进入老部署；升级必须显式更新实例，老实例可继续原 pins。检查范围扩到新增 allowlist 和实际渲染依赖，不只看 SKILL.md。
6. 静态测试覆盖 duty/trigger 正反例、坏 hash、缺依赖、超上下文、无权限、输出不确定和旧模式兼容；语义冲突人工评审，关键词禁用扫描不等于安全验证。
7. 行为试验比较“基础 brief / 加一个方法”，固定模型、候选、预算和 oracle；看行为与产物，不问模型是否遵守技能。失败消耗计入成本，不能把依赖额外调用排除出统计。
8. 验收生成方法至少执行一次生成出的真实配方；模型/形式验证要有能被抓到的故意破坏版本和正确对照。测试通过只覆盖样本与已声明边界。

## 9. 下一步交付边界

本文件是取舍依据；先确认最小集合，再为第一小组编写 adapter/catalog 与负面测试。项目 verify 配方另用一张有范围和预算的任务生成，不把所有产品的验收一次性解决。形式验证、并发研究、自动化接入不作为首版依赖。

本次只新增选型文档；未安装插件、未运行上游脚本、未修改 pin/renderer/原设计决定、未触发模型试点、未 commit 或 push。
