import { Button, Group, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { cleanNotifications } from "@mantine/notifications";
import { AxiosError } from "axios";
import pLimit from "p-limit";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import Dropzone from "../../components/upload/Dropzone";
import FileList from "../../components/upload/FileList";
import showCompletedUploadModal from "../../components/upload/modals/showCompletedUploadModal";
import showCreateUploadModal from "../../components/upload/modals/showCreateUploadModal";
import useConfig from "../../hooks/config.hook";
import useConfirmLeave from "../../hooks/confirm-leave.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import shareService from "../../services/share.service";
import { FileUpload } from "../../types/File.type";
import { CreateShare, Share } from "../../types/share.type";
import toast from "../../utils/toast.util";
import {
  generateEncryptionKey,
  exportKeyToBase64,
  importKeyFromBase64,
  encryptFile,
  computeKeyHash,
  getUserKey,
  storeUserKey,
  extractKeyFromHash,
} from "../../utils/crypto.util";
import userService from "../../services/user.service";
import { useRouter } from "next/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const promiseLimit = pLimit(3);
let errorToastShown = false;
let createdShare: Share;
let e2eKeyEncoded: string | null = null;

type UploadProps = {
  maxShareSize?: number;
  isReverseShare: boolean;
  isE2EEncrypted?: boolean;
  simplified: boolean;
  name?: string;
}

const Upload = ({
  maxShareSize,
  isReverseShare = false,
  isE2EEncrypted = false,
  simplified,
  name,
}: UploadProps) => {
  const modals = useModals();
  const router = useRouter();
  const t = useTranslate();

  const queryClient = useQueryClient();

  const { user } = useUser();
  const config = useConfig();
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [isUploading, setisUploading] = useState(false);

  useConfirmLeave({
    message: t("upload.notify.confirm-leave"),
    enabled: isUploading,
  });

  const enableRecipientRetrieval = !isReverseShare
    && config.get("email.enableShareEmailRecipients")
    && config.get("email.enableShareEmailPastRecipients")
    && !!user;

  const { data: pastRecipients } = useQuery({
    queryKey: ["share.pastRecipients"],
    queryFn: () => shareService.getStoredRecipients(),
    enabled: enableRecipientRetrieval,
    refetchInterval: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  })

  const chunkSize = useRef(parseInt(config.get("share.chunkSize")));

  maxShareSize ??= parseInt(config.get("share.maxSize"));
  const autoOpenCreateUploadModal = config.get("share.autoOpenShareModal");

  const uploadFiles = async (share: CreateShare, files: FileUpload[]) => {
    setisUploading(true);

    // ── E2E : récupérer ou créer la clé de chiffrement ──
    let cryptoKey: CryptoKey | null = null;
    let storedKey = user ? getUserKey() : null;

    if (isReverseShare && isE2EEncrypted) {
      // Reverse share E2E : lire K_rs depuis le fragment d'URL
      const rsKeyEncoded = extractKeyFromHash();
      if (rsKeyEncoded) {
        cryptoKey = await importKeyFromBase64(rsKeyEncoded);
        e2eKeyEncoded = rsKeyEncoded;
        share.isE2EEncrypted = true;
      } else {
        // Clé absente du fragment → pas de chiffrement
        e2eKeyEncoded = null;
      }
    } else if (user) {
      if (storedKey) {
        // Clé existante → réutiliser
        cryptoKey = await importKeyFromBase64(storedKey);
        e2eKeyEncoded = storedKey;
      } else {
        // Première utilisation → générer, stocker et enregistrer le hash
        cryptoKey = await generateEncryptionKey();
        e2eKeyEncoded = await exportKeyToBase64(cryptoKey);
        storeUserKey(e2eKeyEncoded);
        const hash = await computeKeyHash(cryptoKey);
        await userService.setEncryptionKeyHash(hash);
      }
      share.isE2EEncrypted = true;
    } else {
      // Upload anonyme : pas de chiffrement E2E
      e2eKeyEncoded = null;
    }

    try {
      const isReverseShare = router.pathname != "/upload";
      createdShare = await shareService.create(share, isReverseShare);
    } catch (e) {
      toast.axiosError(e);
      setisUploading(false);
      e2eKeyEncoded = null;
      return;
    }

    // Stocker la clé localement pour le propriétaire (déjà fait dans storeUserKey ci-dessus)

    const fileUploadPromises = files.map(async (file, fileIndex) =>
      // Limit the number of concurrent uploads to 3
      promiseLimit(async () => {
        let fileId;

        const setFileProgress = (progress: number) => {
          setFiles((files) =>
            files.map((file, callbackIndex) => {
              if (fileIndex == callbackIndex) {
                file.uploadingProgress = progress;
              }
              return file;
            }),
          );
        };

        setFileProgress(1);

        // Chiffrer le fichier avant upload si E2E activé
        let uploadBlob: Blob;
        if (share.isE2EEncrypted) {
          const plainBuf = await file.arrayBuffer();
          const encryptedBuf = await encryptFile(plainBuf, cryptoKey!);
          uploadBlob = new Blob([encryptedBuf]);
        } else {
          uploadBlob = file;
        }

        let chunks = Math.ceil(uploadBlob.size / chunkSize.current);

        // If the file is 0 bytes, we still need to upload 1 chunk
        if (chunks == 0) chunks++;

        for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
          const from = chunkIndex * chunkSize.current;
          const to = from + chunkSize.current;
          const blob = uploadBlob.slice(from, to);
          try {
            await shareService
              .uploadFile(
                createdShare.id,
                blob,
                {
                  id: fileId,
                  name: file.name,
                },
                chunkIndex,
                chunks,
              )
              .then((response) => {
                fileId = response.id;
              });

            setFileProgress(((chunkIndex + 1) / chunks) * 100);
          } catch (e) {
            if (
              e instanceof AxiosError &&
              e.response?.data.error == "unexpected_chunk_index"
            ) {
              // Retry with the expected chunk index
              chunkIndex = e.response!.data!.expectedChunkIndex - 1;
              continue;
            } else {
              setFileProgress(-1);
              // Retry after 5 seconds
              await new Promise((resolve) => setTimeout(resolve, 5000));
              chunkIndex = -1;

              continue;
            }
          }
        }
      }),
    );

    Promise.all(fileUploadPromises);
  };

  const showCreateUploadModalCallback = (files: FileUpload[]) => {
    showCreateUploadModal(
      modals,
      {
        isUserSignedIn: user ? true : false,
        isReverseShare,
        allowUnauthenticatedShares: config.get(
          "share.allowUnauthenticatedShares",
        ),
        enableEmailRecepients: config.get("email.enableShareEmailRecipients"),
        maxExpiration: config.get("share.maxExpiration"),
        shareIdLength: config.get("share.shareIdLength"),
        simplified,
      },
      files,
      uploadFiles,
      pastRecipients,
    );
  };

  const handleDropzoneFilesChanged = (files: FileUpload[]) => {
    if (autoOpenCreateUploadModal) {
      setFiles(files);
      showCreateUploadModalCallback(files);
    } else {
      setFiles((oldArr) => [...oldArr, ...files]);
    }
  };

  useEffect(() => {
    // Check if there are any files that failed to upload
    const fileErrorCount = files.filter(
      (file) => file.uploadingProgress == -1,
    ).length;

    if (fileErrorCount > 0) {
      if (!errorToastShown) {
        toast.error(
          t("upload.notify.count-failed", { count: fileErrorCount }),
          {
            withCloseButton: false,
            autoClose: false,
          },
        );
      }
      errorToastShown = true;
    } else {
      cleanNotifications();
      errorToastShown = false;
    }

    // Complete share
    if (
      files.length > 0 &&
      files.every((file) => file.uploadingProgress >= 100) &&
      fileErrorCount == 0
    ) {
      shareService
        .completeShare(createdShare.id)
        .then((share) => {
          setisUploading(false);
          showCompletedUploadModal(modals, share, e2eKeyEncoded);
          queryClient.invalidateQueries({
            queryKey: ["share.pastRecipients"],
          })
          setFiles([]);
          e2eKeyEncoded = null;
        })
        .catch(() => toast.error(t("upload.notify.generic-error")));
    }
  }, [files]);

  return (
    <>
      <Meta title={t("upload.title")} />
      <Group {...(name ? { position: "apart" } : { position: "right" })} mb={20}>
        {name && (
          <Title order={3}>{name}</Title>
        )}
        <Button
          loading={isUploading}
          disabled={files.length <= 0}
          onClick={() => showCreateUploadModalCallback(files)}
        >
          <FormattedMessage id="common.button.share" />
        </Button>
      </Group>
      <Dropzone
        title={
          !autoOpenCreateUploadModal && files.length > 0
            ? t("share.edit.append-upload")
            : undefined
        }
        maxShareSize={maxShareSize}
        onFilesChanged={handleDropzoneFilesChanged}
        isUploading={isUploading}
      />
      {files.length > 0 && (
        <FileList<FileUpload> files={files} setFiles={setFiles} />
      )}
    </>
  );
};
export default Upload;
