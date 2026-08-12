# 云测试平台稳定化与历史数据迁移交接文档

> 生成时间：2026-08-10（Asia/Shanghai）  
> 目标读者：完全没有此前会话上下文的新会话/新维护者  
> 当前文档位置：`/Users/hanzhen/Documents/cloud-test-platform/HANDOFF.md`

---

## 0. 最重要的结论与警告

### 请先确认当前会话位于正式开发目录

需要特别识别的旧工作区：

```text
/Users/hanzhen/Documents/云测试的项目
```

是旧的归档混合工作树，当前分支为：

```text
archive/main-mixed-worktree-2026-08-09
```

这里仍有大量 staged、unstaged、untracked 混合改动。**不要在这里继续开发、整理提交、整体合并或推送为正式 main。**

正式代码仓库是：

```text
/Users/hanzhen/Documents/cloud-test-platform
```

独立运行数据目录是：

```text
/Users/hanzhen/Documents/cloud-test-data
```

新会话开始工作的第一条命令应当是：

```bash
cd /Users/hanzhen/Documents/cloud-test-platform
```

然后确认：

```bash
git status --short --branch
git rev-parse HEAD
git remote -v
```

截至 2026-08-10 17:32（Asia/Shanghai）本次接手检查时，正式仓库状态为：

```text
branch: main
HEAD: 9ccfe7a223f0e6d290213d03bed9ef625a2ad98f
origin/main: c538f36f25557ecef90ef453bb0ea86974befd90
tracking: main ahead 1
working tree: 仅 HANDOFF.md 有待提交的文档修改；未发现源代码修改
origin: git@github.com:18889627163-max/cloud-test-platform.git
```

`9ccfe7a` 是“docs: add project handoff”提交；当前未提交修改包含本节交接状态刷新和第 2.1 节机型/协议改动强制回答清单。交接前不得把这些文档修改误认为已同步到 `origin/main`。

注意：本地引用显示 `origin/main` 已对齐，但此前曾发生过 GitHub SSH `Permission denied (publickey)`。下次真正 fetch/push 前仍应运行 `ssh -T git@github.com` 或 `git fetch origin` 重新确认当前 SSH 凭据，不要仅凭本地 remote-tracking ref 推断网络认证一定正常。

---

## 1. 我们在做什么任务

项目此前为了追求高内聚、低耦合、扩展性和维护性，引入了很多按“技术动作”拆分的小模块，但没有始终形成少数稳定、职责完整的业务深模块。结果是复杂度通过以下隐式关系泄漏回主流程：

- 共享状态；
- 调用顺序；
- 页面识别与状态机判断不一致；
- Controller、Coordinator、Profile 对同一页面语义理解不同；
- 错误优先级和 Evidence 语义不一致；
- 单模块修改没有同步对齐调用方、接口、状态、时序和测试；
- 混合工作树使问题无法可靠归因、回退和验证。

用户真正的目标不是简单减少文件数量，而是：

1. 恢复项目稳定性和版本可追溯性；
2. 建立少数稳定的业务深模块；
3. 新增机型尽量只修改 Profile、Adapter 和 fixture；
4. 一次业务修改同时对齐 Interface、状态、时序、错误、Evidence 和测试；
5. 问题可以定位、回放、验证和独立回退；
6. 代码和历史运行数据彻底脱离旧混合工作树。

采用的路线是“方案 A：稳定优先、分阶段治理”：

```text
S0 冻结版本和运行证据
→ S1 PKR110/OPlus 主链验证
→ S2 收敛 ApplicationPreparation 状态机
→ S3 收敛 MorphoProtocolExecutor
→ S4 统一 Failure、Evidence 和兼容迁移
→ S5 建立新正式基线
→ 将历史运行数据迁移到独立永久数据目录
```

---

## 2. 用户沟通原则

后续会话必须遵守：

- 不要把用户的猜测当成事实；
- 不确定时明确写“不确定”以及需要什么证据才能确认；
- 先区分用户的问题、情绪和隐含目标；
- 如果存在多种理解，先列出不同理解；
- 不要为了显得完整而编造确定结论；
- 用户说“你没理解我”时，先重述用户意图，不要急着辩解；
- 如果用户是在探索，不要过早给出唯一结论；
- 涉及运行结果时，区分“自动化/fixture 通过”“历史真机通过”“当前真机重新验收通过”。

### 2.1 机型或协议改动的强制回答清单

