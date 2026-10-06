# 工作区数据与模型配置设计

状态：已实现。使用工作区独立配置与 pi-ai 模型适配层，不依赖 pi-coding-agent。

## 目录

每个工作区使用 `<workspace>/pi-pilot/`，不再使用集中存储里的工作区路径哈希。
当前测试工作区对应 `D:/Project/workspace/pi-pilot-durable/pi-pilot/`。

```text
pi-pilot/
├─ config/
│  ├─ .env                 # Telegram token、允许用户、模型环境变量等
│  ├─ settings.json        # 默认模型预设、思考强度、应用及运行时设置
│  ├─ models.json          # 自定义供应商、模型与内置供应商覆盖
│  └─ auth.json            # 可选：文件凭据，以及后续 OAuth 凭据
├─ sessions/               # 一个 durable 存储，包含该工作区的多个聊天
│  ├─ main.jsonl
│  ├─ doc-<id>.jsonl
│  └─ task-<id>.jsonl       # 由后端按需生成
├─ attachments/            # 已接收的 Telegram 附件，长期保留
├─ tmp/                    # 下载未完成文件、工具输出溢出文件、子进程临时文件
├─ exports/                # 按需创建：聊天、计划、测试报告、交接包导出
└─ logs/                   # 按需创建：启用文件日志后使用
```

初期只按实际使用创建 config、sessions、attachments、tmp；其他目录按需创建。
默认仍向终端输出日志。这里只规定未来文件日志的位置，不增加日志系统。
初始化时在 `pi-pilot/.gitignore` 写入 `*`，配置和数据默认不进入使用者项目的 Git。

## 配置与状态的职责

- `config` 是用户编辑的配置，启动和重载时验证。内置供应商及模型目录来自 pi-ai，
  `models.json` 只记录自定义内容和覆盖；不复制整份内置目录。
- `settings.json` 记录默认模型预设及思考强度。预设可命名 main、review 等，
  不预先绑定或启动子 agent。`/profile` 查看预设，`/profile main` 选择预设。
- `auth.json` 可选。环境变量 key 仍可使用；第一版不要求将 key 从环境变量搬到文件。
  认证底层通过 pi-ai CredentialStore 和供应商认证接口接入。
- `sessions` 的文件由 durable 管理，多个聊天共享一个存储。应用通过 durable API
  查询聊天，不手工创建一份 session.json，也不增加第二份会话索引。
- 当前会话选择、会话模型及思考强度继续保存为 durable 状态。修改默认配置只影响
  新会话；切换模型、思考强度则修改当前会话。
- 未来计划、todo、决策、测试结果及交接包的权威状态也是 durable 文档。
  `exports` 是按需生成的可阅读副本，模型续接任务时读取权威状态。

settings.json 格式（属于 pipi 的应用配置）：

```json
{
  "version": 1,
  "defaultProfile": "main",
  "profiles": {
    "main": {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "thinking": "high"
    }
  }
}
```

模型和思考强度的默认值只影响新会话。`/new` 使用当前 defaultProfile；未设置默认预设时
沿用上一会话的模型选择，首个会话选择第一个可用模型。修改配置后使用 `/reload`。
settings.json 还支持 compaction、retry 和 stream 设置；模型 request 默认值通过供应商
包装实际传给 pi-ai。具体格式见 [模型配置](model-config.md)。

## 启动与切换工作区

1. 通过启动参数 `--workspaces` 或 `PI_PILOT_WORKSPACES` 定位工作区；均未指定时用启动 cwd。
2. 从第一个工作区的 `pi-pilot/config` 读取进程启动配置，创建 Telegram 接入。
3. 每个工作区分别构造自己的模型配置、凭据视图和 durable 存储。
4. `/workspaces` 切换工作区时切换模型集合和数据路径；同一机器人进程的 token、允许用户
   等进程配置保持启动时的值。其他工作区的这些启动字段不用于替换正在运行的机器人。
5. 每条输入及附件在接收/准入阶段绑定工作区，后续处理沿用绑定，避免切换后归到另一目录。

启动参数覆盖进程环境，进程环境覆盖工作区 .env，同名默认项再来自 settings.json。
供应商凭据解析遵循 pi-ai 认证机制：存储凭据优先，其次环境变量；models.json 的显式
apiKey 则覆盖该供应商的认证方式。
工作区 .env 解析到配置/认证上下文，不通过修改全局 process.env 来切换供应商。
重载先校验并构造完整配置，成功后在安全边界替换；失败保持当前可用配置并报告具体错误。

PI_PILOT_MODEL、PI_PILOT_DATA_DIR 以及对应 CLI 选项已移除。
不提供全局/工作区配置继承规则。

## 附件与临时文件

附件使用不可重复的接收标识组织，例如 `attachments/<receipt-id>/<safe-name>`。
下载先进入 tmp，成功后移动到 attachments，再把稳定路径交给模型。附件在重启及
压缩后仍然可读；第一版不自动删除。后续删除需要检查历史及任务引用。
身份标识、原名和路径等元数据可记入 durable 文档，不额外维护一份独立 JSON 索引。

## 旧测试数据

旧存储：
`D:/Project/workspace/pi-pilot-durable/.pi-pilot-data/workspaces/47b41948aad6fbef1aa10bcc/`。

新运行时直接使用新目录，不自动迁移或读取旧存储。当前测试环境的凭据和启动字段
转入 `pi-pilot/config/.env`，默认模型转入 settings.json；旧数据保留。
如需人工迁移，必须停止进程，将完整存储复制到尚未初始化的 sessions，不合并 JSONL。

旧会话中的绝对 cwd 和附件引用不因目录迁移而自动重写。当前方案迁移存储位置，
测试工作区路径保持不变；后续移动整个项目时需要单独处理路径引用。

迁移验证覆盖：恢复当前及其他聊天、模型和思考强度选择、重启恢复、工作区隔离，
以及附件稳定路径和配置重载失败后继续可用。
