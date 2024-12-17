import { Sinc, SN } from "@sincronia/types";
import { get, map, isEmpty } from "lodash";
import { baseUrlGQL, connection } from "./connection";
import { Tables } from "../configs/constants";
import { getGqlQuery } from "./graphQL";
import { RecordItem } from "../configs/defaultTables";
import { AxiosPromise } from "axios";
import { ConfigManager } from "../configs/config";

type ParamOption = string | { op: string; value: string };
type SysParams<T = string> = {
  sysparm_query?: Record<string, ParamOption> | string;
  sysparm_fields?: T[];
};

export const snGetTable = async <T extends string>(
  table: string,
  params: SysParams<T>,
  authParams?: Sinc.LoginAnswers
): Promise<Record<T, string>[]> => {
  const conn = authParams ? connection(authParams) : connection();
  return get(await conn.get(tableApiEndpoint(table, params)), "data.result");
};

const tableApiEndpoint = (table: string, params: SysParams): string => {
  const sysparm_query = get(params, "sysparm_query", {});
  const sysparm_fields = get(params, "sysparm_fields", []);
  const urlParams = [];
  if (!isEmpty(sysparm_query)) {
    if (typeof sysparm_query === "string") {
      urlParams.push(`sysparm_query=${sysparm_query}`);
    } else {
      urlParams.push(
        `sysparm_query=${map(
          sysparm_query || {},
          (v: ParamOption, k) =>
            `${k}` + (typeof v === "object" ? `${v.op}${v.value}` : `=${v}`)
        ).join("^")}`
      );
    }
  }
  if (!isEmpty(sysparm_fields))
    urlParams.push(`sysparm_fields=` + sysparm_fields?.join(","));
  return `api/now/table/${table}?${urlParams.join("&")}`;
};

export const upsertSNRecord = async (
  table: string,
  params: Omit<SysParams, "sysparm_fields">,
  updates: Record<string, string>
): Promise<void> => {
  const data = await snGetTable(table, {
    ...params,
    sysparm_fields: ["sys_id"],
  });
  if (data.length) {
    const endpoint = `api/now/table/${table}/${data[0].sys_id}`;
    await connection().put(endpoint, updates);
  } else {
    const endpoint = `api/now/table/${table}`;
    await connection().put(endpoint, { ...params, ...updates });
  }
};

export const updateRecord = (
  table: string,
  recordId: string,
  fields: Record<string, string>
): AxiosPromise<void> => {
  if (table === Tables.AtfStep)
    throw new Error("ATF steps not currently supported.");
  const endpoint = `api/now/table/${table}/${recordId}`;
  return connection().patch(endpoint, fields);
};

export const getCurrentScope = async (): Promise<SN.ScopeObj> => {
  const { SN_USER: username = "" } = process.env;
  const data = await snGetTable(Tables.UserPreference, {
    sysparm_query: {
      "user.user_name": username,
      name: "apps.current_app",
    },
    sysparm_fields: ["value"],
  });
  const appId = data[0].value;
  if (appId) {
    const data = await snGetTable(Tables.App, {
      sysparm_query: { sys_id: appId },
      sysparm_fields: ["scope", "sys_id"],
    });
    return data[0];
  }
  return { scope: "", sys_id: "" };
};

export const getAppList = async (
  authParams: Sinc.LoginAnswers
): Promise<SN.App[]> => {
  return await snGetTable(
    "sys_app",
    {
      sysparm_query: "ORDERBYscope",
      sysparm_fields: ["name", "scope", "sys_id"],
    },
    authParams
  );
};

export const getVersionData = async (
  names: string[]
): Promise<{ sys_id: string; name: string }[]> => {
  return await snGetTable(Tables.UpdateVersion, {
    sysparm_query: {
      state: "current",
      name: { op: "IN", value: names.join(",") },
    },
    sysparm_fields: ["sys_id", "name"],
  });
};

export const getUserSysId = async (
  userName: string = process.env.SN_USER as string
): Promise<string> => {
  const data = await snGetTable(Tables.User, {
    sysparm_query: { user_name: userName },
    sysparm_fields: ["sys_id"],
  });
  return data[0].sys_id;
};

export const getManifestSN = async (
  scope: string,
  tablesData: Record<
    string,
    {
      name: string;
      fields: string[];
    }
  >
): Promise<Record<string, { list: RecordItem[] }>> => {
  const res = await connection().post(
    baseUrlGQL(),
    getGqlQuery(
      map(tablesData, ({ name, fields }) => ({
        table: name,
        fields,
        conditions: `sys_scope.scope=${scope}`,
        pagination: { limit: 10000 },
      }))
    )
  );
  return get(res, "data.data.query");
};

export const createUpdateSet = async (
  updateSetName: string
): Promise<string> => {
  const endpoint = `api/now/table/${Tables.UpdateSet}`;
  type UpdateSetCreateResponse = Sinc.SNAPIResponse<SN.UpdateSetRecord>;
  const res = await connection().post<UpdateSetCreateResponse>(endpoint, {
    name: updateSetName,
  });
  return res.data.result.sys_id;
};

export const getCurrentUpdateSetChanges = async (): Promise<
  Record<string, string[]>
> => {
  const { updateSetChangeTypes = [] } = await ConfigManager.getUsSincConfig();

  if (!updateSetChangeTypes.length) return {};

  const userId = await getUserSysId();

  const data = await snGetTable(Tables.UserPreference, {
    sysparm_query: `user=${userId}^name=${Tables.UpdateSet}`,
    sysparm_fields: ["value"],
  });
  const updateSetId = data[0]?.value || "";

  const changesData = await snGetTable(Tables.UpdateXML, {
    sysparm_query: {
      update_set: updateSetId,
      action: { op: "!=", value: "DELETE" },
      type: { op: "IN", value: updateSetChangeTypes.join(",") },
    },
    sysparm_fields: ["name"],
  });

  const changes: Record<string, string[]> = {};
  changesData.map(({ name }) => {
    const nameArray = name.split("_");

    const table = nameArray.slice(0, -1).join("_");
    const id = nameArray.slice(-1)[0];
    if (!changes[table]) changes[table] = [];
    changes[table].push(id);
  });
  return changes;
};
