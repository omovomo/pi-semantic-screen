import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_STDOUT = 24 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 1024 * 1024;

type CommandSpec = { command: string; args: string[] };

function pythonCommands(): CommandSpec[] {
  const override = process.env.PI_SEMANTIC_SCREEN_PYTHON?.trim();
  if (override) return [{ command: override, args: ["-X", "utf8"] }];
  if (process.platform === "win32") {
    return [
      { command: "python", args: ["-X", "utf8"] },
      { command: "py", args: ["-3", "-X", "utf8"] },
      { command: "python3", args: ["-X", "utf8"] },
    ];
  }
  return [
    { command: "python3", args: ["-X", "utf8"] },
    { command: "python", args: ["-X", "utf8"] },
  ];
}

async function runAttempt(
  spec: CommandSpec,
  scriptPath: string,
  payload: string,
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args, scriptPath], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value ?? "");
    };

    const onAbort = () => {
      child.kill();
      finish(new DOMException("Aborted", "AbortError"));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > DEFAULT_MAX_STDOUT) {
        child.kill();
        finish(new Error(`python adapter stdout exceeded ${DEFAULT_MAX_STDOUT} bytes`));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < DEFAULT_MAX_STDERR) stderr += chunk;
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`python adapter exited with code ${code}: ${stderr.trim().slice(0, 2000)}`));
        return;
      }
      finish(undefined, stdout);
    });

    child.stdin.end(payload, "utf8");
  });
}

export async function runPythonJson<TRequest, TResult>(
  scriptUrl: URL,
  request: TRequest,
  signal?: AbortSignal,
): Promise<TResult> {
  const scriptPath = fileURLToPath(scriptUrl);
  const payload = JSON.stringify(request);
  let lastMissing: Error | undefined;

  for (const spec of pythonCommands()) {
    try {
      const stdout = await runAttempt(spec, scriptPath, payload, signal);
      const trimmed = stdout.trim();
      if (!trimmed) throw new Error("python adapter returned empty stdout");
      try {
        return JSON.parse(trimmed) as TResult;
      } catch (error) {
        throw new Error(`python adapter returned invalid JSON: ${String(error)}`);
      }
    } catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") {
        lastMissing = error as Error;
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `no usable Python interpreter found${lastMissing ? `: ${lastMissing.message}` : ""}; set PI_SEMANTIC_SCREEN_PYTHON`,
  );
}
