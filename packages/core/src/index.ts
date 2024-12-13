#!/usr/bin/env node
import dotenv from "dotenv";
import { ConfigManager } from "./config";

export const init = async (): Promise<void> => {
  try {
    await ConfigManager.loadConfigs();
    const path = ConfigManager.getEnvPath();
    dotenv.config({
      path,
    });
    (await import("./commander")).initCommands();
  } catch (e) {
    console.log(e);
    process.exit(1);
  }
};

init();
