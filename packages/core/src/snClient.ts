import { Sinc, SN, TSFIXME } from "@sincronia/types";
import axios, { AxiosPromise, AxiosResponse } from "axios";
import rateLimit from "axios-rate-limit";
import { wait } from "./genericUtils";
import { logger } from "./Logger";
import { ConfigManager } from "./config";
import { updateRecordTrackedVersion } from "./appUtils";
import { constructEndpoint } from "./services/serviceNow";
import { connection } from "./services/connection";

export const retryOnErr = async <T>(
  f: () => Promise<T>,
  allowedRetries: number,
  msBetween = 0,
  onRetry?: (retriesLeft: number) => void
): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    const newRetries = allowedRetries - 1;
    if (newRetries <= 0) {
      throw e;
    }
    if (onRetry) {
      onRetry(newRetries);
    }
    await wait(msBetween);
    return retryOnErr(f, newRetries, msBetween, onRetry);
  }
};

export const processPushResponse = async (
  response: AxiosResponse,
  recSummary: string,
  table: string,
  recordId: string
): Promise<Sinc.PushResult> => {
  const { status } = response;
  if (status === 404) {
    return {
      success: false,
      message: `Could not find ${recSummary} on the server.`,
    };
  }
  if (status < 200 || status > 299) {
    return {
      success: false,
      message: `Failed to push ${recSummary}. Recieved an unexpected response (${status})`,
    };
  }

  const endpoint = constructEndpoint("sys_update_version", {
    sysparm_query: {
      name: `${table}_${recordId}`,
      state: "current",
    },
    sysparm_fields: ["sys_id"],
  });
  const recordData = await connection
    .get(endpoint)
    .then((a) => a.data.result[0]);
  const latestVersion = recordData.sys_id;

  updateRecordTrackedVersion(table, recordId, latestVersion);

  return {
    success: true,
    message: `${recSummary} pushed successfully!`,
  };
};

