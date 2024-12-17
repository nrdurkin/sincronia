import { SN, Sinc, TSFIXME } from "@sincronia/types";
import * as fUtils from "./utils/fileUtils";
import { ConfigManager } from "./configs/config";
import { logger } from "./cli/Logger";
import { fetchManifest, processMissingFiles } from "./utils/processManifest";
import {
  createUpdateSet,
  getCurrentScope,
  getCurrentUpdateSetChanges,
  getUserSysId,
  upsertSNRecord,
} from "./services/serviceNow";
import { Tables } from "./configs/constants";

export const syncManifest = async (
  currentUpdateSetOnly = false
): Promise<void> => {
  try {
    const curManifest = await ConfigManager.getManifest();
    if (!curManifest) throw new Error("No manifest file loaded!");
    logger.info("Downloading fresh manifest...");
    const newManifest = await fetchManifest(curManifest.scope);

    if (currentUpdateSetOnly) {
      logger.info("Downloading files only from the current update set.");
      const updateSetChanges = await getCurrentUpdateSetChanges();

      for (const tableName in newManifest.tables) {
        if (updateSetChanges[tableName]) {
          for (const scriptName in newManifest.tables[tableName].records) {
            const sysId =
              newManifest.tables[tableName].records[scriptName].sys_id;
            if (updateSetChanges[tableName].indexOf(sysId) > -1) {
              const script = newManifest.tables[tableName].records[scriptName];
              if (!curManifest.tables[tableName]) {
                curManifest.tables[tableName] = {
                  records: {},
                };
              }
              curManifest.tables[tableName].records[scriptName] = script;
            }
          }
        }
      }
    }
    const manifestContent = currentUpdateSetOnly ? curManifest : newManifest;

    logger.info("Writing new manifest file...");
    ConfigManager.updateManifest(manifestContent);
    logger.info("Finding and creating missing files...");
    await processMissingFiles(manifestContent);
  } catch (e: TSFIXME) {
    logger.error("Encountered error while refreshing! ❌");
    logger.error(e.toString());
  }
};

export const groupAppFiles = (
  fileCtxs: Sinc.FileContext[]
): Sinc.BuildableRecord[] => {
  const combinedFiles = fileCtxs.reduce((groupMap, cur) => {
    const { tableName, targetField, sys_id } = cur;
    const key = `${tableName}-${sys_id}`;
    const entry: Sinc.BuildableRecord = groupMap[key] ?? {
      table: tableName,
      sysId: sys_id,
      fields: {},
    };
    const newEntry: Sinc.BuildableRecord = {
      ...entry,
      fields: { ...entry.fields, [targetField]: cur ?? "" },
    };
    return { ...groupMap, [key]: newEntry };
  }, {} as Record<string, Sinc.BuildableRecord>);
  return Object.values(combinedFiles);
};

export const getAppFileList = async (
  paths: string | string[]
): Promise<Sinc.BuildableRecord[]> => {
  const validPaths =
    typeof paths === "object"
      ? paths
      : await fUtils.encodedPathsToFilePaths(paths);
  const appFileCtxs = validPaths
    .map(fUtils.getFileContextFromPath)
    .filter((maybeCtx): maybeCtx is Sinc.FileContext => !!maybeCtx);
  return groupAppFiles(appFileCtxs);
};

export const swapScope = async (): Promise<SN.ScopeObj> => {
  try {
    const scopeId = (await getCurrentScope()).sys_id;
    await swapServerScope(scopeId);
    const scopeObj = await getCurrentScope();
    return scopeObj;
  } catch (e) {
    throw e;
  }
};

const swapServerScope = async (scopeId: string): Promise<void> => {
  try {
    const userSysId = await getUserSysId();
    await upsertSNRecord(
      Tables.UserPreference,
      {
        sysparm_query: { user: userSysId, name: "apps.current_app" },
      },
      { value: scopeId, type: "string" }
    );
  } catch (e: unknown) {
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
};

/**
 * Creates a new update set and assigns it to the current user.
 * @param updateSetName - does not create update set if value is blank
 */
export const createAndAssignUpdateSet = async (
  updateSetName = ""
): Promise<{ name: string; id: string }> => {
  logger.info(`Update Set Name: ${updateSetName}`);
  const updateSetSysId = await createUpdateSet(updateSetName);
  const userSysId = await getUserSysId();

  await upsertSNRecord(
    Tables.UserPreference,
    {
      sysparm_query: { user: userSysId, name: Tables.UpdateSet },
    },
    { value: updateSetSysId, type: "string" }
  );
  return {
    name: updateSetName,
    id: updateSetSysId,
  };
};

export const checkScope = async (
  swap: boolean
): Promise<Sinc.ScopeCheckResult> => {
  try {
    const man = ConfigManager.getManifest();
    if (man) {
      const scopeObj = await getCurrentScope();
      if (scopeObj.scope === man.scope) {
        return {
          match: true,
          sessionScope: scopeObj.scope,
          manifestScope: man.scope,
        };
      } else if (swap) {
        const swappedScopeObj = await swapScope();
        return {
          match: swappedScopeObj.scope === man.scope,
          sessionScope: swappedScopeObj.scope,
          manifestScope: man.scope,
        };
      } else {
        return {
          match: false,
          sessionScope: scopeObj.scope,
          manifestScope: man.scope,
        };
      }
    }
    //first time case
    return {
      match: true,
      sessionScope: "",
      manifestScope: "",
    };
  } catch (e) {
    throw e;
  }
};
