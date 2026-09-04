import { Center, Loader, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useEffect } from "react";
import useUser from "../../../hooks/user.hook";
import { decryptNotificationMetadata } from "../../../services/crypto.service";
import {
  getTeamNotification,
  markNotificationRead,
} from "../../../services/teamNotification.service";
import { getUserKey, importKeyFromBase64 } from "../../../utils/crypto.util";
import { isSafeSigningNotificationAction } from "../../../utils/signingNotification.util";

/**
 * Web Push only receives this opaque notification id. After authentication the
 * browser decrypts the durable payload locally and immediately opens its
 * intended signing action; no action URL is exposed to the push provider.
 */
export default function OpenEncryptedNotification() {
  const router = useRouter();
  const { user } = useUser();
  const id = typeof router.query.id === "string" ? router.query.id : "";
  const { data: notification } = useQuery({
    queryKey: ["team-notification", id],
    queryFn: () => getTeamNotification(id),
    enabled: Boolean(id && user),
    retry: false,
  });

  useEffect(() => {
    if (!router.isReady || user || !id) return;
    const timer = window.setTimeout(() => {
      router.replace(
        `/auth/signIn?redirect=${encodeURIComponent(router.asPath)}`,
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [id, router, user]);

  useEffect(() => {
    if (!notification) return;
    const resolve = async () => {
      if (notification.encryptedMetadata) {
        const storedKey = getUserKey();
        if (storedKey) {
          const metadata = await decryptNotificationMetadata(
            notification.encryptedMetadata,
            await importKeyFromBase64(storedKey),
          );
          if (isSafeSigningNotificationAction(metadata?.actionUrl)) {
            void markNotificationRead(notification.id);
            await router.replace(metadata.actionUrl);
            return;
          }
        }
      }
      await router.replace(
        notification.team
          ? `/team/${notification.team.id}`
          : "/team?tab=notifications",
      );
    };
    void resolve();
  }, [notification, router]);

  return (
    <Center mih="50vh">
      <Loader size="sm" />
      <Text ml="sm">Ouverture de la notification chiffrée…</Text>
    </Center>
  );
}
