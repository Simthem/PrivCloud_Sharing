import useUser from "../../hooks/user.hook";
import { openSigningKey } from "../../utils/signingKeyEnvelope.util";
import toast from "../../utils/toast.util";
import { useState } from "react";
import { ActionIcon, Button, Tooltip } from "@mantine/core";
import { useRouter } from "next/router";
import { TbWritingSign } from "react-icons/tb";
import type { SignatureRequest } from "../../services/signing.service";
import useTranslate from "../../hooks/useTranslate.hook";
import {
  exportKeyToBase64,
  getUserKey,
  importKeyFromBase64,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";

export default function SigningActionButton({
  action,
  e2eKey,
  compact = false,
}: {
  action?: SignatureRequest["signingAction"];
  e2eKey?: string | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const { user } = useUser();
  const t = useTranslate();
  const [opening, setOpening] = useState(false);
  if (!action || !/^\/sign\/[A-Za-z0-9_-]+$/.test(action.path)) return null;

  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      let key = e2eKey;
      const masterKey = getUserKey();
      if (!key && masterKey && action.wrappedE2EKey) {
        try {
          key = await exportKeyToBase64(
            await unwrapReverseShareKey(
              action.wrappedE2EKey,
              await importKeyFromBase64(masterKey),
            ),
          );
        } catch {
          // The signing page also accepts the key from the original invitation.
        }
      }
      if (!key && typeof window !== "undefined") {
        try {
          const cached = window.sessionStorage.getItem(
            `signing.link-key:${action.path.slice("/sign/".length)}`,
          );
          if (cached && /^[A-Za-z0-9_-]{43}$/.test(cached)) key = cached;
        } catch {
          /* Storage may be unavailable in this browser. */
        }
      }
      if (!key && masterKey && action.keyEnvelope) {
        if (!user || user.id !== action.keyEnvelope.recipientUserId)
          throw new Error("Signing key account mismatch");
        key = await openSigningKey(
          action.keyEnvelope.ciphertext,
          {
            documentId: action.keyEnvelope.documentId,
            fileId: action.keyEnvelope.fileId,
            recipientUserId: user.id,
          },
          await importKeyFromBase64(masterKey),
        );
      }
      if (action.isE2EEncrypted && !key)
        throw new Error("Signing key unavailable");
      const fragment =
        key && /^[A-Za-z0-9_-]{16,4096}$/.test(key) ? `#key=${key}` : "";
      await router.push(`${action.path}${fragment}`);
    } catch {
      toast.error(t("signing.key.unavailable"));
    } finally {
      setOpening(false);
    }
  };
  const label = t("signing.sign.steps.sign");
  return compact ? (
    <Tooltip label={label}>
      <ActionIcon
        aria-label={label}
        variant="light"
        color="green"
        size="sm"
        loading={opening}
        onClick={open}
      >
        <TbWritingSign size={14} />
      </ActionIcon>
    </Tooltip>
  ) : (
    <Button
      leftSection={<TbWritingSign size={16} />}
      loading={opening}
      onClick={open}
    >
      {label}
    </Button>
  );
}
