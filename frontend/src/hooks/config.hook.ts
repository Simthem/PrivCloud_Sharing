import { createContext, useContext } from "react";
import { stringToTimespan } from "../utils/date.util";
import { ConfigHook } from "../types/config.type";

export const ConfigContext = createContext<ConfigHook>({
  configVariables: [],
  refresh: async () => {},
});

const useConfig = () => {
  const configContext = useContext(ConfigContext);
  return {
    get: (key: string): any => {
      if (!configContext.configVariables) return null;

      const configVariable = configContext.configVariables.find(
        (variable) => variable.key == key,
      );

      if (!configVariable) return null;

      const value = configVariable.value ?? configVariable.defaultValue;

      if (configVariable.type == "number" || configVariable.type == "filesize")
        return parseInt(value);
      if (configVariable.type == "boolean") return value == "true";
      if (configVariable.type == "string" || configVariable.type == "text")
        return value;
      if (configVariable.type == "timespan") return stringToTimespan(value);
    },
    refresh: async () => configContext.refresh(),
  };
};

export default useConfig;
