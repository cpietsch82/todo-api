import type { CommandOptions, CommandResult, CommandRunner } from "../CommandRunner";

export interface RecordedCall {
  args: string[];
  /** the API_IMAGE_TAG the command got in its environment */
  apiTag: string | undefined;
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: "", stderr, timedOut: false });

/**
 * Simulates the docker commands of the updater for the tests: which tags can be pulled, which versions become healthy,
 * which container is running.
 */
export class FakeDocker implements CommandRunner {
  calls: RecordedCall[] = [];
  /** tags that do not exist on the registry */
  missingTags = new Set<string>();
  /** versions whose container becomes unhealthy */
  unhealthyTags = new Set<string>();
  /** versions whose container exits right after the start */
  crashingTags = new Set<string>();
  /** versions whose image has no healthcheck */
  withoutHealthcheck = new Set<string>();
  failRestart = false;
  runningTag: string | undefined;
  /** what "docker compose ps --all --format json" reports (one JSON object per line, like compose v2.21+ and v5) */
  containers: Record<string, unknown>[] = [
    {
      Command: '"docker-entrypoint.s…"',
      ExitCode: 0,
      Health: "healthy",
      Image: "postgres:16-alpine",
      Labels: "com.docker.compose.project.working_dir=/volume1/docker/todo-api,com.docker.compose.service=postgres",
      Name: "todo-database",
      Service: "postgres",
      State: "running",
      Status: "Up 2 hours (healthy)",
    },
    {
      ExitCode: 0,
      Health: "",
      Image: "ghcr.io/cpietsch82/todo-api-updater:0.0.4",
      Name: "todo-updater",
      Service: "updater",
      State: "running",
      Status: "Up 2 hours",
    },
  ];
  /** the logs per service as docker writes them: what the container printed to stdout and to stderr */
  serviceLogs: Record<string, { stdout: string; stderr: string }> = {};
  private startedAt = new Date().toISOString();

  constructor(runningTag?: string) {
    this.runningTag = runningTag;
  }

  async run(_command: string, args: readonly string[], { env }: CommandOptions): Promise<CommandResult> {
    const apiTag = env.API_IMAGE_TAG;
    this.calls.push({ args: [...args], apiTag });

    if (args[0] === "inspect") return ok(JSON.stringify(this.state()));

    // the arguments after the global options "compose --project-directory x -f y --env-file z"
    const command = args.slice(args.indexOf("--env-file") + 2);
    switch (command[0]) {
      case "pull":
        return apiTag && this.missingTags.has(apiTag) ? fail(`manifest for todo-api:${apiTag} not found`) : ok(`pulled ${apiTag}`);
      case "up":
        this.runningTag = apiTag;
        this.startedAt = new Date().toISOString();
        return ok(`started ${apiTag}`);
      case "restart":
        if (this.failRestart) return fail("restart failed");
        this.startedAt = new Date().toISOString();
        return ok("restarted");
      case "ps":
        if (command.includes("--all")) return ok(this.containers.map((container) => JSON.stringify(container)).join("\n"));
        return ok(this.runningTag ? "c0ffee\n" : "");
      case "logs": {
        const service = command[command.length - 1];
        const logs = this.serviceLogs[service];
        return logs
          ? { exitCode: 0, stdout: logs.stdout, stderr: logs.stderr, timedOut: false }
          : fail(`no such service: ${service}`);
      }
      default:
        return fail(`unexpected command ${command.join(" ")}`);
    }
  }

  /** the compose sub commands in the order they were run, e.g. ["pull api", "up -d --no-deps api"] */
  composeCommands(): string[] {
    return this.calls
      .filter((call) => call.args[0] === "compose")
      .map((call) => call.args.slice(call.args.indexOf("--env-file") + 2).join(" "))
      .filter((command) => !command.startsWith("ps") && !command.startsWith("logs"));
  }

  private state() {
    const tag = this.runningTag ?? "";
    if (this.crashingTags.has(tag)) return { Status: "exited", StartedAt: this.startedAt };
    if (this.withoutHealthcheck.has(tag)) return { Status: "running", StartedAt: this.startedAt };
    return {
      Status: "running",
      StartedAt: this.startedAt,
      Health: { Status: this.unhealthyTags.has(tag) ? "unhealthy" : "healthy" },
    };
  }
}
