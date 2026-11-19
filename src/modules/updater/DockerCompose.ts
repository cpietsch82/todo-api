import path from "node:path";
import type { CommandResult, CommandRunner } from "./CommandRunner";
import { RELEASE_TAG_PATTERN } from "@/modules/admin/DeploymentService";
import { MAX_LOG_TAIL, SERVICE_NAME_PATTERN } from "@/modules/admin/ContainerService";

// the only service the updater ever changes; postgres and the updater itself are never touched
export const API_SERVICE = "api";
export const COMPOSE_FILE_NAME = "docker-compose.yml";
export const DEPLOY_ENV_FILE_NAME = "deploy.env";

// variables of the compose file that must only come from deploy.env (or explicitly from the updater)
const TAG_VARIABLES = ["API_IMAGE_TAG", "UPDATER_IMAGE_TAG", "FRONTEND_IMAGE_TAG"];

export interface DockerComposeConfig {
  /** absolute path, the same as on the host, so the relative bind mounts of the compose file stay correct */
  projectDir: string;
  commandTimeoutMs: number;
}

/** the state of a container as docker inspect reports it (only the fields the updater needs) */
export interface ContainerState {
  Status: string;
  StartedAt?: string;
  Health?: { Status: string };
}

export interface CommandStep {
  /** the command line for the output of the operation */
  command: string;
  /** short name for error messages, e.g. "docker compose pull api" (without the long project paths) */
  label: string;
  result: CommandResult;
}

export const isSuccess = (step: CommandStep) => step.result.exitCode === 0 && !step.result.timedOut;

/** a container as "docker compose ps --format json" reports it (only the fields that are used) */
export interface ComposeContainer {
  Service: string;
  Name: string;
  Image: string;
  State: string;
  Health: string;
  Status: string;
  ExitCode: number;
}

/**
 * Parses the output of "docker compose ps --format json": one JSON object per line (current versions) or one JSON
 * array (older versions of compose v2).
 */
export function parseComposePs(stdout: string): ComposeContainer[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text) as ComposeContainer[];
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposeContainer);
}

// "2026-11-18T12:31:34.092411883Z ..." - docker cuts trailing zeros of the fraction, so it is padded for sorting
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z/;

/**
 * Docker writes what a container printed to stdout to its own stdout and stderr to stderr. With --timestamps both
 * can be merged into one log in the right order. A line without a timestamp stays behind the line before it.
 */
export function mergeLogStreams(stdout: string, stderr: string): string {
  const keyed: { key: string; index: number; line: string }[] = [];
  let index = 0;

  for (const stream of [stdout, stderr]) {
    let lastKey = "";
    for (const line of stream.split("\n")) {
      if (!line.trim()) continue;
      const match = TIMESTAMP.exec(line);
      if (match) lastKey = `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}`;
      keyed.push({ key: lastKey, index: index++, line });
    }
  }

  return keyed
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1))
    .map((entry) => entry.line)
    .join("\n");
}

/**
 * A fixed set of docker compose commands for the api service. There is no way to run any other command.
 */
export class DockerCompose {
  constructor(
    private readonly runner: CommandRunner,
    private readonly config: DockerComposeConfig,
  ) {}

  /** pulls the api image of the given version without changing the running container */
  pull(tag: string): Promise<CommandStep> {
    return this.compose(["pull", API_SERVICE], tag);
  }

  /** (re)creates only the api container with the given version */
  up(tag: string): Promise<CommandStep> {
    return this.compose(["up", "-d", "--no-deps", API_SERVICE], tag);
  }

  /** restarts the api container with its current version */
  restart(): Promise<CommandStep> {
    return this.compose(["restart", API_SERVICE]);
  }

  /** all containers of the compose project, also stopped ones */
  async listContainers(): Promise<ComposeContainer[]> {
    const step = await this.compose(["ps", "--all", "--format", "json"]);
    if (!isSuccess(step)) {
      throw new Error(`${step.label} failed: ${step.result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
    }
    return parseComposePs(step.result.stdout);
  }

  /** the last lines of the log of one service of the compose project, read only */
  async logs(service: string, tail: number): Promise<CommandStep> {
    if (!SERVICE_NAME_PATTERN.test(service)) throw new Error(`Refusing to read the logs of ${JSON.stringify(service)}`);
    if (!Number.isInteger(tail) || tail < 1 || tail > MAX_LOG_TAIL) throw new Error(`Refusing the tail ${tail}`);

    return this.compose(["logs", "--no-color", "--no-log-prefix", "--timestamps", "--tail", String(tail), service]);
  }

  /** the state of the api container, undefined when there is none */
  async getApiState(): Promise<ContainerState | undefined> {
    const ps = await this.compose(["ps", "-q", API_SERVICE]);
    const containerId = ps.result.stdout.trim().split("\n")[0];
    if (!isSuccess(ps) || !containerId) return undefined;

    const inspect = await this.run(["inspect", "--format", "{{json .State}}", containerId]);
    if (!isSuccess(inspect)) return undefined;

    try {
      return JSON.parse(inspect.result.stdout) as ContainerState;
    } catch {
      return undefined;
    }
  }

  private async compose(args: string[], apiTag?: string): Promise<CommandStep> {
    if (apiTag !== undefined && !RELEASE_TAG_PATTERN.test(apiTag)) {
      throw new Error(`Refusing to use the invalid tag ${JSON.stringify(apiTag)}`);
    }

    const { projectDir } = this.config;
    return this.run(
      [
        "compose",
        "--project-directory",
        projectDir,
        "-f",
        path.join(projectDir, COMPOSE_FILE_NAME),
        "--env-file",
        path.join(projectDir, DEPLOY_ENV_FILE_NAME),
        ...args,
      ],
      apiTag,
      `docker compose ${args.join(" ")}`,
    );
  }

  private async run(args: string[], apiTag?: string, label = `docker ${args.join(" ")}`): Promise<CommandStep> {
    // A tag variable in the environment would win over deploy.env, so it is removed and only the explicit tag is set.
    const env = { ...process.env };
    for (const variable of TAG_VARIABLES) delete env[variable];
    if (apiTag !== undefined) env.API_IMAGE_TAG = apiTag;

    const result = await this.runner.run("docker", args, { env, timeoutMs: this.config.commandTimeoutMs });
    return { command: `docker ${args.join(" ")}`, label, result };
  }
}
