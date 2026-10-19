import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { TbFingerprint } from "react-icons/tb";
import useTranslate from "../../../hooks/useTranslate.hook";
import passkeyService from "../../../services/passkey.service";

export const PASSKEYS_QUERY_KEY = ["passkeys"];

/** Passkeys of the account: those added from it and the signing ones. */
export function useAccountPasskeys(enabled = true) {
  return useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: passkeyService.list,
    enabled,
  });
}

/**
 * Shown where a copy is approved when the account has no passkey at all.
 * Adding one asks for the password and the 2FA code: it lives in the
 * account settings.
 */
export default function ApprovalPasskeyRequired() {
  const t = useTranslate();
  const { data } = useAccountPasskeys();

  if (!data || data.passkeys.length + data.signingPasskeys > 0) return null;

  return (
    <Alert color="orange" icon={<TbFingerprint size={18} />}>
      <Stack gap="xs">
        <Text size="sm">{t("team.audit.passkeys.required")}</Text>
        <Group>
          <Button size="xs" component={Link} href="/account#passkeys">
            {t("team.audit.passkeys.create")}
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
