# DSH Suzu Memory

为 DeepSeek Harness 的会话接入 [Suzu Memory](https://github.com/eryucheng/suzu-memory) 长期记忆。

每个 DSH `sessionId` 对应独立的 Memory 数据库。恢复同一会话时继续使用已有记忆；不同会话分别记录、整理和检索。插件复用 Suzu Memory 的记忆提取、人物认识、检索、来源证据、审核与备份能力。

## 安装

当前适配 DSH **0.2.1-rc.2**，需要 Node.js **22.19+（22 系列）或 24+**。安装包已包含固定版本的 Suzu Memory 核心和提示词资源。

在 DSH 的插件页面安装本地 `dsh-suzu-memory-0.3.2.tgz`。使用命令行时，按实际使用的配置选择 `web` 或 `desktop`：

```powershell
dsh plugin --profile web add "D:/Apps/AI/dsh-suzu-memory/dist/dsh-suzu-memory-0.3.2.tgz"
```

桌面版的命令行安装遵循 DSH 自身要求：先完成桌面版初始化，退出桌面版后对 `desktop` 配置执行安装。插件不会自动打开浏览器或桌面窗口。

安装后启用 `suzu-memory` 插件。默认沿用当前会话选择的模型及其 DSH 认证，不需要复制登录令牌或另填分析模型 API Key。记忆整理会消耗所选模型的额度。

## 使用

正常聊天即可。插件接收 DSH 已提交的用户和助手文本，在会话空闲后调用 Memory 的后台维护。模型需要历史材料时调用 `suzu_memory_search`，查询结果通过 DSH 自己的工具结果进入对话。

| 工具 | 用途 |
| --- | --- |
| `suzu_memory_search` | 查询当前会话的长期记忆，支持候选数和记忆 ID 关联续查。 |

打开 DSH **设置 → Suzu Memory**，顶部的会话下拉框默认选择当前聊天，也可切换其他已有会话。下面的记忆状态、刷新、立即整理和 **打开记忆审核台** 均对应所选会话。会话列表复用 DSH 的目录快照，不为生成选项拉取聊天内容。没有选中会话时，Embedding 配置仍可编辑。审核台复用 Memory 原有页面，可以核对候选与原话证据、进行人工审核、查看处理状态及创建备份。审核台按需启动，监听本机随机端口，随会话退出或插件卸载关闭。

人设和压缩提示词也在此页按会话保存，已有会话默认沿用 DSH。启用“使用本会话人设”后，填写身份、性格、说话方式与关系设定；保存后从下一次模型请求生效，原生工具说明与操作指导保留。压缩可选择 DSH 原模板、附带的聊天模板或自定义内容，下次压缩使用所选模板。聊天模板保留当前话题、明确表达的态度、约定和未完事项。切换到自定义时可继续编辑聊天模板。存在未保存修改时，请先保存或重新载入再切换会话；并发保存冲突会保留草稿。

人设使用 DSH 的原生人设槽。其他预设若明确提供完整系统提示词，仍以该完整提示词为准。压缩通过原生模型请求路由扩展点替换 `compaction-basic` 摘要请求末尾的指令，保留其会话作用域、模型选择、预算、压缩触发、近期消息保留、历史替换、缓存前缀和失败恢复流程；选择 DSH 原模板时请求原样继续。原始聊天事件继续独立归档到 Memory，压缩摘要不作为新聊天重复收录。

设置页下方可填写 Embedding 的 API 地址、模型名称、向量维度和 API Key；插件详情页也提供同一份配置表单。保存后，下一次检索和整理使用新配置，正在运行的请求保持原配置。维度可留空，API Key 留空保留已保存的密钥；关闭向量检索保留配置。配置作用于当前 DSH profile，记忆数据按会话分别保存。并发修改被拒绝时，页面保留草稿并提示重新载入。

记忆检索只注册 `suzu_memory_search` 的工具说明与参数，没有额外的记忆系统提示词；用户保存的人设进入对应会话的系统提示词，压缩指令仅用于摘要请求。状态、面板地址、配置读写和手动整理通过 DSH 界面命令处理，不进入模型的工具列表。终端也可使用 `/suzu-memory-status` 和 `/suzu-memory-maintain`。

插件只收录会话中实际提交的普通用户文本和助手可见文本。技能注入、工具结果、推理内容和失败的模型尝试不作为普通聊天归档。中断后已经提交的助手文本保留中断标记。分支会话从自己的日志区间建立记忆，不读取父会话的记忆库。

## 配置

Embedding 表单通过 DSH 原生配置接口保存，API Key 使用秘密字段，不会随配置读取返回浏览器。以下为配置覆盖示例，可放入当前配置的 `cordis.patch.yml`：

会话提示词保存在 `dataRoot/session-settings/`，每个会话使用独立文件，通过 DSH 原生原子写入和文件锁保存。首次使用时读取一次，后续请求复用缓存；切换会话、修改配置均不共享其他会话的人设。

```yaml
- id: suzu-memory
  config:
    automaticMaintenance: true
    consoleEnabled: true
    analysisTimeoutMs: 180000
    analysisMaxTokens: 16384
    recallLimit: 5
    recallMaximumCharacters: 12000
```

| 字段 | 默认行为 |
| --- | --- |
| `dataRoot` | 当前 DSH 配置目录下的 `suzu-memory`；无配置上下文时使用 `~/.dsh/suzu-memory`。 |
| `analysisProvider`、`analysisModel` | 同时留空，沿用当前会话的模型；指定时必须同时填写 DSH 已注册的提供者和模型。 |
| `memoryOwner`、`userName` | 分析材料中的称呼，默认 `Assistant`、`User`。 |
| `automaticMaintenance` | 默认开启，在会话空闲后整理待处理材料。 |
| `consoleEnabled` | 默认开启；在设置中查看当前会话记忆、刷新状态或执行状态命令时才按需监听端口。 |
| `embedding` | 默认为空。配置后使用 Memory 现有向量能力；未配置时仍可使用词法、BM25、实体与关系检索。 |

向量模型单独配置；DSH 的聊天模型通道不提供此插件所需的 Embedding 接口。示例：

```yaml
- id: suzu-memory
  config:
    embedding:
      baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
      model: text-embedding-v4
      dimensions: 1024
      apiKeyEnv: SUZU_MEMORY_EMBEDDING_API_KEY
```

`apiKeyEnv` 指向启动 DSH 时提供的环境变量。也可以使用插件配置中的秘密字段 `apiKey`。

记忆与原始证据保存在本地。后台分析会把所需材料发送给 DSH 中选择的模型提供者；配置向量模型后，向量化材料也会发送给相应提供者。

关闭插件会停止采集并取消其在途任务，已有数据保留。卸载插件保留数据。DSH 会话列表的删除操作目前未联动删除 Memory 数据；状态命令可定位该会话独立的数据目录，关闭 DSH 后由用户管理该目录。插件只向 DSH 日志追加原生命令的执行记录，不改写已有对话。

## 开发

```powershell
npm ci
npm run check
npm test
npm pack --pack-destination ./dist
```

创建 `dist` 后执行打包命令。`npm test` 包含官方 DSH 运行时的无密钥集成测试，模型输出使用受控测试适配器。真实账号认证和远端模型输出质量需要在对应模型环境中另行联调。

核心快照保存在 `vendor/suzu-memory`，上游提交与 DSH 基线见 [UPSTREAM.json](UPSTREAM.json)。核心算法源码保持上游原样，适配代码位于 `src`。锁文件固定依赖；安装包通过 npm 的 bundled dependencies 携带所需 Memory 包及其资源。

采用 [Apache-2.0](LICENSE) 许可；Suzu Memory 的许可保留在 [vendor/suzu-memory/LICENSE](vendor/suzu-memory/LICENSE)。
