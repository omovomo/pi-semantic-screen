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

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
}

declare module "node:path" {
  export const sep: string;
  export function resolve(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function join(...paths: string[]): string;
  export function basename(path: string): string;
}
