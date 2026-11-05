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
fs.cpSync(path.join(extension, "test", "store"), workspace, { recursive: true });

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
