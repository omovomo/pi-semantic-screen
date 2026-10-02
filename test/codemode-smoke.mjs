import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.error("SKIP: pi executable is not installed in this environment; Code Mode live smoke requires the host Pi runtime.");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "pi-semantic-screen-codemode-"));
try {
  const settings = {
    defaultTools: ["codemode"],
    codemode: { mode: "only" },
    packages: [root],
  };
  writeFileSync(join(temp, "settings.json"), JSON.stringify(settings, null, 2));
  console.error(
    "Host Pi found. This smoke script intentionally does not invoke a paid/chat model automatically. " +
      "Start Pi with this package, codemode.mode=only, and call screen_preflight({count:201}); " +
      "the expected structured result is status=approval_required, projectedCalls=201, with zero classifier calls and no candidate payload.",
  );
  process.exit(0);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
