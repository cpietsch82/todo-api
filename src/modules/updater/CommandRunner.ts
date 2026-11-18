import { spawn } from "node:child_process";

export interface CommandResult {
  /** null when the command could not be started or was killed */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** runs a command, an interface so the updater can be tested without docker */
export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

// only the end of the output is needed, this keeps a chatty command from filling the memory
const MAX_CAPTURED_OUTPUT = 200_000;
const keepTail = (text: string) => (text.length > MAX_CAPTURED_OUTPUT ? text.slice(-MAX_CAPTURED_OUTPUT) : text);

/**
 * Runs commands as child processes WITHOUT a shell: the arguments are passed to the program as they are, so a value
 * like "1.2.3; rm -rf /" is one argument and never a second command.
 */
export class ProcessCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], { env, timeoutMs }: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn(command, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => (stdout = keepTail(stdout + chunk.toString())));
      child.stderr.on("data", (chunk: Buffer) => (stderr = keepTail(stderr + chunk.toString())));

      // e.g. the program does not exist; "close" may follow, the promise only takes the first result
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      });
    });
  }
}
