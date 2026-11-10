import { createContext, useContext } from "react";
import { stringToTimespan } from "../utils/date.util";
import type { Timespan } from "../types/timespan.type";
import { ConfigHook } from "../types/config.type";

export const ConfigContext = createContext<ConfigHook>({
  configVariables: [],
  refresh: async () => {},
});

export type ConfigValue = string | number | boolean | Timespan;

const useConfig = () => {
  const configContext = useContext(ConfigContext);
  const get = (key: string): ConfigValue | null => {
    const configVariable = configContext.configVariables?.find(
      (variable) => variable.key == key,
    );
    if (!configVariable) return null;

    const value = configVariable.value ?? configVariable.defaultValue;

    if (configVariable.type == "number" || configVariable.type == "filesize")
      return parseInt(value);
    if (configVariable.type == "boolean") return value == "true";
    if (configVariable.type == "timespan") return stringToTimespan(value);
    return value;
  };
  // Each setting has the type its configuration seed declares.
  return {
    get,
    getString: (key: string) => get(key) as string,
    getNumber: (key: string) => get(key) as number,
    getBoolean: (key: string) => get(key) as boolean,
    getTimespan: (key: string) => get(key) as Timespan,
    refresh: async () => configContext.refresh(),
  };
};

export default useConfig;
