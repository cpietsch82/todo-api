import { BaseModule } from "../core/BaseModule";
import packageJson from "../../../package.json";

export class VersionService extends BaseModule {
    public static instance: VersionService;

    constructor() {
        super("version.service", "Service to look up the current version of the API")
    
        if (!VersionService.instance) {
            VersionService.instance = this
        }

        return VersionService.instance
    }

    getVersionInfo = () => ({
        name: packageJson.name,
        version: packageJson.version,
        environment: process.env.APP_STAGE ?? "development",
        commit: process.env.APP_COMMIT ?? "unknown",
    });

}
