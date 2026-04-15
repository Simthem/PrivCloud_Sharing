import {
  CreateUser,
  CurrentUser,
  UpdateCurrentUser,
  UpdateUser,
} from "../types/user.type";
import api from "./api.service";
import authService from "./auth.service";
import { getCookie } from "cookies-next";

const list = async () => {
  return (await api.get("/users")).data;
};

const create = async (user: CreateUser) => {
  return (await api.post("/users", user)).data;
};

const update = async (id: string, user: UpdateUser) => {
  return (await api.patch(`/users/${id}`, user)).data;
};

const remove = async (id: string) => {
  await api.delete(`/users/${id}`);
};

const updateCurrentUser = async (user: UpdateCurrentUser) => {
  return (await api.patch("/users/me", user)).data;
};

const removeCurrentUser = async () => {
  await api.delete("/users/me");
};

const getCurrentUser = async (): Promise<CurrentUser | null> => {
  try {
    await authService.refreshAccessToken();
    // If there is still no session after refresh, the user is not
    // authenticated - skip the network call to avoid a pointless 401.
    // access_token is httpOnly -- use logged_in as the non-httpOnly sentinel.
    if (!getCookie("logged_in")) return null;
    return (await api.get("users/me")).data;
  } catch {
    return null;
  }
};

// --- E2E Encryption Key Management ---

const setEncryptionKeyHash = async (keyHash: string) => {
  return (await api.put("/users/me/encryption-key", { keyHash })).data;
};

const removeEncryptionKey = async () => {
  await api.delete("/users/me/encryption-key");
};

const verifyEncryptionKey = async (keyHash: string): Promise<boolean> => {
  const result = (
    await api.post("/users/me/encryption-key/verify", { keyHash })
  ).data;
  return result.valid;
};

export default {
  list,
  create,
  update,
  remove,
  getCurrentUser,
  updateCurrentUser,
  removeCurrentUser,
  setEncryptionKeyHash,
  removeEncryptionKey,
  verifyEncryptionKey,
};
