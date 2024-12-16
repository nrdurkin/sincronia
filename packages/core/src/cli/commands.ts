import { Sinc } from "@sincronia/types";
import { ConfigManager } from "../configs/config";
import { startWatching } from "./Watcher";
import * as AppUtils from "../appUtils";
import { startWizard } from "./wizard";
import { logger } from "./Logger";
import {
  scopeCheckMessage,
  devModeLog,
  logPushResults,
  logBuildResults,
} from "./logMessages";
import inquirer from "inquirer";
import { gitDiffToEncodedPaths } from "../utils/gitUtils";
import { encodedPathsToFilePaths } from "../utils/fileUtils";
import { getCurrentScope } from "../services/serviceNow";
import { fetchManifest, processManifest } from "../utils/processManifest";

async function scopeCheck(successFunc: () => void, swapScopes = false) {
  try {
    const scopeCheck = await AppUtils.checkScope(swapScopes);
    if (!scopeCheck.match) {
      scopeCheckMessage(scopeCheck);
      throw new Error();
    } else {
      successFunc();
    }
  } catch (e) {
    logger.error(
      "Failed to check your scope! You may want to make sure your project is configured correctly or run `npx sinc init`"
    );
    // Throw exception to register this as an error
    process.exit(1);
  }
}

function setLogLevel(args: Sinc.SharedCmdArgs) {
  logger.setLogLevel(args.logLevel);
}

export async function dev(args: Sinc.SharedCmdArgs) {
  setLogLevel(args);
  scopeCheck(async () => {
    startWatching(ConfigManager.getSourcePath());
    devModeLog();

    const refresher = () => {
      refresh(args, false);
    };
    // let interval = ConfigManager.getRefresh();
    // if (interval && interval > 0) {
    //   logger.info(`Checking for new manifest files every ${interval} seconds`);
    //   // setInterval(refresher, interval * 1000);
    // }
  });
}

export async function refresh(args: Sinc.SharedCmdArgs, log = true) {
  const { currentUs = false } = args;
  setLogLevel(args);
  scopeCheck(async () => {
    try {
      if (!log) setLogLevel({ logLevel: "warn" });
      await AppUtils.syncManifest(currentUs);
      logger.success("Refresh complete! ✅");
      setLogLevel(args);
    } catch (e) {
      throw e;
    }
  });
}
export async function push(args: Sinc.PushCmdArgs): Promise<void> {
  setLogLevel(args);
  scopeCheck(async () => {
    try {
      const { updateSet, ci: skipPrompt, target, diff } = args;
      let encodedPaths;
      if (target !== undefined && target !== "") encodedPaths = target;
      else encodedPaths = await gitDiffToEncodedPaths(diff);

      const fileList = await AppUtils.getAppFileList(encodedPaths);
      logger.info(`${fileList.length} files to push.`);

      if (!skipPrompt) {
        const targetServer = process.env.SN_INSTANCE;
        if (!targetServer) {
          logger.error("No server configured for push!");
          return;
        }
        const answers: { confirmed: boolean } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirmed",
            message:
              "Pushing will overwrite code in your instance. Are you sure?",
            default: false,
          },
        ]);
        if (!answers["confirmed"]) return;
      }

      // Does not create update set if updateSetName is blank
      if (updateSet) {
        if (!skipPrompt) {
          const answers: { confirmed: boolean } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirmed",
              message: `A new Update Set "${updateSet}" will be created for these pushed changes. Do you want to proceed?`,
              default: false,
            },
          ]);
          if (!answers["confirmed"]) {
            process.exit(0);
          }
        }

        const newUpdateSet = await AppUtils.createAndAssignUpdateSet(updateSet);
        logger.debug(
          `New Update Set Created(${newUpdateSet.name}) sys_id:${newUpdateSet.id}`
        );
      }
      const pushResults = await AppUtils.pushFiles(fileList);
      logPushResults(pushResults);
    } catch (e: any) {
      logger.getInternalLogger().error(e);
      process.exit(1);
    }
  }, args.scopeSwap);
}
export async function download(args: Sinc.CmdDownloadArgs): Promise<void> {
  setLogLevel(args);
  try {
    const { confirmed } = (await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: "Downloading will overwrite manifest and files. Are you sure?",
        default: false,
      },
    ])) as { confirmed: boolean };
    if (!confirmed) return;
    logger.info("Downloading manifest and files...");
    const man = await fetchManifest(args.scope);
    logger.info("Creating local files from manifest...");
    await processManifest(man, true);
    logger.success("Download complete ✅");
  } catch (e) {
    throw e;
  }
}
export async function init(args: Sinc.SharedCmdArgs) {
  setLogLevel(args);
  try {
    await startWizard();
  } catch (e) {
    throw e;
  }
}

export async function build(args: Sinc.BuildCmdArgs) {
  setLogLevel(args);
  try {
    const encodedPaths = await gitDiffToEncodedPaths(args.diff);
    const fileList = await AppUtils.getAppFileList(encodedPaths);
    logger.info(`${fileList.length} files to build.`);
    const results = await AppUtils.buildFiles(fileList);
    logBuildResults(results);
  } catch (e) {
    process.exit(1);
  }
}

async function getDeployPaths(): Promise<string[]> {
  let changedPaths: string[] = [];
  try {
    changedPaths = ConfigManager.getDiffFile().changed || [];
  } catch (e) {}
  if (changedPaths.length > 0) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message:
          "Would you like to deploy only files changed in your diff file?",
        default: false,
      },
    ]);
    if (confirmed) return changedPaths;
  }
  return encodedPathsToFilePaths(ConfigManager.getBuildPath());
}

export async function deploy(args: Sinc.SharedCmdArgs): Promise<void> {
  setLogLevel(args);
  scopeCheck(async () => {
    try {
      const targetServer = process.env.SN_INSTANCE || "";
      if (!targetServer) {
        logger.error("No server configured for deploy!");
        return;
      }
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: "confirm",
          name: "confirmed",
          message:
            "Deploying will overwrite code in your instance. Are you sure?",
          default: false,
        },
      ]);
      if (!confirmed) {
        return;
      }
      const paths = await getDeployPaths();
      logger.silly(`${paths.length} paths found...`);
      logger.silly(JSON.stringify(paths, null, 2));
      const appFileList = await AppUtils.getAppFileList(paths);
      const pushResults = await AppUtils.pushFiles(appFileList);
      logPushResults(pushResults);
    } catch (e) {
      throw e;
    }
  });
}

export async function status() {
  try {
    const scopeObj = await getCurrentScope();
    logger.info(`Instance: ${process.env.SN_INSTANCE}`);
    logger.info(`Scope: ${scopeObj.scope}`);
    logger.info(`User: ${process.env.SN_USER}`);
  } catch (e) {
    throw e;
  }
}
