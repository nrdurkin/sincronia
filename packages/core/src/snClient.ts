import { Sinc, SN } from "@sincronia/types";
import { AxiosPromise, AxiosResponse } from "axios";
import { logger } from "./cli/Logger";
import { ConfigManager } from "./configs/config";
import { getUserSysId, snGetTable } from "./services/serviceNow";
import { connection } from "./services/connection";
import { Tables } from "./configs/constants";
import { updateRecordTrackedVersion } from "./utils/processManifest";

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
    if (onRetry) onRetry(newRetries);
    await new Promise((resolve, reject) => setTimeout(resolve, msBetween));
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

  const data = await snGetTable(Tables.UpdateVersion, {
    sysparm_query: {
      name: `${table}_${recordId}`,
      state: "current",
    },
    sysparm_fields: ["sys_id"],
  });
  const latestVersion = data[0].sys_id;

  updateRecordTrackedVersion(table, recordId, latestVersion);

  return {
    success: true,
    message: `${recSummary} pushed successfully!`,
  };
};

export const snClient = (authParams: Sinc.LoginAnswers) => {
  const updateATFfile = (contents: string, sysId: string) => {
    const endpoint = "api/x_nuvo_sinc/pushATFfile";
    try {
      return connection.post(endpoint, { file: contents, sys_id: sysId });
    } catch (e) {
      throw e;
    }
  };

  const updateRecord = (
    table: string,
    recordId: string,
    fields: Record<string, string>
  ) => {
    if (table === Tables.AtfStep) {
      updateATFfile(fields["inputs.script"], recordId);
    }
    const endpoint = `api/now/table/${table}/${recordId}`;
    return connection.patch(endpoint, fields);
  };

  const getCurrentAppUserPrefSysId = async (userSysId: string) => {
    const data = await snGetTable(Tables.UserPreference, {
      sysparm_query: { user: userSysId, name: "apps.current_app" },
      sysparm_fields: ["sys_id"],
    });
    return data[0].sys_id;
  };

  const updateCurrentAppUserPref = (
    appSysId: string,
    userPrefSysId: string
  ) => {
    const endpoint = `api/now/table/${Tables.UserPreference}/${userPrefSysId}`;
    return connection.put(endpoint, { value: appSysId });
  };

  const createCurrentAppUserPref = (appSysId: string, userSysId: string) => {
    const endpoint = `api/now/table/${Tables.UserPreference}`;
    return connection.post(endpoint, {
      value: appSysId,
      name: "apps.current_app",
      type: "string",
      user: userSysId,
    });
  };

  const createUpdateSet = (updateSetName: string) => {
    const endpoint = `api/now/table/${Tables.UpdateSet}`;
    type UpdateSetCreateResponse = Sinc.SNAPIResponse<SN.UpdateSetRecord>;
    return connection.post<UpdateSetCreateResponse>(endpoint, {
      name: updateSetName,
    });
  };

  const getCurrentUpdateSetId = async (userSysId: string): Promise<string> => {
    const data = await snGetTable(Tables.UserPreference, {
      sysparm_query: `user=${userSysId}^name=${Tables.UpdateSet}`,
      sysparm_fields: ["value"],
    });
    return data[0]?.value || "";
  };

  const getCurrentUpdateSetUserPref = async (userSysId: string) => {
    const data = await snGetTable(Tables.UserPreference, {
      sysparm_query: `user=${userSysId}^name=${Tables.UpdateSet}`,
      sysparm_fields: ["sys_id"],
    });
    return data[0].sys_id;
  };

  const updateCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userPrefSysId: string
  ) => {
    const endpoint = `api/now/table/${Tables.UserPreference}/${userPrefSysId}`;
    return connection.put(endpoint, { value: updateSetSysId });
  };

  const createCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userSysId: string
  ) => {
    const endpoint = `api/now/table/${Tables.UserPreference}`;
    return connection.put(endpoint, {
      value: updateSetSysId,
      name: "sys_update_set",
      type: "string",
      user: userSysId,
    });
  };

  const getCurrentUpdateSetChanges = async (): Promise<
    Record<string, string[]>
  > => {
    const { updateSetChangeTypes = [] } = await ConfigManager.getUsSincConfig();

    if (!updateSetChangeTypes.length) return {};

    const userId = await getUserSysId();
    const updateSetId = await getCurrentUpdateSetId(userId);

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
      if (!changes[table]) {
        changes[table] = [];
      }
      changes[table].push(id);
    });
    return changes;
  };

  return {
    updateRecord,
    getCurrentAppUserPrefSysId,
    updateCurrentAppUserPref,
    createCurrentAppUserPref,
    createUpdateSet,
    getCurrentUpdateSetUserPref,
    updateCurrentUpdateSetUserPref,
    createCurrentUpdateSetUserPref,
    getCurrentUpdateSetChanges,
  };
};

let internalClient: SNClient | undefined = undefined;
export const defaultClient = () => {
  if (internalClient) {
    return internalClient;
  }
  const {
    SN_USER: username = "",
    SN_PASSWORD: password = "",
    SN_INSTANCE: instance = "",
  } = process.env;
  internalClient = snClient({ instance, username, password });
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
