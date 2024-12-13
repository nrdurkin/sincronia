import { SN, Sinc } from "@sincronia/types";
import inquirer from "inquirer";
import { ConfigManager } from "./config";
import * as AppUtils from "./appUtils";
import fs, { promises as fsp } from "fs";
import { logger } from "./Logger";
import { unwrapSNResponse, defaultClient } from "./snClient";
import { getAppList } from "./services/serviceNow";

export async function startWizard(): Promise<void> {
  const loginAnswers = await getLoginInfo();
  try {
    const apps = await getAppList(loginAnswers);
    await setupDotEnv(loginAnswers);
    const hasConfig = await checkConfig();
    if (!hasConfig) {
      logger.info("Generating config...");
      await ConfigManager.writeDefaultConfig();
    }
    try {
      ConfigManager.getManifest();
    } catch (e) {
      const selectedApp = await showAppList(apps);
      if (!selectedApp) {
        return;
      }
      logger.info("Downloading app...");
      await downloadApp(selectedApp);
    }
    logger.success(
      "You are all set up 👍 Try running 'npx sinc dev' to begin development mode."
    );
    await ConfigManager.loadConfigs();
  } catch (e) {
    logger.error(
      "Failed to setup application. Check to see that your credentials are correct and you have the update set installed on your instance."
    );
    return;
  }
}

async function getLoginInfo(): Promise<Sinc.LoginAnswers> {
  return await inquirer.prompt([
    {
      type: "input",
      name: "instance",
      message:
        "What instance would you like to connect to?(ex. test123.service-now.com)",
    },
    {
      type: "input",
      name: "username",
      message: "What is your username on that instance?",
    },
    {
      type: "password",
      name: "password",
      message: "What is your password on that instance?",
    },
  ]);
}

async function checkConfig(): Promise<boolean> {
  try {
    const checkConfig = ConfigManager.checkConfigPath();
    if (!checkConfig) return false;
    await fsp.access(checkConfig, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function setupDotEnv(answers: Sinc.LoginAnswers) {
  const data = `SN_USER=${answers.username}
SN_PASSWORD=${answers.password}
SN_INSTANCE=${answers.instance}
  `;
  process.env.SN_USER = answers.username;
  process.env.SN_PASSWORD = answers.password;
  process.env.SN_INSTANCE = answers.instance;
  try {
    await fsp.writeFile(ConfigManager.getEnvPath(), data);
  } catch (e) {
    throw e;
  }
}

async function showAppList(apps: SN.App[]): Promise<string> {
  const appSelection: Sinc.AppSelectionAnswer = await inquirer.prompt([
    {
      type: "list",
      name: "app",
      message: "Which app would you like to work with?",
      choices: apps.map((app) => {
        return {
          name: `${app.name}(${app.scope})`,
          value: app.scope,
          short: app.name,
        };
      }),
    },
  ]);
  return appSelection.app;
}

async function downloadApp(scope: string) {
  try {
    const client = defaultClient();
    const config = ConfigManager.getConfig();
    const man = await unwrapSNResponse(client.getManifest(scope, config, true));
    await AppUtils.processManifest(man);
  } catch (e: unknown) {
    if (e instanceof Error) logger.error(e.toString());
    throw new Error("Failed to download files!");
  }
}
