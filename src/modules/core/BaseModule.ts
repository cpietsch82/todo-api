import { logger } from "@/utils/logger";

export abstract class BaseModule {
  private readonly moduleId;
  public description;
  protected logger;

  constructor(moduleId: string, description: string) {
    // TODO: add name maybe!?
    this.moduleId = moduleId;
    this.description = description;

    this.logger = logger;
  }

  getModuleId() {
    return this.moduleId;
  }
}
