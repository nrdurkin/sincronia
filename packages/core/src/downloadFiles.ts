import { SN } from "@sincronia/types";
import { keys, map, get, forEach, reduce } from "lodash";
import { tableData } from "./getManifest";
import { connection } from "./services/connection";
import { ConfigManager } from "./config";
import { constructEndpoint } from "./services/serviceNow";

export const ng_getMissingFiles = async (
  missingFiles: SN.MissingFileTableMap
): Promise<SN.TableMap> => {
  const currentManifest = await ConfigManager.getManifest();
  const result: SN.TableMap = {};
  const filePromises = Object.entries(missingFiles).map(
    ([table, missingRecord]): Promise<{ list: any; table: string }> => {
      const endpoint = constructEndpoint(table, {
        sysparm_query: {
          sys_id: { op: "IN", value: keys(missingRecord).join(",") },
        },
        sysparm_fields: [
          ...map(get(tableData, `${table}.files`, []), ({ name }) => name),
          "sys_id",
        ],
      });
      return connection.get(endpoint).then((td) => ({
        list: td.data.result,
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
            files: res.files.map((f: any) => ({
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
  manifest: any
): any => {
  const records = get(manifest, `tables.${table}.records`, {});
  return reduce(records, (res, rec) => (rec.sys_id === sysId ? rec : res), "");
};
