import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default defineExtension({
  name: "hello",
  tools: [
    defineTool({
      name: "say_hello",
      description: "向指定的人打招呼，用于验证工作区插件已经加载。",
      parameters: Type.Object({ name: Type.String() }),
      replay: "safe",
      execute: async ({ name }) => ({
        content: [{ type: "text", text: `你好，${name}！工作区插件已加载。` }],
      }),
    }),
  ],
});