以后每一个机型或协议改动，无论是设计说明、实现汇报、代码评审还是交付结论，都必须逐项回答以下问题：

1. **业务行为改变了什么？** 明确改动前后用户可观察行为、适用机型/系统/协议阶段，以及未改变的行为。
2. **哪个深 Module 是最终决策所有者？** 只能指定一个最终拥有业务判断权的深模块；其他模块只能提供事实、执行动作或适配，不得重复决策。
3. **Interface 是否变化？** 列出新增、删除或语义变化的输入、输出、事件、错误和兼容策略；未变化也必须明确写“未变化”。
4. **状态唯一 writer 是谁？** 指明每个受影响状态的唯一写入者，以及其他模块如何只读、订阅或请求变更。
5. **时序和取消是否变化？** 说明 phase/transition、等待条件、timeout、重试、并发、主动取消和清理语义是否改变。
6. **Failure 和 Evidence 是否对齐？** 每个新增或变化的失败语义必须有对应的结构化 Failure、优先级、Evidence、Attempt 身份和可诊断上下文。
7. **fixture 是否补充？** 正常、失败、边界和回归场景分别新增或更新了哪些 fixture；未补充时必须说明为什么现有 fixture 足够。
8. **跨 Seam 测试是否通过？** 明确列出跨越了哪些模块边界、执行了哪些测试、结果如何；单模块测试不能替代跨 Seam 验证。
9. **真机 Gate 是否完成？** 分开报告“fixture/自动化通过”“历史真机通过”“本次当前版本真机通过”；没有本次真机 Evidence 时只能写“真机 Gate 未完成”。
10. **能否独立回退？** 说明回退范围、数据/接口兼容性、依赖提交、回退步骤和回退后的验证方式。

固定汇报模板：

```text
业务行为：
最终决策所有者（深 Module）：
Interface：
状态唯一 writer：
时序与取消：
Failure / Evidence：
fixture：
跨 Seam 测试：
真机 Gate：
独立回退：
```

任何一项不得省略。尚未完成的项目必须明确标记“未完成”、缺少的 Evidence 和下一步 Gate；确实不适用时必须写“不适用”并说明理由，不得用笼统的“已验证”“应该没问题”代替。

---

## 3. 已经完成的代码稳定化工作

正式仓库中已经形成一条干净、按业务切片提交的稳定化链。关键提交包括：

```text
1b1f945 feat: record attempt identity and evidence manifest
6c31d15 refactor: centralize android preparation decisions
cd0d90a test: verify android preparation transitions across phases
63ffd8c refactor: encapsulate morpho protocol execution
3e46c63 feat: introduce structured execution failures
e36f3bd feat: expose execution evidence compatibly
d6d97ed fix: observe runtime dialog before timeout
ac2b790 feat: capture terminal attempt failure evidence
9327bf5 feat: record android preparation transition evidence
8324909 test: capture pkr110 oplus install guide
96d3994 feat: record permission and post-launch transitions
a74b5cb test: add installed-state protocol gate harness
3bd4166 docs: record stabilized baseline and device gates
c538f36 docs: align project status with stabilized baseline
```

归档/基线标记：

```text
archive/main-mixed-checkpoint-2026-08-07 -> 3f70307
archive/main-head-2026-08-09          -> bdf9003
baseline/pkr110-stabilized-2026-08-09 -> 3bd4166
当前正式 main                            -> c538f36
```

从提交历史可以确认已经实施的方向：

- Attempt Manifest 与运行 Evidence 身份关联；
- Android ApplicationPreparation 决策集中化；
- 页面动作之后的 transition observation；
- 安装、权限、post-launch 跨 phase 测试；
- Morpho 协议执行从 TaskOrchestrator 中封装；
- 结构化 ExecutionFailure；
- 新旧 Failure/Evidence 兼容暴露；
- PKR110/OPlus 安装引导 fixture；
- 已安装状态协议 Gate harness；
- 稳定化基线与设备 Gate 文档。

但不要把“代码中存在这些提交”扩大解释成“所有机型、所有系统版本都已经真机稳定”。已确认事实和未完成项见后文。

---

## 4. 历史数据迁移已经完成

### 4.1 目录结构

旧数据源（保留，未删除、未覆盖）：

```text
/Users/hanzhen/Documents/云测试的项目/data
```

正式代码：

```text
/Users/hanzhen/Documents/cloud-test-platform
```

独立数据：

