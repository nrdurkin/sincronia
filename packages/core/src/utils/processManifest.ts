import { get, map, set, compact, forEach, filter, flatMap } from "lodash";
import { RecordItem } from "../configs/defaultTables";
import { getManifestSN, getVersionData } from "../services/serviceNow";
import { Sinc, SN } from "@sincronia/types";
import { ConfigManager } from "../configs/config";
import { logger } from "../cli/Logger";
import * as fUtils from "./fileUtils";
import path from "path";
import { downloadMissingFiles } from "../services/downloadFiles";
import { findMissingFiles } from "./findMissingFiles";
import { Tables } from "../configs/constants";

const generateRecordName = (
  record: RecordItem,
  differentiatorField: string | string[],
  displayField: string
): string => {
  let recordName =
    get(record, "name.displayValue", "") ||
    get(record, "name.value", "") ||
    get(record, "sys_id.value", "");

  if (displayField !== "") {
    recordName = get(record, `${displayField}.displayValue`, "") as string;
  }
  if (differentiatorField) {
    if (typeof differentiatorField === "string") {
      recordName = `${recordName} (${get(
        record,
        `${differentiatorField}.displayValue`
      )})`;
    } else if (
      typeof differentiatorField === "object" &&
      differentiatorField.length
    ) {
      forEach(differentiatorField, (df) => {
        const value = get(record, `${df}.value`, "") as string;
        if (value && value !== "") {
          recordName += ` (${df}:${value})`;
          return false;
        }
      });
    }
  }
  if (!recordName || recordName === "") {
    recordName = get(record, `sys_id.value`, "") as string;
  }
  return (recordName as string)
    .replace(/[\/\\]/g, "〳")
    .replace(/\./g, "_DOT_");
};

const getScriptRecords = ({
  tableRecords,
  differentiatorField,
  files,
  displayField,
  versionData,
  table,
}: {
  tableRecords: RecordItem[];
  differentiatorField: string | string[];
  files: SN.File[];
  displayField: string;
  versionData: { sys_id: string; name: string }[];
  table: string;
}) => {
  const records: Record<
    string,
    { files: SN.File[]; sys_id: string; name: string; version: string }
  > = {};
  tableRecords.forEach((record) => {
    const name = generateRecordName(record, differentiatorField, displayField);
    const versionId = filter(
      versionData,
      ({ name }) => name == `${table}_${record.sys_id.value}`
    );
    records[name] = {
      files: files.map(({ name, type }) => ({ name, type })),
      name: name,
      sys_id: record.sys_id.value,
      version: versionId[0].sys_id,
    };
  });
  return records;
};

type TableInfo = {
  name: string;
  fields: string[];
} & Required<Sinc.ITableOptions>;

export const fetchManifest = async (scope: string): Promise<SN.AppManifest> => {
  const manifest: SN.AppManifest = {
    tables: {},
    scope,
  };

  await ConfigManager.loadConfigs();
  const { includes = {} } = ConfigManager.getConfig();
  const tables = Object.keys(includes);

  if (tables.includes(Tables.AtfStep)) {
    //https://www.servicenow.com/community/developer-forum/not-able-to-map-values-to-a-glide-var-type-input-field-using/m-p/1983044
    logger.warn("ATF steps not currently supported.");
    tables.splice(tables.indexOf(Tables.AtfStep), 1);
  }
  const tablesData: Record<string, TableInfo> = {};
  tables.forEach((t) => {
    const {
      differentiatorField = [],
      displayField = "",
      files = [],
      query = "",
    } = includes[t];
    if (files.length === 0) {
      return logger.warn(
        `Table ${t} has no configured files. Add files to the tableOptions for ${t}.`
      );
    }
    tablesData[t] = {
      name: t,
      files: map(
        files,
        (f): SN.File => (typeof f === "object" ? f : { name: f, type: "js" })
      ),
      displayField,
      differentiatorField,
      fields: compact([
        ...(typeof differentiatorField === "object"
          ? [...differentiatorField]
          : [differentiatorField]),
        "name",
        "sys_id",
        displayField,
      ]),
      query,
    };
  });

  const manifestData = await getManifestSN(scope, tablesData);
  const versionNames = flatMap(tablesData, ({ name }) => {
    return manifestData[name].list.map((rec) => `${name}_${rec.sys_id.value}`);
  });

  const versionData = await getVersionData(versionNames);

  map(tablesData, ({ name, differentiatorField, files, displayField }) => {
    const tableRecords = manifestData[name].list;
    if (tableRecords.length) {
      set(manifest, `tables.${name}`, {
        records: getScriptRecords({
          tableRecords,
          displayField,
          differentiatorField,
          files,
          versionData,
          table: name,
        }),
      });
    }
  });
  return manifest;
};

const processFilesInManRec = async (
  recPath: string,
  rec: SN.MetaRecord,
  forceWrite: boolean
) => {
  const fileWrite = fUtils.writeSNFileCurry(forceWrite);
  const filePromises = rec.files.map((file) => fileWrite(file, recPath));
  await Promise.all(filePromises);
  // Side effect, remove content from files so it doesn't get written to manifest
  rec.files.forEach((file) => {
    delete file.content;
  });
};

const processRecsInManTable = async (
  tablePath: string,
  table: SN.TableConfig,
  forceWrite: boolean
) => {
  const { records } = table;
  const recKeys = Object.keys(records);
  const recKeyToPath = (key: string) => path.join(tablePath, records[key].name);
  const recPathPromises = recKeys
    .map(recKeyToPath)
    .map(fUtils.createDirRecursively);
  await Promise.all(recPathPromises);

  const filePromises = recKeys.reduce(
    (acc: Promise<void>[], recKey: string) => {
      return [
        ...acc,
        processFilesInManRec(recKeyToPath(recKey), records[recKey], forceWrite),
      ];
    },
    [] as Promise<void>[]
  );
  return Promise.all(filePromises);
};

const processTablesInManifest = async (
  tables: SN.TableMap,
  forceWrite: boolean
) => {
  const tableNames = Object.keys(tables);
  const tablePromises = tableNames.map((tableName) => {
    return processRecsInManTable(
      path.join(ConfigManager.getSourcePath(), tableName),
      tables[tableName],
      forceWrite
    );
  });
  await Promise.all(tablePromises);
};

export const processManifest = async (
  manifest: SN.AppManifest
): Promise<void> => {
  ConfigManager.updateManifest(manifest);
  await processMissingFiles(manifest);
};

export const processMissingFiles = async (
  newManifest: SN.AppManifest
): Promise<void> => {
  try {
    const missing = await findMissingFiles(newManifest);
    const filesToProcess = await downloadMissingFiles(missing);
    await processTablesInManifest(filesToProcess, false);
  } catch (e) {
    throw e;
  }
};

export const updateRecordTrackedVersion = async (
  table: string,
  recordId: string,
  version: string
): Promise<void> => {
  const curManifest = await ConfigManager.getManifest();
  if (!curManifest) throw new Error("No manifest file loaded!");

  const records: SN.TableConfigRecords = get(
    curManifest,
    `tables.${table}.records`,
    {}
  );

  forEach(records, (metadata, _) => {
    if (metadata.sys_id === recordId) metadata.version = version;
  });
  fUtils.writeManifestFile(curManifest);
};
