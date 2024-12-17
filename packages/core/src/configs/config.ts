import { SN, Sinc, TSFIXME } from "@sincronia/types";
import path from "path";
import { promises as fsp } from "fs";
import { logger } from "../cli/Logger";
import * as fUtils from "../utils/fileUtils";
import { defaultIncludes } from "./defaultTables";
import { pickBy } from "lodash";

const DEFAULT_CONFIG: Required<Sinc.Config> = {
  sourceDirectory: "src",
  buildDirectory: "build",
  rules: [],
  excludes: [],
  includes: {},
  refreshInterval: 30,
};

const isRoot = (pth: string): boolean => path.parse(pth).root === pth;

class Manager {
  private root_dir: string | undefined;
  private config: Sinc.Config | undefined;
  private manifest: SN.AppManifest | undefined;
  private config_path: string | undefined;
  private source_path: string | undefined;
  private build_path: string | undefined;
  private env_path: string | undefined;
  private manifest_path: string | undefined;
  private diff_path: string | undefined;
  private diff_file: Sinc.DiffFile | undefined;
  private refresh_interval: number | undefined;
  private update_set_path: string | undefined;
  private update_set_file: TSFIXME;

  loadConfigs = async (): Promise<void> => {
    try {
      let noConfigPath = false; //Prevents logging error messages during init
      const cfg_path = await this.loadConfigPath();
      if (cfg_path) this.config_path = cfg_path;
      else noConfigPath = true;

      if (noConfigPath) {
        this.root_dir = process.cwd();
        this.env_path = path.join(this.root_dir, ".env");
        return;
      }

      const configPath = this.getConfigPath();
      if (configPath) this.root_dir = path.dirname(configPath);
      const rootDir = process.cwd();
      this.root_dir = rootDir;
      this.env_path = path.join(rootDir, ".env");

      const cfg = await this.loadConfig(noConfigPath);
      if (cfg) this.config = cfg;

      const {
        sourceDirectory = "src",
        buildDirectory = "build",
        refreshInterval = 30,
      } = cfg;

      this.source_path = path.join(rootDir, sourceDirectory);
      this.build_path = path.join(rootDir, buildDirectory);
      this.refresh_interval = refreshInterval;
      this.manifest_path = path.join(rootDir, "sinc.manifest.json");
      this.diff_path = path.join(rootDir, "sinc.diff.manifest.json");
      this.update_set_path = await this.loadUsConfigPath();
      this.update_set_file = await this.loadUSFile();

      try {
        const diffString = await fsp.readFile(this.getDiffPath(), "utf-8");
        this.diff_file = JSON.parse(diffString);
      } catch (e) {}

      try {
        const manifestString = await fsp.readFile(
          this.getManifestPath(),
          "utf-8"
        );
        this.manifest = JSON.parse(manifestString);
      } catch (e) {}
    } catch (e) {
      throw e;
    }
  };

  getConfig(): Sinc.Config {
    if (this.config) return this.config;
    throw new Error("Error getting config");
  }

  getConfigPath(): string {
    if (this.config_path) return this.config_path;
    throw new Error("Error getting config path");
  }

  checkConfigPath(): string | false {
    if (this.config_path) return this.config_path;
    return false;
  }

  getRootDir(): string {
    if (this.root_dir) return this.root_dir;
    throw new Error("Error getting root directory");
  }

  getManifest(): SN.AppManifest {
    if (this.manifest) return this.manifest;
    throw new Error("Error getting manifest");
  }

  getManifestPath(): string {
    if (this.manifest_path) return this.manifest_path;
    throw new Error("Error getting manifest path");
  }

  getSourcePath(): string {
    if (this.source_path) return this.source_path;
    throw new Error("Error getting source path");
  }

  getBuildPath(): string {
    if (this.build_path) return this.build_path;
    throw new Error("Error getting build path");
  }

  getEnvPath(): string {
    if (this.env_path) return this.env_path;
    throw new Error("Error getting env path");
  }

  getDiffPath(): string {
    if (this.diff_path) return this.diff_path;
    throw new Error("Error getting diff path");
  }

  getDiffFile(): Sinc.DiffFile {
    if (this.diff_file) return this.diff_file;
    throw new Error("Error getting diff file");
  }

  getRefresh(): number {
    if (this.refresh_interval) return this.refresh_interval;
    throw new Error("Error getting refresh interval");
  }

  writeDefaultConfig = async () => {
    try {
      const pth = path.join(process.cwd(), "sinc.config.js");
      const defaultFile = `module.exports = ${JSON.stringify(
        DEFAULT_CONFIG,
        null,
        4
      )};
      `.trim();
      await fsp.writeFile(pth, defaultFile);
      this.loadConfigs();
    } catch (e) {
      throw e;
    }
  };

  private loadConfig = async (skipConfigPath = false): Promise<Sinc.Config> => {
    if (skipConfigPath) {
      logger.warn("Couldn't find config file. Loading default...");
      return DEFAULT_CONFIG;
    }
    try {
      const configPath = this.getConfigPath();
      if (configPath) {
        const projectConfig: Sinc.Config = (await import(configPath)).default;
        //merge in includes/excludes
        const { excludes = [], includes = {} } = projectConfig;
        const filteredIncludes = pickBy(
          defaultIncludes,
          (_, table) => !excludes.includes(table)
        );
        projectConfig.includes = { ...filteredIncludes, ...includes };
        return projectConfig;
      } else {
        logger.warn("Couldn't find config file. Loading default...");
        return DEFAULT_CONFIG;
      }
    } catch (e: unknown) {
      if (e instanceof Error) logger.warn(e.message);
      logger.warn("Couldn't find config file. Loading default...");
      return DEFAULT_CONFIG;
    }
  };

  private loadUSFile = async () => {
    try {
      const usSincConfigPath = this.update_set_path;
      if (usSincConfigPath) return (await import(usSincConfigPath)).default;
      return {};
    } catch (e: unknown) {
      throw new Error("Error getting diff file");
    }
  };

  updateManifest(man: SN.AppManifest): void {
    this.manifest = man;
    fUtils.writeManifestFile(man);
  }

  private loadConfigPath = async (pth?: string): Promise<string | false> => {
    if (!pth) pth = process.cwd();
    const files = await fsp.readdir(pth);
    if (files.includes("sinc.config.js"))
      return path.join(pth, "sinc.config.js");
    if (isRoot(pth)) return false;
    return this.loadConfigPath(path.dirname(pth));
  };

  private loadUsConfigPath = async (
    pth?: string
  ): Promise<string | undefined> => {
    if (!pth) pth = process.cwd();
    const files = await fsp.readdir(pth);
    if (files.includes("us-sinc.config.js"))
      return path.join(pth, "us-sinc.config.js");
    if (isRoot(pth)) return undefined;
    return this.loadUsConfigPath(path.dirname(pth));
  };

  getUsSincConfig = async (): Promise<TSFIXME> => {
    if (this.update_set_file) return this.update_set_file;
    throw new Error("Error getting config");
  };
}

const managerInst = new Manager();
export { managerInst as ConfigManager };