```text
/Users/hanzhen/Documents/cloud-test-data
```

代码和数据现在是同级独立目录。这是设计目标，不是异常：

```text
/Users/hanzhen/Documents/
├── cloud-test-platform/   # Git 代码
├── cloud-test-data/       # SQLite、artifacts、tasks、历史证据
└── 云测试的项目/          # 旧混合工作树，暂时只读保留
```

### 4.2 运行配置

本机配置：

```text
/Users/hanzhen/Documents/cloud-test-platform/.env.local
```

内容：

```dotenv
CLOUD_TEST_DATA_DIR=/Users/hanzhen/Documents/cloud-test-data
```

`.env.local` 被 Git 忽略，不应提交 GitHub。

### 4.3 数据库验证

迁移后的数据库：

```text
/Users/hanzhen/Documents/cloud-test-data/cloud-test.sqlite
```

验证结果：

```text
PRAGMA quick_check: ok
foreign_key_check violations: 0
```

表数据数量：

| 表/业务数据 | 数量 |
|---|---:|
| devices | 9 |
| device_endpoints | 18 |
| tasks | 38 |
| device_runs | 102 |
| task_logs | 2332 |
| artifacts | 107 |
| task_outputs | 68 |
| check_results | 348 |
| task_deletion_audits | 54 |

### 4.4 绝对路径迁移

旧前缀：

```text
/Users/hanzhen/Documents/云测试的项目/data
```

新前缀：

```text
/Users/hanzhen/Documents/cloud-test-data
```

事务性修改结果：

```text
artifacts.storage_path 更新：107
 task_outputs.storage_path 更新：68
旧 Artifact 前缀剩余：0
新 Artifact 前缀记录：107
旧输出前缀剩余：0
新输出前缀记录：68
```

### 4.5 文件完整性

已经通过“相对路径 + 字节数 + SHA-256”验证：

- Artifact：107 个，全部存在，大小一致，SHA-256 一致；
- Task Output：68 条，全部存在，大小一致，SHA-256 一致；
- `artifacts/`：107 个文件内容一致；
- `tasks/`：360 个文件内容一致；
- `legacy-evidence/manual-device-validation/`：196 个文件内容一致；
- `legacy-evidence/recovery/`：55 个文件内容一致。

恢复工具没有保留文件 mtime，因此时间戳差异不是内容损坏。不得因为 `rsync` 只报告 `.f..T....` 就重新复制或覆盖数据。

### 4.6 迁移清单

完整记录：

```text
/Users/hanzhen/Documents/cloud-test-data/migration-manifest.json
```

关键状态：

```text
status: validated
pathRebase.passed: true
apiValidation.passed: true
runtimeConfiguration.gitWorktreeClean: true
```

注意 `gitWorktreeClean` 位于 `runtimeConfiguration` 下，不是顶层字段。

---

## 5. API 历史验证已完成；当前 API 未启动

历史迁移验收期间，3000 端口曾有 Node API 监听，且 API Gate 全部通过；该结果由 `migration-manifest.json` 保存。

