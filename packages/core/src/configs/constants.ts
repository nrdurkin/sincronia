import path from "path";

export const PATH_DELIMITER = `${path.delimiter}${path.delimiter}`;

export const PUSH_RETRY_WAIT = 3000;
export const PUSH_RETRY_LIMIT = 3;

export enum Tables {
  UpdateVersion = "sys_update_version",
  AtfStep = "sys_atf_step",
  User = "sys_user",
  UserPreference = "sys_user_preference",
  UpdateSet = "sys_update_set",
  UpdateXML = "sys_update_xml",
  App = "sys_app",
}
