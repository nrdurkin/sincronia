import { SN } from "@sincronia/types";
import fs, { promises as fsp } from "fs";

export const SNFileExists = (parentDirPath: string) => async (
  file: SN.File
): Promise<boolean> => {
  try {
    const files = await fsp.readdir(parentDirPath);
    const reg = new RegExp(`${file.name}\..*$`);
    return !!files.find((f) => reg.test(f));
  } catch (e) {
    return false;
  }
};
