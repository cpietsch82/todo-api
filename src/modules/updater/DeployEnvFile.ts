import fs from "node:fs/promises";
import { RELEASE_TAG_PATTERN } from "@/modules/admin/DeploymentService";

export const API_TAG_KEY = "API_IMAGE_TAG";

const API_TAG_LINE = new RegExp(`^\\s*${API_TAG_KEY}\\s*=(.*)$`);

/**
 * The file deploy.env next to docker-compose.yml. It holds the version of the api (API_IMAGE_TAG, written by the
 * updater) and the version of the updater itself (UPDATER_IMAGE_TAG, only changed by hand). Only the api line is
 * ever changed here, every other line is kept as it is.
 */
export class DeployEnvFile {
  constructor(public readonly path: string) {}

  async readApiTag(): Promise<string | undefined> {
    const content = await this.readContent();
    if (content === undefined) return undefined;

    for (const line of content.split("\n")) {
      const match = API_TAG_LINE.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "") || undefined;
    }
    return undefined;
  }

  /**
   * Replaces (or adds) the api tag. The new content is written to a temporary file that replaces the old one in one
   * step, so a crash never leaves a half written file behind.
   */
  async writeApiTag(tag: string): Promise<void> {
    if (!RELEASE_TAG_PATTERN.test(tag)) throw new Error(`Refusing to write the invalid tag ${JSON.stringify(tag)}`);

    const lines = (await this.readContent())?.replace(/\n$/, "").split("\n") ?? [];
    const newLine = `${API_TAG_KEY}=${tag}`;
    const index = lines.findIndex((line) => API_TAG_LINE.test(line));
    if (index === -1) lines.push(newLine);
    else lines[index] = newLine;

    const temporaryPath = `${this.path}.tmp`;
    await fs.writeFile(temporaryPath, `${lines.join("\n")}\n`, "utf8");
    await fs.rename(temporaryPath, this.path);
  }

  private async readContent(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
