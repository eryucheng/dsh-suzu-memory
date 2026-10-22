# DSH Suzu Memory

为 DeepSeek Harness 的会话接入 [Suzu Memory](https://github.com/eryucheng/suzu-memory) 长期记忆。

每个 DSH `sessionId` 对应独立的 Memory 数据库。恢复同一会话时继续使用已有记忆；不同会话分别记录、整理和检索。插件复用 Suzu Memory 的记忆提取、人物认识、检索、来源证据、审核与备份能力。

## 安装

当前适配 DSH **0.2.1-rc.2**，需要 Node.js **22.19+（22 系列）或 24+**。安装包已包含固定版本的 Suzu Memory 核心和提示词资源。

在 DSH 的插件页面安装本地 `dsh-suzu-memory-0.1.0.tgz`。使用命令行时，按实际使用的配置选择 `web` 或 `desktop`：

```powershell
dsh plugin --profile web add "D:/Apps/AI/dsh-suzu-memory/dist/dsh-suzu-memory-0.1.0.tgz"
```

桌面版的命令行安装遵循 DSH 自身要求：先完成桌面版初始化，退出桌面版后对 `desktop` 配置执行安装。插件不会自动打开浏览器或桌面窗口。

安装后启用 `suzu-memory` 插件。默认沿用当前会话选择的模型及其 DSH 认证，不需要复制登录令牌或另填分析模型 API Key。记忆整理会消耗所选模型的额度。

## 使用

正常聊天即可。插件接收 DSH 已提交的用户和助手文本，在会话空闲后调用 Memory 的后台维护。模型需要历史材料时调用 `suzu_memory_search`，查询结果通过 DSH 自己的工具结果进入对话。

| 工具 | 用途 |
| --- | --- |
| `suzu_memory_search` | 查询当前会话的长期记忆，支持候选数和记忆 ID 关联续查。 |
| `suzu_memory_status` | 查看当前会话的处理状态与审核台地址。 |
| `suzu_memory_maintain` | 请求整理当前会话的经历，或重试未完成的维护。 |

可对 DSH 说“查看当前会话的记忆状态”，让它调用状态工具。返回的本地审核台复用 Memory 原有页面，可以核对候选与原话证据、进行人工审核、查看处理状态及创建备份。审核台按需启动，监听本机随机端口，随会话退出或插件卸载关闭。

插件只收录会话中实际提交的普通用户文本和助手可见文本。技能注入、工具结果、推理内容和失败的模型尝试不作为普通聊天归档。中断后已经提交的助手文本保留中断标记。分支会话从自己的日志区间建立记忆，不读取父会话的记忆库。

## 配置

配置通过 DSH 原生插件配置保存。以下为配置覆盖示例，可放入当前配置的 `cordis.patch.yml`：

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
| `consoleEnabled` | 默认开启；状态工具请求审核台时才监听端口。 |
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

关闭插件会停止采集并取消其在途任务，已有数据保留。卸载插件保留数据。DSH 会话列表的删除操作目前未联动删除 Memory 数据；状态工具可定位该会话独立的数据目录，关闭 DSH 后由用户管理该目录。插件不修改 DSH 原始会话日志。

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
