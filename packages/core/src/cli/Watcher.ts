import chokidar from "chokidar";
import { logFilePush } from "./logMessages";
import { debounce } from "lodash";
import { getFileContextFromPath } from "../utils/fileUtils";
import { Sinc } from "@sincronia/types";
import { groupAppFiles } from "../appUtils";
import { pushFiles } from "../services/pushFiles";
const DEBOUNCE_MS = 300;
let pushQueue: string[] = [];

const processQueue = debounce(async () => {
  if (pushQueue.length > 0) {
    //dedupe pushes
    const toProcess = Array.from(new Set([...pushQueue]));
    pushQueue = [];
    const fileContexts = toProcess
      .map(getFileContextFromPath)
      .filter((ctx): ctx is Sinc.FileContext => !!ctx);
    const buildables = groupAppFiles(fileContexts);
    const updateResults = await pushFiles(buildables);
    updateResults.forEach((res, index) => {
      logFilePush(fileContexts[index], res);
    });
  }
}, DEBOUNCE_MS);

export function startWatching(directory: string): void {
  chokidar.watch(directory).on("change", (path) => {
    pushQueue.push(path);
    processQueue();
  });
}
