# 工作区模型配置

配置目录为 `<workspace>/.pi-pilot/config/`。内置供应商与目录来自 pi-ai；pipi
通过自己的配置适配层构造 Models 并注入 durable，不依赖 pi-coding-agent。

## models.json

`{"providers": {}}` 即可使用内置供应商。已有供应商只写覆盖项：

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "env:DEEPSEEK_API_KEY",
      "modelOverrides": {
        "deepseek-flash": { "request": { "maxTokens": 8192 } }
      }
    }
  }
}
```

新增兼容接口：

```json
{
  "providers": {
    "my-proxy": {
      "name": "My proxy",
      "api": "openai-completions",
      "baseUrl": "https://example.com/v1",
      "apiKey": "env:MY_PROXY_KEY",
      "headers": { "X-Account": "env:MY_ACCOUNT" },
      "models": [
        {
          "id": "my-model",
          "reasoning": false,
          "contextWindow": 32768,
          "maxTokens": 4096,
          "samplingParams": { "top_p": 0.9 },
          "request": { "temperature": 0.2, "maxTokens": 2048 }
        }
      ]
    }
  }
}
```

MY_PROXY_KEY、MY_ACCOUNT 放在 config/.env 或进程环境中。apiKey 与 headers 支持
字面字符串及 `env:NAME`，不执行 shell 命令。缺失引用在加载时报错，消息不包含凭据值。

| 范围         | 支持字段                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 供应商       | name、api、baseUrl、apiKey、keyless、headers、compat、request、models、modelOverrides                                            |
| 模型与覆盖项 | name、api、baseUrl、reasoning、thinkingLevelMap、input、cost、contextWindow、maxTokens、samplingParams、headers、compat、request |
| 新模型       | 另需 id；api/baseUrl 可继承供应商；contextWindow/maxTokens 必须提供                                                              |
| request      | temperature、maxTokens                                                                                                           |

新增供应商支持 openai-completions、openai-responses、anthropic-messages。无需认证的
本地接口指定 keyless: true。未改 API 的内置供应商使用其原生实现与认证。
models 合并进原目录；modelOverrides 只覆盖已知模型。不认识的字段、未知覆盖目标、
不支持的自定义 API、错误默认预设和不支持的思考强度会报错。

request 模型值覆盖供应商值；显式调用参数优先，尤其压缩任务自己的摘要 token 预算。
请求输出上限不超过模型 maxTokens。samplingParams 由 OpenAI 兼容适配器透传；
其他 API 不应配置这些参数。未指定 cost 时为零，仅表示没有价格配置，并非实际免费。

compat 支持常用 OpenAI 兼容项：supportsStore、supportsDeveloperRole、
supportsReasoningEffort、supportsUsageInStreaming、supportsFinishReason、maxTokensField、
requiresToolResultName、requiresAssistantAfterToolResult、requiresThinkingAsText、
requiresReasoningContentOnAssistantMessages、supportsStrictMode、supportsLongCacheRetention、
supportsMaxOutputTokens、sendSessionAffinityHeaders、sessionAffinityFormat、thinkingFormat。
具体效果取决于选用的 API 实现，非对应 API 的选项不作为通用能力。

## 凭据

环境变量可以放在 config/.env，或者使用 config/auth.json：

```json
{
  "deepseek": { "type": "api_key", "key": "your-key" }
}
```

auth.json 可省略或为 `{}`。内置供应商及未显式设置 apiKey 的自定义供应商遵循 pi-ai：
文件凭据优先，再读取环境变量。models.json 的显式 apiKey 覆盖该供应商的认证方式；
如果需要 auth.json，删除显式 apiKey 项。文件凭据的 key 是字面值，不解析 env: 引用。
工作区 .env 的同名值被进程环境覆盖，各工作区的读取不会修改 process.env。

配置变更通过 `/reload` 生效。已有有效运行时保留自己的凭据快照；文件修改错误不会
破坏它。pi-ai 的凭据修改/刷新通过进程内串行写入、临时文件、fsync 与 rename 完成，
并同步该文件的活动凭据视图。每个存储只由一个机器人进程持有。
已有 OAuth 凭据可以由 pi-ai 刷新；当前没有交互登录菜单或动态模型目录持久化。

## 模型预设与运行参数

```json
{
  "version": 1,
  "defaultProfile": "main",
  "profiles": {
    "main": {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "thinking": "off"
    },
    "review": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "thinking": "high"
    }
  },
  "logLevel": "info",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "backgroundTokens": 32768
  },
  "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 },
  "stream": { "timeoutMs": 600000, "cacheRetention": "short" }
}
```

`/profile` 查看预设；`/profile review` 原子切换当前会话的模型与思考强度。
`/models`、`/thinking` 仍可分别选择。会话选择保存在 durable，重启与重载后保留。
defaultProfile 只决定新会话的初始值；未设置时沿用上一会话选择，首个会话选第一个
可用模型。预设并不自动创建子 agent。

compaction/retry/stream 参数直接传给 durable；重载后应用于后续任务。
logLevel 为进程启动设置，修改后需要重启进程。Telegram token 与允许用户同样是启动
设置，不随模型重载或工作区切换改变。

settings.json、models.json 使用严格 JSON，不接受注释。项目提供 `examples/config/`
可复制的起始配置与本地兼容接口示例。
