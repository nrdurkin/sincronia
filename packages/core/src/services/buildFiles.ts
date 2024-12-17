import { Sinc } from "@sincronia/types";
import { ConfigManager } from "../configs/config";
import PluginManager from "../utils/PluginManager";
import path from "path";
import * as fUtils from "../utils/fileUtils";
import {
  aggregateErrorMessages,
  allSettled,
  getProgTick,
  summarizeRecord,
} from "./utils";
import { logger } from "../cli/Logger";

export const buildRec = async (
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
