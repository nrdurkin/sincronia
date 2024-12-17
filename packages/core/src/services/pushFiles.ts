import { Sinc } from "@sincronia/types";
import { AxiosResponse } from "axios";
import { snGetTable, updateRecord } from "../services/serviceNow";
import {
  PUSH_RETRY_LIMIT,
  PUSH_RETRY_WAIT,
  Tables,
} from "../configs/constants";
import { updateRecordTrackedVersion } from "../utils/processManifest";
import { parseString } from "xml2js";
import { logger } from "../cli/Logger";
import { getProgTick, summarizeRecord } from "./utils";
import { buildRec } from "./buildFiles";

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

const pushRec = async (
  table: string,
  sysId: string,
  builtRec: Record<string, string>,
  summary?: string
) => {
  const recSummary = summary ?? `${table} > ${sysId}`;
  try {
    const pushRes = await retryOnErr(
      () => updateRecord(table, sysId, builtRec),
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
