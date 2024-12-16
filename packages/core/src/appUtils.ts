import { SN, Sinc, TSFIXME } from "@sincronia/types";
import path from "path";
import ProgressBar from "progress";
import * as fUtils from "./utils/fileUtils";
import { ConfigManager } from "./configs/config";
import { PUSH_RETRY_LIMIT, PUSH_RETRY_WAIT } from "./configs/constants";
import PluginManager from "./utils/PluginManager";
import {
  defaultClient,
  processPushResponse,
  retryOnErr,
  SNClient,
  unwrapSNResponse,
} from "./snClient";
import { logger } from "./cli/Logger";
import { fetchManifest, processMissingFiles } from "./utils/processManifest";
import {
  getCurrentScope,
  getUserSysId,
  snGetTable,
  upsertSNRecord,
} from "./services/serviceNow";
import { parseString } from "xml2js";
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
      const httpClient = defaultClient();
      const updateSetChanges = await httpClient.getCurrentUpdateSetChanges();

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

const allSettled = <T>(
  promises: Promise<T>[]
): Promise<Sinc.PromiseResult<T>[]> => {
  return Promise.all(
    promises.map((prom) =>
      prom
        .then(
          (value): Sinc.PromiseResult<T> => ({
            status: "fulfilled",
            value,
          })
        )
        .catch(
          (reason: Error): Sinc.PromiseResult<T> => ({
            status: "rejected",
            reason,
          })
        )
    )
  );
};

const aggregateErrorMessages = (
  errs: Error[],
  defaultMsg: string,
  labelFn: (err: Error, index: number) => string
): string => {
  return errs.reduce((acc, err, index) => {
    return `${acc}\n${labelFn(err, index)}:\n${err.message || defaultMsg}`;
  }, "");
};

const buildRec = async (
  rec: Sinc.BuildableRecord
): Promise<Sinc.RecBuildRes> => {
  const fields = Object.keys(rec.fields);
  const buildPromises = fields.map((field) => {
    return PluginManager.getFinalFileContents(rec.fields[field]);
  });
  const builtFiles = await allSettled(buildPromises);
  const buildSuccess = !builtFiles.find(
    (buildRes) => buildRes.status === "rejected"
  );
  if (!buildSuccess) {
    return {
      success: false,
      message: aggregateErrorMessages(
        builtFiles
          .filter((b): b is Sinc.FailPromiseResult => b.status === "rejected")
          .map((b) => b.reason),
        "Failed to build!",
        (_, index) => `${index}`
      ),
    };
  }
  const builtRec = builtFiles.reduce((acc, buildRes, index) => {
    const { value: content } = buildRes as Sinc.SuccessPromiseResult<string>;
    const fieldName = fields[index];
    return { ...acc, [fieldName]: content };
  }, {} as Record<string, string>);
  return {
    success: true,
    builtRec,
  };
};

const pushRec = async (
  client: SNClient,
  table: string,
  sysId: string,
  builtRec: Record<string, string>,
  summary?: string
) => {
  const recSummary = summary ?? `${table} > ${sysId}`;
  try {
    const pushRes = await retryOnErr(
      () => client.updateRecord(table, sysId, builtRec),
      PUSH_RETRY_LIMIT,
      PUSH_RETRY_WAIT,
      (numTries: number) => {
        logger.debug(
          `Failed to push ${recSummary}! Retrying with ${numTries} left...`
        );
      }
    );
    return await processPushResponse(pushRes, recSummary, table, sysId);
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : "Too many retries";
    return { success: false, message: `${recSummary} : ${errMsg}` };
  }
};

