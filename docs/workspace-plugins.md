# 工作区插件

插件放在 `<workspace>/.pi-pilot/extensions/`，每个入口默认导出一个 durable
Extension 对象。目录由应用初始化创建，属于工作区数据，默认忽略 Git。

```text
.pi-pilot/
├── config/
├── sessions/
├── extensions/
│   ├── hello.ts
│   ├── .disabled.ts       # 点开头的入口不加载
│   └── project-state/
│       ├── index.ts
│       ├── helpers.ts
│       └── assets/
├── skills/
└── tmp/
```

## 加载约定

- 支持直接入口 `.ts`、`.js`、`.mjs`。
- 支持一层插件目录中的 `index.ts`、`index.js`、`index.mjs`，按这个顺序选取首个存在的入口。
- 按顶层文件/目录名排序加载；忽略点开头的项和 node_modules。
- 目录中的辅助文件不会单独注册；顶层的代码文件都会作为入口，因此辅助代码请放在插件目录里。
- 必须默认导出具名 Extension；不支持旧 coding-agent 的 ExtensionAPI 工厂。
- 不同插件的 Extension 名称必须唯一，不能占用内置扩展的名称。工具和提示词包装可通过 durable 的 wraps 实现；同名工具的覆盖遵循 durable 的安装顺序。
- 插件默认适用于这个工作区的所有普通会话。显式选择了扩展列表的自定义会话仍遵循 durable 的扩展选择规则。

## 示例

把仓库的 `examples/extensions/hello.ts` 复制到工作区 `.pi-pilot/extensions/hello.ts`：

```typescript
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default defineExtension({
  name: "hello",
  tools: [
    defineTool({
      name: "say_hello",
      description: "向指定的人打招呼",
      parameters: Type.Object({ name: Type.String() }),
      replay: "safe",
      execute: async ({ name }) => ({
        content: [{ type: "text", text: `你好，${name}！` }],
      }),
    }),
  ],
});
```

在 Telegram 发送 `/reload`，再发送 `/plugins`，应能看到 hello 和 say_hello。
然后发送“调用 say_hello，名字是张三”。`/status` 的工具列表也会包含这个工具。

## 依赖与文件

应用提供自身安装的 `@earendil-works/pi-durable`、`@earendil-works/pi-ai`、
`@earendil-works/chord` 和 `typebox`，包含这些包的子路径。工作区不用再安装一套
pi 包；插件和宿主使用同一份模块。

插件的相对代码依赖会编译进每次加载的新 bundle，因此修改 helpers.ts 后
`/reload` 也会读取新代码。`import.meta.dir`、`dirname`、`path`、`filename`、
`file` 和 `url` 保留相应源文件的位置，可以据此读取插件自己的 assets。
其他 npm 依赖需要在插件目录或其父目录的 node_modules 中可解析，加载器不会自动安装。
它们按安装位置导入并遵循运行时缓存；更新这些外部包后应重启机器人。
使用变量拼接的动态本地 import 不在重载约定内；本地依赖请用静态 import 或
`import("./literal-path.ts")`。

临时编译产物位于 `.pi-pilot/tmp/extensions-*`，正常重载、切换工作区或退出时清理。
插件是当前 Bun 进程内的普通代码，模块顶层应只声明扩展，把业务执行放在工具或
任务中。导入时启动的连接/定时器不属于加载器的生命周期，导入副作用不能随失败回滚。

## 重载与状态

启动、工作区切换和 `/reload` 都会构建完整的插件 Registry。加载器先编译、
导入、校验并注册全部入口，成功后才关闭旧运行时并重新打开当前会话。
语法错误、导入失败、缺少默认导出、重复名称或无效定义会报告入口路径，并保留
当前运行时及其已加载的插件代码。忙碌时需先等待任务完成或 `/stop`。

新增、修改或删除入口后使用 `/reload`；隐藏入口可通过把文件/目录名改为点开头实现。
插件删除后，后续请求不再提供它的工具和提示词；durable 会话及插件文档仍然保留。
重新添加相同定义可以读取原有状态。需要恢复的自定义持久任务，应保留对应 Extension
和任务名称，重启后重新安装这些定义。

工具内通过 `defineDoc()` 定义状态，再通过 `api.commit()` 的事务读写，数据与会话
一起保存在 `.pi-pilot/sessions`。不需要为每个插件额外创建一套聊天存储。
Telegram 命令和按钮的注册暂时仍在应用层，Extension 不会自动增加聊天命令。
