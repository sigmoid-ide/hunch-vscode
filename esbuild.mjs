// Bundles the extension (Node, CommonJS for VS Code) and the Runs view's script (browser).
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, sourcemap: true, minify: !watch, logLevel: "info" };

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", platform: "node", format: "cjs", target: "node18", external: ["vscode"] },
  { ...common, entryPoints: ["src/webview/main.ts"], outfile: "dist/runs.js", platform: "browser", format: "iife", target: "es2020" },
  { ...common, entryPoints: ["test/integration/suite.ts"], outfile: "dist/integration.cjs", platform: "node", format: "cjs", target: "node18", external: ["vscode"] },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
