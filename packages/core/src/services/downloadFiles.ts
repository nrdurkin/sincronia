import { SN } from "@sincronia/types";
import { keys, map, get, forEach, reduce } from "lodash";
import { ConfigManager } from "../configs/config";
import { snGetTable } from "../services/serviceNow";

export const downloadMissingFiles = async (
  missingFiles: SN.MissingFileTableMap
): Promise<SN.TableMap> => {
  const currentManifest = await ConfigManager.getManifest();
  const { tableOptions } = await ConfigManager.getConfig();
  const result: SN.TableMap = {};
  const filePromises = Object.entries(missingFiles).map(
    ([table, missingRecord]): Promise<{
      list: Record<string, string>[];
      table: string;
    }> => {
      return snGetTable(table, {
        sysparm_query: {
          sys_id: { op: "IN", value: keys(missingRecord).join(",") },
        },
        sysparm_fields: [
          ...map(get(tableOptions, `${table}.files`, []), ({ name }) => name),
          "sys_id",
        ],
      }).then((list) => ({
        list,
        table,
      }));
    }
  );
  return Promise.all(filePromises)
    .then((records) => {
      records.forEach(({ list, table }) => {
        forEach(list, (record) => {
          const res = findRecordInManifest(
            table,
            record.sys_id,
            currentManifest
          );
          if (!res) return;
          if (!result[table]) result[table] = { records: {} };
          result[table].records[res.name] = {
            ...res,
            files: res.files.map((f) => ({
              ...f,
              content: record[f.name],
            })),
          };
        });
      });
    })
    .then(() => result);
};

const findRecordInManifest = (
  table: string,
  sysId: string,
  manifest: SN.AppManifest
): SN.MetaRecord => {
  const records: Record<string, SN.MetaRecord> = get(
    manifest,
    `tables.${table}.records`,
    {}
  );
  return reduce(
    records,
    (res, rec) => (rec.sys_id === sysId ? rec : res),
    {} as SN.MetaRecord
  );
};
