export type {
  AppConfig,
  ConfigDescriptor,
  ConfigKind,
  ConfigScope,
  ConfigSectionId,
  ConfigSensitivity,
  ConfigType,
  SettingsManifest,
  SettingsManifestField,
  SettingsManifestSection,
} from "./registry.js";
export {
  CONFIG_REGISTRY,
  ConfigValidationError,
  getConfig,
  getConfigDescriptorByEnvVar,
  getConfigDescriptorByKey,
  getConfigDict,
  getPersistedConfig,
  getSettingsManifest,
  getVisibleConfigDescriptors,
  isIpAllowed,
  parseAllowedHosts,
  preparePersistedConfigUpdate,
  saveConfigDict,
} from "./registry.js";

import { getConfig } from "./registry.js";
import type { AppConfig } from "./registry.js";

export const BUS_VERSION = "0.2.7";
export const ADMIN_TOKEN: string | null = getConfig().adminToken;
export const ENABLE_HANDOFF_TARGET = getConfig().enableHandoffTarget;
export const ENABLE_STOP_REASON = getConfig().enableStopReason;
export const ENABLE_PRIORITY = getConfig().enablePriority;

export function isNonLocalhostDeployment(config: Pick<AppConfig, "host" | "showAd">): boolean {
  return config.showAd || (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost");
}