本次 2026-08-10 17:32 接手检查时，3000 端口没有监听进程，`curl http://127.0.0.1:3000/api/health` 无法连接。启动或验证 API 前，先运行：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -sS http://127.0.0.1:3000/api/health
```

已完成的 API Gate：

```text
GET /api/health                     200
GET /api/devices                    200
GET /api/tasks                      200
GET /api/tasks/:id                  200
GET /api/tasks/:id/report           200
GET /api/artifacts/:id              200
Artifact Range                      206
Output Content Range                206
Output Download Range               206
历史 Logcat                         200
历史 Screenshot                     200
历史 Evidence result.json           200
```

最后记录的健康状态：

```text
registered devices: 9
online devices: 6
```

`online` 是动态 ADB 状态，不要求永久为 6；迁移验收的固定事实是注册设备为 9。

历史任务：

```text
总数：38
passed：17
failed：19
cancelled：2
```

抽样任务：

```text
成功任务：task-b4068a16-b1db-4cdd-85b1-b0c9dfb6cde2
失败任务：task-fe25760c-26a0-444e-8224-a6dc000cfb48
输出样本：output-84110599-3c70-4d1d-a725-de331412f5d8
```

验证时 API 使用的是：

```text
/Users/hanzhen/Documents/cloud-test-data/cloud-test.sqlite
```

没有使用：

```text
/Users/hanzhen/Documents/云测试的项目/data/cloud-test.sqlite
/Users/hanzhen/Documents/cloud-test-platform/data/cloud-test.sqlite
```

---

## 6. 回退点：全部必须继续保留

### 新仓库原空库备份

```text
/Users/hanzhen/Documents/cloud-test-platform/data/backups/cloud-test-2026-08-10T04-30-12-070Z
```

### 旧数据一致性备份

```text
/Users/hanzhen/Documents/云测试的项目/data/backups/cloud-test-2026-08-10T04-30-19-214Z
```

这是通过项目 SQLite Backup API 生成的一致性备份，包含数据库以及 `artifacts/`、`tasks/`。

### 路径重写前数据库备份

```text
/Users/hanzhen/Documents/cloud-test-data/migration-backups/pre-path-rebase.sqlite
```

### 旧原始数据

```text
/Users/hanzhen/Documents/云测试的项目/data
```

在迁移后的环境完成至少一次真实真机任务 smoke 验证前，以上内容都不能删除。

---

## 7. 当前卡在哪里 / 尚未完成什么

目前没有阻止 API 读取历史数据的迁移故障；迁移已经验证通过。剩余的是稳定性验收和后续治理工作。

### 7.1 尚未完成迁移后的真实任务写入 smoke

已经验证历史数据“能读取”，但尚未在独立数据目录配置下创建一次新的真实真机任务，完整验证：

```text
创建任务
→ 新建 Device Run
→ 写日志
→ 写 Evidence
→ 生成 Artifact
→ 生成任务输出
→ 完成任务
→ API 重新读取上述数据
→ 确认所有新路径都位于 cloud-test-data
```

这是下一步最高优先级。

### 7.2 `report:orphans` 存在已知误报

当前：

```bash
npm run report:orphans
```

会错误地把数据库文件路径和目录路径直接比较，可能把已有的 107 个 Artifact 全部误报为孤儿。

该脚本**不能作为当前数据清理或迁移 Gate**。在修复并增加测试前，不得根据它的结果删除任何文件。

### 7.3 其他机型真机 Gate 未完成

此前唯一明确可用的主目标机是：

```text
厂商：OnePlus
型号：PKR110
ADB 地址：192.168.5.3:5555
```

ADB 地址必须作为运行配置传入，不能写进 Profile 或公共业务逻辑。

荣耀 X50、PJV110、V2324A、其他 OPPO/Vivo 机型目前不能仅凭 fixture 或历史规则宣称真机稳定。没有真机时只能写：

```text
自动化/fixture 回放通过，真机 Gate 未完成
```

### 7.4 GitHub SSH 需要在下一次推送前复核

remote 已配置为：

```text
git@github.com:18889627163-max/cloud-test-platform.git
```

但历史会话中曾出现：

```text
git@github.com: Permission denied (publickey)
```

不要在未验证 SSH 的情况下承诺“已经可以继续推送”。先测试，再处理密钥或 ssh-agent。

---

## 8. 下一步执行计划（按优先级）

### P0：迁移后真机 smoke Gate

1. 进入正式仓库：

   ```bash
   cd /Users/hanzhen/Documents/cloud-test-platform
   ```

2. 确认 Git clean：

   ```bash
   git status --short --branch
   ```

3. 确认 `.env.local` 指向独立数据目录：

   ```bash
   grep '^CLOUD_TEST_DATA_DIR=' .env.local
   ```

4. 如果 3000 端口已有 API，先确认是不是正式仓库启动的进程，不要重复启动。
5. 使用 PKR110 创建一次低风险真实任务。
6. 检查新 Attempt Manifest、日志、Evidence、Artifact、Output。
7. 检查数据库新增记录的绝对路径全部以以下目录开头：

   ```text
   /Users/hanzhen/Documents/cloud-test-data
   ```

8. 通过 API 重新读取该任务及文件。
9. 将 smoke 结果写入新的运行记录或文档；失败时保存 Evidence，不要先加特例。

### P1：修复 `report:orphans`

要求以测试驱动方式修复：

- 先建立“数据库已引用 Artifact 不应报孤儿”的失败测试；
- 统一比较文件规范化绝对路径，或明确目录/文件语义；
- 增加 Artifact、Task Output、临时文件和实际孤儿样本；
- 默认只报告，不直接删除；
- 删除功能如以后增加，必须有 dry-run、白名单和二次确认。

### P2：继续执行 PKR110 稳定性 Gate

同一 clean commit 下，目标仍应包括：

- 5 次 clean-install 完整流程；
- 3 次已安装状态重复执行；
- 安装/权限阶段主动取消；
- 启动/协议执行阶段主动取消；
- 每次运行绑定 Attempt Manifest 和独立 Evidence；
- 不通过扩大 timeout、通用文字匹配或固定坐标掩盖问题。

如果这些 Gate 在此前已有运行证据，先定位并复核 Evidence，不要重复宣称或凭记忆补结论。

### P3：其他机型扩展

扩展顺序固定为：

```text
采集真实 Evidence
→ 敏感信息清理
→ 建立失败 fixture
→ 修改 Profile/Adapter
→ 完整跨 Seam 回归
→ 真机复验
```

新增 Profile 不应修改 TaskOrchestrator。Profile 只负责页面事实、Signature、动作候选和风险声明；最终 timeout、stalled、transition 和业务 Decision 由 Coordinator/State Machine 持有。

### P4：文档与日常开发纪律

- 将正式 main 作为唯一开发基线；
- 每个提交按业务切片，不按目录或技术层随意拆分；
- 每个提交必须能独立构建、测试、解释和回退；
- 修改一个业务行为时，同时检查 Interface、Profile、Controller、Coordinator、状态、错误、Evidence、API、前端和测试；
- 禁止再次积累长期 staged/unstaged/untracked 混合改动。

---

## 9. 绝对不要再踩的坑

### 9.1 不要在旧混合工作树继续开发

禁止把：

```text
/Users/hanzhen/Documents/云测试的项目
```

当作新的正式 main。它现在有大量混合改动，无法可靠归因和回退。不要整体 cherry-pick、整体复制或整体合并它的 working tree。

剩余需求如确实需要迁移，必须逐个按业务切片重新评审，并在正式仓库建立干净提交。

### 9.2 不要执行破坏性 Git 清理

在旧工作树和数据完成长期确认前，禁止：

```bash
git reset --hard
git clean -fd
```

也不要强制覆盖 main 或删除归档分支/标签。

### 9.3 不要直接复制正在使用或带 WAL 的 SQLite 主库

不能把以下三个文件简单复制后就宣称一致：

```text
cloud-test.sqlite
cloud-test.sqlite-wal
cloud-test.sqlite-shm
```

迁移必须先停止写入，再使用 SQLite Backup API 生成一致性副本。不要修改旧原库来“修”迁移副本。

### 9.4 不要根据 `report:orphans` 当前结果删除文件

该脚本有已知误报。当前可靠证据是数据库路径、文件大小和 SHA-256 校验，不是孤儿脚本输出。

### 9.5 不要把时间戳差异当作内容损坏

恢复后 mtime 可能变化。`rsync -rcn` 出现 `.f..T....` 只代表时间戳不同；内容判断使用 size + SHA-256。

### 9.6 不要硬编码设备地址或机型特例到主流程

例如：

```text
192.168.5.3:5555
```

只能进入运行配置，不能进入 Profile 或 TaskOrchestrator。出现 PKR110 新页面时，先保存 Evidence、建 fixture、改 Profile/Adapter，不在主流程加入 `if model === PKR110`。

### 9.7 不要把 Profile 识别成功等同于流程成功

典型历史问题：

```text
Profile 已经认识页面
但 Controller/Coordinator 仍按旧规则把节点重复判断为卡死
```

因此每次修改必须验证完整链路：

```text
Profile 分类
→ Controller 动作结果
→ Coordinator transition observation
→ waiting/stalled/timeout decision
→ Failure/Evidence
→ API/前端展示
```

### 9.8 不要继续按浅小模块堆叠复杂度

高内聚低耦合不是“文件越多越好”。优先形成少数业务深模块，接口窄、内部封装复杂度。不要为每个技术动作增加一个拥有部分状态和部分错误决策的小模块。

### 9.9 不要用扩大 timeout、通用文本匹配或固定坐标止痛

这些方法可能短期绕过页面，但会让不同 OEM/系统版本之间的误点击和失败组合继续增加。观察失败也不能退化成“页面不存在”。

### 9.10 不要让低级诊断失败覆盖业务事实

遵守 Evidence 优先级：

- 明确业务成功不能被截图/Logcat 失败覆盖；
- 明确业务失败优先于观察不完整；
- 观察失败不能伪装成“未发现”；
- cleanup 失败作为附加失败，不无条件覆盖原始业务失败。

### 9.11 不要移动数据目录却忘记 `.env.local`

如果移动或重命名：

```text
/Users/hanzhen/Documents/cloud-test-data
```

必须同步修改 `.env.local`，并检查数据库中的 Artifact/Output 绝对路径。未经计划不要移动。

### 9.12 不要重复启动 API

启动前先检查：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

如果已有正确 API，不要再运行第二个 `npm run dev:api`，否则会出现端口占用，也可能误判当前数据源。

### 9.13 不要删除回退点

至少在迁移后真机 smoke 成功、并确认新写入路径和文件读取正常以前，旧数据和三类备份必须全部保留。

---

## 10. 新会话快速检查清单

新会话接手后先执行，但不要立即改代码：

```bash
cd /Users/hanzhen/Documents/cloud-test-platform

