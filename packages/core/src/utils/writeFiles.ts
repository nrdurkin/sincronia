import { SN } from "@sincronia/types";
import fs, { promises as fsp } from "fs";
import { ConfigManager } from "../config";

export const writeManifestFile = async (man: SN.AppManifest): Promise<void> => {
  return fsp.writeFile(
    ConfigManager.getManifestPath(),
    JSON.stringify(man, null, 2)
  );
};
