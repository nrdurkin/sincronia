import { Sinc, TSFIXME } from "@sincronia/types";
import * as Commands from "./commands";
import yargs from "yargs";
export async function initCommands(): Promise<void> {
  const sharedOptions = {
    logLevel: {
      default: "info",
    },
  };

  yargs
    .command(
      ["dev", "d"],
      "Start Development Mode",
      sharedOptions,
      Commands.dev
    )
    .option("current-us", {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Download the files created or changed in the current update set",
    })
    .command(
      ["refresh", "r"],
      "Refresh Manifest and download new files since last refresh",
      sharedOptions,
      Commands.refresh
    )
    .option("current-us", {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Download the files created or changed in the current update set",
    })
    .command(
      ["push [target]"],
      "[DESTRUCTIVE] Push all files from current local files to ServiceNow instance.",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          diff: {
            alias: "d",
            type: "string",
            default: "",
            describe: "Specify branch to do git diff against",
          },
          scopeSwap: {
            alias: "ss",
            type: "boolean",
            default: false,
            describe:
              "Will auto-swap to the correct scope for the files being pushed",
          },
          updateSet: {
            alias: "us",
            type: "string",
            default: "",
            describe:
              "Will create a new update set with the provided anme to store all changes into",
          },
          ci: {
            type: "boolean",
            default: false,
            describe: "Will skip confirmation prompts during the push process",
          },
        });
        return cmdArgs;
      },
      (args: TSFIXME) => {
        Commands.push(args as Sinc.PushCmdArgs);
      }
    )
    .command(
      "download <scope>",
      "Downloads a scoped application's files from ServiceNow. Must specify a scope prefix for a scoped app.",
      sharedOptions,
      (args: TSFIXME) => {
        Commands.download(args as Sinc.CmdDownloadArgs);
      }
    )
    .command(
      "init",
      "Provisions an initial project for you",
      sharedOptions,
      Commands.init
    )
    .command(
      "build",
      "Build application files locally",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          diff: {
            alias: "d",
            type: "string",
            default: "",
            describe: "Specify branch to do git diff against",
          },
        });
        return cmdArgs;
      },
      (args: TSFIXME) => {
        Commands.build(args);
      }
    )
    .command(
      "deploy",
      "Deploy local build files to the scoped application",
      sharedOptions,
      Commands.deploy
    )
    .command(
      "status",
      "Get information about the connected instance",
      sharedOptions,
      Commands.status
    )
    .help().argv;
}
