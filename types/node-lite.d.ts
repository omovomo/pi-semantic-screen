declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  cwd(): string;
};

declare module "node:child_process" {
  interface ChildStream {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
  }
  interface ChildStdin {
    end(data?: string, encoding?: string): void;
  }
  interface ChildProcess {
    stdout: ChildStream;
    stderr: ChildStream;
    stdin: ChildStdin;
    kill(): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
  }
  export function spawn(
    command: string,
    args?: string[],
    options?: Record<string, unknown>,
  ): ChildProcess;
}

declare module "node:url" {
  export function fileURLToPath(url: URL): string;
}