git status --short --branch
git rev-parse HEAD
git remote -v
cat .env.local

lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -sS http://127.0.0.1:3000/api/health

python3 -m json.tool \
  /Users/hanzhen/Documents/cloud-test-data/migration-manifest.json \
  >/tmp/cloud-test-migration-manifest.pretty.json
```

本次接手时的期望基线：

```text
branch = main
HEAD = 9ccfe7a223f0e6d290213d03bed9ef625a2ad98f
origin/main = c538f36f25557ecef90ef453bb0ea86974befd90
working tree = 仅允许 HANDOFF.md 文档修改；开始编码前应先处理或明确保留它
CLOUD_TEST_DATA_DIR=/Users/hanzhen/Documents/cloud-test-data
migration status = validated
registered devices = 9
historical tasks = 38
API = 当前未启动；启动后必须重新执行 health/API Gate
```

如果任何值不同：

1. 不要先修复或覆盖；
2. 记录实际输出和具体时间；
3. 区分是 API 未启动、ADB 在线状态变化、Git 基线变化，还是数据源配置变化；
4. 对照 `migration-manifest.json` 和回退点定位差异。

---

## 11. 当前状态矩阵

| 项目 | 状态 | 说明 |
|---|---|---|
| 正式代码仓库隔离 | 已完成 | `/Users/hanzhen/Documents/cloud-test-platform` |
| 正式 main 代码基线 | 已完成 | `HEAD 9ccfe7a...`；稳定化代码基线为 `c538f36...` |
| 本地与 origin/main 同步 | 未完成 | 本地 `main` ahead 1；交接文档待提交/推送 |
| 当前 working tree | 需处理 | 仅 `HANDOFF.md` 有文档修改；开始编码前应先提交、暂存或明确保留 |
| GitHub remote 配置 | 已完成 | SSH 当前连通性下次推送前复核 |
| 稳定化提交链 | 已完成 | Attempt、状态机、Morpho、Failure、Evidence 等已进入 main |
| 旧混合工作树归档 | 已完成但仍保留 | 不得作为正式开发目录 |
| 历史 SQLite 一致性迁移 | 已完成 | quick_check 和外键检查通过 |
| Artifact/Output 路径重写 | 已完成 | 107 / 68，旧前缀均为 0 |
| 文件大小与 SHA-256 校验 | 已完成 | 全部通过 |
| 历史设备和任务 API 读取 | 已完成 | 9 台设备、38 个任务；结果见迁移 manifest |
| 当前 API 运行状态 | 未启动 | 本次检查未监听 3000；启动后需重新执行 health/API Gate |
| API 使用独立数据目录 | 已确认 | 历史验证未访问旧库/新仓库空库；当前启动前仍需检查 `.env.local` |
| 迁移后真实任务写入 smoke | 未完成 | 下一步最高优先级 |
| `report:orphans` 修复 | 未完成 | 当前有已知误报，禁止作为删除依据 |
| PKR110 完整重复真机 Gate | 需复核/继续 | 不要仅凭提交名宣称全部次数已完成 |
| 荣耀/PJV110/V2324A 真机 Gate | 未完成 | fixture/自动化不能替代真机结论 |

---

## 12. 一句话交接

项目已经从旧混合工作树中建立了干净正式 main，并把 9 台设备、38 个任务及全部历史文件一致迁移到独立 `cloud-test-data`；当前最重要的下一步不是继续加模块，而是在正式仓库和独立数据目录下完成一次 PKR110 真实任务写入 smoke，然后修复孤儿报告误报并继续按 Evidence → fixture → 跨 Seam 回归 → 真机验证的方式扩展机型。
