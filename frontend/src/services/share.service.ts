import { deleteCookie, setCookie } from "cookies-next";
import mime from "mime-types";
import { FileUploadResponse } from "../types/File.type";
import {
  decryptFile,
  downloadDecryptedBlob,
  importKeyFromBase64,
} from "../utils/crypto.util";

import {
  CreateReverseShare,
  CreateShare,
  MyReverseShare,
  MyShare,
  ReverseShare,
  Share,
  ShareMetaData,
} from "../types/share.type";
import { isTextBasedMimeType } from "../components/share/FilePreview";
import api from "./api.service";

const list = async (): Promise<MyShare[]> => {
  return (await api.get(`shares/all`)).data;
};

const create = async (share: CreateShare, isReverseShare = false) => {
  if (!isReverseShare) {
    deleteCookie("reverse_share_token");
  }
  return (await api.post("shares", share)).data;
};

const completeShare = async (id: string, e2eKey?: string) => {
  const response = (
    await api.post(`shares/${id}/complete`, e2eKey ? { e2eKey } : {})
  ).data;
  deleteCookie("reverse_share_token");
  return response;
};

const revertComplete = async (id: string) => {
  return (await api.delete(`shares/${id}/complete`)).data;
};

const get = async (id: string): Promise<Share> => {
  return (await api.get(`shares/${id}`)).data;
};

const getFromOwner = async (id: string): Promise<Share> => {
  return (await api.get(`shares/${id}/from-owner`)).data;
};

const getMetaData = async (id: string): Promise<ShareMetaData> => {
  return (await api.get(`shares/${id}/metaData`)).data;
};

const remove = async (id: string) => {
  await api.delete(`shares/${id}`);
};

const getMyShares = async (): Promise<MyShare[]> => {
  return (await api.get("shares")).data;
};

const getStoredRecipients = async (): Promise<Array<string>> => {
  return (await api.get("shares/recipients")).data;
};

const getShareToken = async (id: string, password?: string, captchaToken?: string) => {
  await api.post(`/shares/${id}/token`, {
    password,
    ...(captchaToken && { captchaToken }),
  });
};

const isShareIdAvailable = async (id: string): Promise<boolean> => {
  return (await api.get(`/shares/isShareIdAvailable/${id}`)).data.isAvailable;
};

const doesFileSupportPreview = (fileName: string) => {
  const mimeType = (mime.contentType(fileName) || "").split(";")[0];

  if (!mimeType) return false;

  return (
    mimeType.startsWith("video/") ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf" ||
    isTextBasedMimeType(mimeType)
  );
};

const downloadFile = async (shareId: string, fileId: string) => {
  window.location.href = `/api/shares/${shareId}/files/${fileId}`;
};

/**
 * Télécharge un fichier chiffré E2E, le déchiffre côté client,
 * puis déclenche le téléchargement du fichier en clair.
 */
const downloadFileE2E = async (
  shareId: string,
  fileId: string,
  fileName: string,
  encodedKey: string,
) => {
  const key = await importKeyFromBase64(encodedKey);
  const response = await api.get(`shares/${shareId}/files/${fileId}`, {
    responseType: "arraybuffer",
  });
  const decrypted = await decryptFile(response.data, key);
  const mimeType = (
    mime.contentType(fileName) || "application/octet-stream"
  ).split(";")[0];
  const blob = new Blob([decrypted], { type: mimeType });
  downloadDecryptedBlob(blob, fileName);
};

/**
 * Récupère un fichier chiffré E2E sous forme d'ArrayBuffer déchiffré.
 * Utilisé pour les previews.
 */
const fetchDecryptedFile = async (
  shareId: string,
  fileId: string,
  encodedKey: string,
): Promise<ArrayBuffer> => {
  const key = await importKeyFromBase64(encodedKey);
  const response = await api.get(`shares/${shareId}/files/${fileId}`, {
    responseType: "arraybuffer",
  });
  return decryptFile(response.data, key);
};

const removeFile = async (shareId: string, fileId: string) => {
  await api.delete(`shares/${shareId}/files/${fileId}`);
};

const uploadFile = async (
  shareId: string,
  chunk: Blob,
  file: {
    id?: string;
    name: string;
  },
  chunkIndex: number,
  totalChunks: number,
): Promise<FileUploadResponse> => {
  return (
    await api.post(`shares/${shareId}/files`, chunk, {
      headers: { "Content-Type": "application/octet-stream" },
      params: {
        id: file.id,
        name: file.name,
        chunkIndex,
        totalChunks,
      },
    })
  ).data;
};

const createReverseShare = async (reverseShare: CreateReverseShare) => {
  return (await api.post("reverseShares", reverseShare)).data;
};

const getMyReverseShares = async (): Promise<MyReverseShare[]> => {
  return (await api.get("reverseShares")).data;
};

const getReverseShare = async (
  reverseShareToken: string,
): Promise<ReverseShare> => {
  const { data } = await api.get(`/reverseShares/${reverseShareToken}`);
  setCookie("reverse_share_token", reverseShareToken);
  return data;
};

const removeReverseShare = async (id: string) => {
  await api.delete(`/reverseShares/${id}`);
};

const updateReverseShare = async (
  id: string,
  data: { shareExpiration: string },
) => {
  await api.patch(`/reverseShares/${id}`, data);
};

/**
 * Fetch the encrypted reverse share key (K_rs wrapped by K_master)
 * for E2E reverse share decryption. Requires authenticated user = RS creator.
 *
 * NOTE: The share page now reads encryptedReverseShareKey directly from the
 * share data (GET /shares/:id). This function is kept for external API clients.
 * Errors are propagated — callers must handle them.
 */
const getEncryptedE2eKey = async (
  shareId: string,
): Promise<string | null> => {
  const { data } = await api.get(`/shares/${shareId}/e2e-key`);
  return data?.encryptedReverseShareKey ?? null;
};

export default {
  list,
  create,
  completeShare,
  revertComplete,
  getShareToken,
  get,
  getFromOwner,
  remove,
  getMetaData,
  doesFileSupportPreview,
  getMyShares,
  isShareIdAvailable,
  downloadFile,
  downloadFileE2E,
  fetchDecryptedFile,
  removeFile,
  uploadFile,
  getReverseShare,
  createReverseShare,
  getMyReverseShares,
  removeReverseShare,
  updateReverseShare,
  getEncryptedE2eKey,
  getStoredRecipients,
};

export { fetchDecryptedFile, downloadFileE2E };