export const snClient = (
  baseURL: string,
  username: string,
  password: string
) => {
  const client = rateLimit(
    axios.create({
      withCredentials: true,
      auth: {
        username,
        password,
      },
      headers: {
        "Content-Type": "application/json",
      },
      baseURL,
    }),
    { maxRPS: 20 }
  );

  const getAppList = () => {
    const endpoint1 =
      "/api/now/table/sys_app?sysparm_fields=name,scope,sys_id&sysparm_query=ORDERBYscope";
    type AppListResponse = Sinc.SNAPIResponse<SN.App[]>;
    return client.get<AppListResponse>(endpoint1);
  };

  const updateATFfile = (contents: string, sysId: string) => {
    const endpoint = "api/x_nuvo_sinc/pushATFfile";
    try {
      return client.post(endpoint, { file: contents, sys_id: sysId });
    } catch (e) {
      throw e;
    }
  };

  const updateRecord = (
    table: string,
    recordId: string,
    fields: Record<string, string>
  ) => {
    if (table === "sys_atf_step") {
      updateATFfile(fields["inputs.script"], recordId);
    }
    const endpoint = `api/now/table/${table}/${recordId}`;
    return client.patch(endpoint, fields);
  };

  const getScopeId = (scopeName: string) => {
    const endpoint = "api/now/table/sys_scope";
    type ScopeResponse = Sinc.SNAPIResponse<SN.ScopeRecord[]>;
    return client.get<ScopeResponse>(endpoint, {
      params: {
        sysparm_query: `scope=${scopeName}`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const getUserSysId = (userName: string = process.env.SN_USER as string) => {
    const endpoint = "api/now/table/sys_user";
    type UserResponse = Sinc.SNAPIResponse<SN.UserRecord[]>;
    return client.get<UserResponse>(endpoint, {
      params: {
        sysparm_query: `user_name=${userName}`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const getCurrentAppUserPrefSysId = (userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    type UserPrefResponse = Sinc.SNAPIResponse<SN.UserPrefRecord[]>;
    return client.get<UserPrefResponse>(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=apps.current_app`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const updateCurrentAppUserPref = (
    appSysId: string,
    userPrefSysId: string
  ) => {
    const endpoint = `api/now/table/sys_user_preference/${userPrefSysId}`;
    return client.put(endpoint, { value: appSysId });
  };

  const createCurrentAppUserPref = (appSysId: string, userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    return client.post(endpoint, {
      value: appSysId,
      name: "apps.current_app",
      type: "string",
      user: userSysId,
    });
  };

  const createUpdateSet = (updateSetName: string) => {
    const endpoint = `api/now/table/sys_update_set`;
    type UpdateSetCreateResponse = Sinc.SNAPIResponse<SN.UpdateSetRecord>;
    return client.post<UpdateSetCreateResponse>(endpoint, {
      name: updateSetName,
    });
  };

  const getCurrentUpdateSetId = async (userSysId: string): Promise<string> => {
    const endpoint = `api/now/table/sys_user_preference`;
    const res = await client.get(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=sys_update_set`,
        sysparm_fields: "value",
      },
    });
    return res.data?.result[0]?.value || "";
  };

  const getCurrentUpdateSetUserPref = (userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    type CurrentUpdateSetResponse = Sinc.SNAPIResponse<SN.UserPrefRecord[]>;
    return client.get<CurrentUpdateSetResponse>(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=sys_update_set`,
        sysparm_fields: "sys_id",
      },
    });
  };
  const updateCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userPrefSysId: string
  ) => {
    const endpoint = `api/now/table/sys_user_preference/${userPrefSysId}`;
    return client.put(endpoint, { value: updateSetSysId });
  };

  const createCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userSysId: string
  ) => {
    const endpoint = `api/now/table/sys_user_preference`;
    return client.put(endpoint, {
      value: updateSetSysId,
      name: "sys_update_set",
      type: "string",
      user: userSysId,
    });
  };

  /**
   * Has NG
   * @param scope
   * @param config
   * @param withFiles
   * @returns
   */
  const getManifest = (
    scope: string,
    config: Sinc.Config,
    withFiles = false
  ) => {
    const endpoint = `api/x_nuvo_sinc/sinc/getManifest/${scope}`;
    const { includes = {}, excludes = {}, tableOptions = {} } = config;
    type AppResponse = Sinc.SNAPIResponse<SN.AppManifest>;
    return client.post<AppResponse>(endpoint, {
      includes,
      excludes,
      tableOptions,
      withFiles,
    });
  };

  const getCurrentUpdateSetChanges = async (): Promise<
    Record<string, string[]>
  > => {
    const { updateSetChangeTypes = [] } = await ConfigManager.getUsSincConfig();

    if (!updateSetChangeTypes.length) {
      return {};
    }
    const userData = await getUserSysId();
    const updateSetId = await getCurrentUpdateSetId(
      userData.data.result[0].sys_id
    );

    const changesTable = "sys_update_xml";
    const endpoint = `api/now/table/${changesTable}`;
    const query =
      `update_set=${updateSetId}^action!=DELETE^typeIN` +
      updateSetChangeTypes.join(",");
    const changesData = await client.get(endpoint, {
      params: {
        sysparm_query: query,
        sysparm_fields: "name",
      },
    });
    const changes: Record<string, string[]> = {};
    changesData.data.result.map((change: { name: string }) => {
      const nameArray = change.name.split("_");

      const table = nameArray.slice(0, -1).join("_");
      const id = nameArray.slice(-1)[0];
      if (!changes[table]) {
        changes[table] = [];
      }
      changes[table].push(id);
    });
    return changes;
  };

  const getVersionData = async (names: string[]): Promise<TSFIXME> => {
    const endpoint = `api/now/table/sys_update_version?sysparm_query=state=current^nameIN${names.join(
      ","
    )}&sysparm_fields=sys_id,name`;
    return client.get(endpoint);
  };

  return {
    getVersionData,
    getAppList,
    updateRecord,
    getScopeId,
    getUserSysId,
    getCurrentAppUserPrefSysId,
    updateCurrentAppUserPref,
    createCurrentAppUserPref,
    createUpdateSet,
    getCurrentUpdateSetUserPref,
    updateCurrentUpdateSetUserPref,
    createCurrentUpdateSetUserPref,
    getManifest,
    getCurrentUpdateSetChanges,
  };
};

let internalClient: SNClient | undefined = undefined;
export const defaultClient = () => {
  if (internalClient) {
    return internalClient;
  }
  const { SN_USER = "", SN_PASSWORD = "", SN_INSTANCE = "" } = process.env;
  internalClient = snClient(`https://${SN_INSTANCE}/`, SN_USER, SN_PASSWORD);
  return internalClient;
};

export type SNClient = ReturnType<typeof snClient>;

export const unwrapSNResponse = async <T>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T>>
): Promise<T> => {
  try {
    const resp = await clientPromise;
    return resp.data.result;
  } catch (e: any) {
    logger.error("Error processing server response");
    logger.error(e);
    throw e;
  }
};

export async function unwrapTableAPIFirstItem<T>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T[]>>
): Promise<T>;
export async function unwrapTableAPIFirstItem<T>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T[]>>,
  extractField: keyof T
): Promise<string>;
export async function unwrapTableAPIFirstItem<T extends Record<string, string>>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T[]>>,
  extractField?: keyof T
): Promise<T | string> {
  try {
    const resp = await unwrapSNResponse(clientPromise);
    if (resp.length === 0) {
      throw new Error("Response was not a populated array!");
    }
    if (!extractField) {
      return resp[0];
    }
    return resp[0][extractField];
  } catch (e) {
    throw e;
  }
}
