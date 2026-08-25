import axios from "axios";
import Config, { AdminConfig, UpdateConfig } from "../types/config.type";
import api from "./api.service";
import { stringToTimespan } from "../utils/date.util";
import {
  getRuntimeUploadChunkConfigKey,
  UploadChunkProfileName,
} from "../utils/uploadPerformance.util";

const list = async (): Promise<Config[]> => {
  return (await api.get("/configs")).data;
};

const getRuntimeUploadMaxChunkSize = async (
  profile: UploadChunkProfileName,
): Promise<number | null> => {
  const configVariables = await list();
  const hardLimit = get("runtime.uploadMaxChunkBytes", configVariables);
  const profileLimit = get(
    getRuntimeUploadChunkConfigKey(profile),
    configVariables,
  );
  if (Number.isFinite(hardLimit) && Number.isFinite(profileLimit)) {
    return Math.min(hardLimit, profileLimit);
  }
  if (Number.isFinite(profileLimit)) return profileLimit;
  if (Number.isFinite(hardLimit)) return hardLimit;
  return null;
};

const getByCategory = async (category: string): Promise<AdminConfig[]> => {
  return (await api.get(`/configs/admin/${category}`)).data;
};

const updateMany = async (data: UpdateConfig[]): Promise<AdminConfig[]> => {
  return (await api.patch("/configs/admin", data)).data;
};

const get = (key: string, configVariables: Config[]): any => {
  if (!configVariables) return null;

  const configVariable = configVariables.filter(
    (variable) => variable.key == key,
  )[0];

  if (!configVariable) return null;

  const value = configVariable.value ?? configVariable.defaultValue;

  if (configVariable.type == "number" || configVariable.type == "filesize")
    return parseInt(value);
  if (configVariable.type == "boolean") return value == "true";
  if (configVariable.type == "string" || configVariable.type == "text")
    return value;
  if (configVariable.type == "timespan") return stringToTimespan(value);
};

const finishSetup = async (): Promise<AdminConfig[]> => {
  return (await api.post("/configs/admin/finishSetup")).data;
};

const sendTestEmail = async (email: string) => {
  await api.post("/configs/admin/testEmail", { email });
};

const isNewReleaseAvailable = async () => {
  try {
    const response = (
      await axios.get(
        "https://api.github.com/repos/Simthem/PrivCloud_Sharing/releases/latest",
      )
    ).data;
    return response.tag_name.replace("v", "") != process.env.VERSION;
  } catch {
    return false;
  }
};

const changeLogo = async (file: File) => {
  const form = new FormData();
  form.append("file", file);

  await api.post("/configs/admin/logo", form);
};
export default {
  list,
  getRuntimeUploadMaxChunkSize,
  getByCategory,
  updateMany,
  get,
  finishSetup,
  sendTestEmail,
  isNewReleaseAvailable,
  changeLogo,
};