export const pushFiles = async (
  recs: Sinc.BuildableRecord[]
): Promise<Sinc.PushResult[]> => {
  const client = defaultClient();
  const tick = getProgTick(logger.getLogLevel(), recs.length * 2);
  const pushResultPromises = recs.map(async (rec) => {
    const fieldNames = Object.keys(rec.fields);
    const recSummary = summarizeRecord(
      rec.table,
      rec.fields[fieldNames[0]].name
    );
    const buildRes = await buildRec(rec);
    tick();
    if (!buildRes.success) {
      tick();
      return { success: false, message: `${recSummary} : ${buildRes.message}` };
    }
    const trackedVersion = rec.fields[fieldNames[0]].version;
    if (trackedVersion) {
      const table = rec.table;

      const recordData = (
        await snGetTable(Tables.UpdateVersion, {
          sysparm_query: {
            name: `${table}_${rec.sysId}`,
            state: "current",
          },
          sysparm_fields: [
            "sys_updated_on",
            "sys_updated_by",
            "sys_id",
            "payload",
          ],
        })
      )[0];
      const {
        sys_id: latestVersion,
        sys_updated_on: lastUpdate,
        sys_updated_by: lastUser,
        payload,
      } = recordData;
      if (latestVersion != trackedVersion) {
        const remoteScript: string = await new Promise((resolve, reject) => {
          parseString(payload, (err, result) => {
            if (err) {
              reject(err);
            }
            //probably won't work with multiple scripts (client scripts)
            resolve(result.record_update[table][0].script[0]);
          });
        });

        const x = remoteScript.replace(/\r/g, "");
        const y = buildRes.builtRec.script.replace(/\r/g, "");
        if (x !== y) {
          return {
            success: false,
            message: `${recSummary} : Local record version is out of date. \nRecord was last updated on ${lastUpdate} by ${lastUser}`,
          };
        }
        console.log(
          "Versions out of date, but scripts match. Getting latest version"
        );
      }
    }
    const pushRes = pushRec(
      client,
      rec.table,
      rec.sysId,
      buildRes.builtRec,
      recSummary
    );
    tick();
    return pushRes;
  });
  return Promise.all(pushResultPromises);
};

export const summarizeRecord = (table: string, recDescriptor: string): string =>
  `${table} > ${recDescriptor}`;

const getProgTick = (logLevel: string, total: number): (() => void) => {
  if (logLevel === "info") {
    const progBar = new ProgressBar(":bar (:percent)", {
      total,
      width: 60,
    });
    return () => {
      progBar.tick();
    };
  }
  // no-op at other log levels
  return () => undefined;
};

const writeBuildFile = async (
  preBuild: Sinc.BuildableRecord,
  buildRes: Sinc.RecBuildSuccess,
  summary?: string
): Promise<Sinc.BuildResult> => {
  const { fields, table, sysId } = preBuild;
  const recSummary = summary ?? `${table} > ${sysId}`;
  const sourcePath = ConfigManager.getSourcePath();
  const buildPath = ConfigManager.getBuildPath();
  const fieldNames = Object.keys(fields);
  const writePromises = fieldNames.map(async (field) => {
    const fieldCtx = fields[field];
    const srcFilePath = fieldCtx.filePath;
    const relativePath = path.relative(sourcePath, srcFilePath);
    const relPathNoExt = relativePath.split(".").slice(0, -1).join();
    const buildExt = fUtils.getBuildExt(
      fieldCtx.tableName,
      fieldCtx.name,
      fieldCtx.targetField
    );
    const relPathNewExt = `${relPathNoExt}.${buildExt}`;
    const buildFilePath = path.join(buildPath, relPathNewExt);
    await fUtils.createDirRecursively(path.dirname(buildFilePath));
    const writeResult = await fUtils.writeFileForce(
      buildFilePath,
      buildRes.builtRec[fieldCtx.targetField]
    );
    return writeResult;
  });
  try {
    await Promise.all(writePromises);
    return { success: true, message: `${recSummary} built successfully` };
  } catch (e) {
    return {
      success: false,
      message: `${recSummary} : ${e}`,
    };
  }
};

export const buildFiles = async (
  fileList: Sinc.BuildableRecord[]
): Promise<Sinc.BuildResult[]> => {
  const tick = getProgTick(logger.getLogLevel(), fileList.length * 2);
  const buildPromises = fileList.map(async (rec) => {
    const { fields, table } = rec;
    const fieldNames = Object.keys(fields);
    const recSummary = summarizeRecord(table, fields[fieldNames[0]].name);
    const buildRes = await buildRec(rec);
    tick();
    if (!buildRes.success) {
      tick();
      return { success: false, message: `${recSummary} : ${buildRes.message}` };
    }
    // writeFile
    const writeRes = await writeBuildFile(rec, buildRes, recSummary);
    tick();
    return writeRes;
  });
  return Promise.all(buildPromises);
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
  const client = defaultClient();
  const { sys_id: updateSetSysId } = await unwrapSNResponse(
    client.createUpdateSet(updateSetName)
  );
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
