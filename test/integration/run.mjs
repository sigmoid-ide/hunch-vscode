// Runs the integration suite inside a real VS Code, on a copy of test/store.
// Uses the VS Code at $VSCODE_EXECUTABLE when set (no download), else downloads stable.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, "..", "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hunch-it-"));
// HUNCH_TEST_WORKSPACE picks another project, such as the demo for screenshots.
fs.cpSync(process.env.HUNCH_TEST_WORKSPACE || path.join(extension, "test", "store"), workspace, { recursive: true });
// With a Python that has Hunch, the suite also runs a script and saves a milestone.
if (process.env.HUNCH_TEST_PYTHON) {
  fs.mkdirSync(path.join(workspace, ".vscode"));
  fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({ "hunch.interpreter": process.env.HUNCH_TEST_PYTHON }, null, 2));
}

try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(extension, "dist", "integration.cjs"),
    // Its own profile, so it runs beside any VS Code already open.
    launchArgs: [
      workspace,
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "hunch-it-profile-"))}`,
      `--extensions-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "hunch-it-extensions-"))}`,
      "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
    ],
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
