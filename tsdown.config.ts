// dsh-wing client 打包配置（tsdown / rolldown）。
// host 半用 tsc 编译（src → dist/index.js，npm run build）；
// client 半单独打包成 DSH ModuleLoader closure-factory 格式
// （window.__ModuleLoader__.load），供 dsh-client-modules 发现并 serve
// `/plugins/dsh-wing/client.js`。对照 dsh-lark-link 的 client 打包。
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { client: "src/client/index.ts" },
    outDir: "dist",
    format: ["cjs"],
    platform: "browser",
    target: "es2024",
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: [/^@deepseek-ai\//, "react", "react-dom"] },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: "dsh-wing", factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
