import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockerCompose } from "@modules/updater/DockerCompose";
import { DeployEnvFile } from "@modules/updater/DeployEnvFile";
import { ProcessCommandRunner } from "@modules/updater/CommandRunner";
import { FakeDocker } from "./FakeDocker";

describe("DockerCompose", () => {
  const projectDir = "/volume1/docker/todo-api";
  const compose = (docker: FakeDocker) => new DockerCompose(docker, { projectDir, commandTimeoutMs: 1000 });

  afterEach(() => {
    delete process.env.API_IMAGE_TAG;
    delete process.env.UPDATER_IMAGE_TAG;
  });

  it("should always use the compose file and deploy.env of the project folder", async () => {
    const docker = new FakeDocker();

    await compose(docker).pull("0.0.3");

    expect(docker.calls[0].args).toEqual([
      "compose",
      "--project-directory",
      projectDir,
      "-f",
      "/volume1/docker/todo-api/docker-compose.yml",
      "--env-file",
      "/volume1/docker/todo-api/deploy.env",
      "pull",
      "api",
    ]);
  });

  it("should only touch the service api", async () => {
    const docker = new FakeDocker("0.0.1");
    const subject = compose(docker);

    await subject.pull("0.0.3");
    await subject.up("0.0.3");
    await subject.restart();

    expect(docker.composeCommands()).toEqual(["pull api", "up -d --no-deps api", "restart api"]);
  });

  it("should ignore tag variables of its own environment, deploy.env or the explicit tag decide", async () => {
    // e.g. an old API_IMAGE_TAG line in .env.api, which the updater container gets as environment
    process.env.API_IMAGE_TAG = "0.0.1";
    process.env.UPDATER_IMAGE_TAG = "0.0.1";
    const docker = new FakeDocker("0.0.1");

    await compose(docker).restart();
    await compose(docker).up("0.0.3");

    expect(docker.calls[0].apiTag).toBeUndefined();
    expect(docker.calls[1].apiTag).toBe("0.0.3");
  });

  it.each(["latest", "0.0.3; docker rm -f todo-database", ""])("should refuse the tag %j", async (tag) => {
    const docker = new FakeDocker();

    await expect(compose(docker).up(tag)).rejects.toThrow("Refusing to use the invalid tag");
    expect(docker.calls).toHaveLength(0);
  });

  it("should read the state of the api container", async () => {
    const docker = new FakeDocker("0.0.1");

    const state = await compose(docker).getApiState();

    expect(state).toMatchObject({ Status: "running", Health: { Status: "healthy" } });
    expect(docker.calls[1].args.slice(0, 3)).toEqual(["inspect", "--format", "{{json .State}}"]);
  });

  it("should return no state when there is no api container", async () => {
    expect(await compose(new FakeDocker()).getApiState()).toBeUndefined();
  });
});

describe("DeployEnvFile", () => {
  let directory: string;
  const file = () => new DeployEnvFile(path.join(directory, "deploy.env"));

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("should read the api tag, also with quotes and spaces", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-env-"));
    fs.writeFileSync(path.join(directory, "deploy.env"), '# comment\nUPDATER_IMAGE_TAG=0.0.4\n API_IMAGE_TAG = "0.0.2"\n');

    expect(await file().readApiTag()).toBe("0.0.2");
  });

  it("should return undefined when the file or the line is missing", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-env-"));

    expect(await file().readApiTag()).toBeUndefined();
    fs.writeFileSync(path.join(directory, "deploy.env"), "UPDATER_IMAGE_TAG=0.0.4\n");
    expect(await file().readApiTag()).toBeUndefined();
  });

  it("should replace only the api line and keep comments and other variables", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-env-"));
    fs.writeFileSync(path.join(directory, "deploy.env"), "# versions\nAPI_IMAGE_TAG=0.0.1\nUPDATER_IMAGE_TAG=0.0.4\n");

    await file().writeApiTag("0.0.3");

    expect(fs.readFileSync(path.join(directory, "deploy.env"), "utf8")).toBe(
      "# versions\nAPI_IMAGE_TAG=0.0.3\nUPDATER_IMAGE_TAG=0.0.4\n",
    );
    expect(fs.existsSync(path.join(directory, "deploy.env.tmp"))).toBe(false);
  });

  it("should add the api line when it is missing", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-env-"));
    fs.writeFileSync(path.join(directory, "deploy.env"), "UPDATER_IMAGE_TAG=0.0.4\n");

    await file().writeApiTag("0.0.3");

    expect(fs.readFileSync(path.join(directory, "deploy.env"), "utf8")).toBe("UPDATER_IMAGE_TAG=0.0.4\nAPI_IMAGE_TAG=0.0.3\n");
  });

  it("should refuse to write an invalid tag", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-env-"));

    await expect(file().writeApiTag("0.0.3\nEVIL=1")).rejects.toThrow("Refusing to write the invalid tag");
    expect(fs.existsSync(path.join(directory, "deploy.env"))).toBe(false);
  });
});

describe("ProcessCommandRunner", () => {
  const runner = new ProcessCommandRunner();
  const node = process.execPath;

  it("should return exit code and output", async () => {
    const result = await runner.run(node, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], {
      env: process.env,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("should pass an argument as it is and never run it through a shell", async () => {
    const result = await runner.run(node, ["-e", "console.log(process.argv[1])", "1.2.3; echo injected"], {
      env: process.env,
      timeoutMs: 5000,
    });

    expect(result.stdout).toBe("1.2.3; echo injected\n");
  });

  it("should stop a command that runs too long", async () => {
    const result = await runner.run(node, ["-e", "setTimeout(() => {}, 60000)"], { env: process.env, timeoutMs: 200 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("should report a program that does not exist", async () => {
    const result = await runner.run("this-program-does-not-exist", [], { env: process.env, timeoutMs: 5000 });

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("ENOENT");
  });
});
