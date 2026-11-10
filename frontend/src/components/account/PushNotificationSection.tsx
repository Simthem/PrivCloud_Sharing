import {
  Button,
  Collapse,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { TbBell, TbBellOff } from "react-icons/tb";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import api from "../../services/api.service";
import toast from "../../utils/toast.util";
import type { ThrownError } from "../../types/thrownError.type";
import classes from "./NotificationSettings.module.css";

function urlBase64ToUint8Array(value: string) {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export default function PushNotificationSection({
  children,
}: {
  children?: ReactNode;
}) {
  const config = useConfig();
  const t = useTranslate();
  const preferencesId = useId();
  const [mounted, setMounted] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [pushBlocked, setPushBlocked] = useState(false);
  const pushEnabled = config.getBoolean("pushNotifications.enabled");
  const vapidPublicKey = config.getString("pushNotifications.vapidPublicKey");
  useEffect(() => setMounted(true), []);
  const supported =
    mounted &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const configured = pushEnabled && !!vapidPublicKey;
  const checkSubscription = useCallback(async () => {
    if (!supported || !configured) return;
    setPermissionDenied(Notification.permission === "denied");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setSubscribed(!!subscription && Notification.permission === "granted");
    } catch {
      setSubscribed(false);
    }
  }, [supported, configured]);
  useEffect(() => {
    void checkSubscription();
    window.addEventListener("push-subscription-changed", checkSubscription);
    window.addEventListener("focus", checkSubscription);
    return () => {
      window.removeEventListener(
        "push-subscription-changed",
        checkSubscription,
      );
      window.removeEventListener("focus", checkSubscription);
    };
  }, [checkSubscription]);
  if (!mounted) return null;

  const handleSubscribe = async () => {
    if (loading) return;
    setLoading(true);
    let created: PushSubscription | null = null;
    try {
      const permission = await Notification.requestPermission();
      setPermissionDenied(permission === "denied");
      if (permission !== "granted") return;
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
      if (!existing) created = subscription;
      const json = subscription.toJSON();
      await api.post("/push/subscribe", {
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      });
      setSubscribed(true);
      setPushBlocked(false);
      window.dispatchEvent(new Event("push-subscription-changed"));
      toast.success(t("account.notify.push.enabled"));
    } catch (caught) {
      if (created) await created.unsubscribe().catch(() => false);
      const error = caught as ThrownError;
      const message = error?.message?.toLowerCase?.() ?? "";
      const blocked = [
        "push service",
        "registration failed",
        "permission denied",
        "not allowed",
      ].some((part) => message.includes(part));
      setPushBlocked(blocked);
      toast.error(
        t(
          blocked
            ? "account.notify.push.browser-blocked"
            : "account.notify.push.error",
        ),
      );
    } finally {
      setLoading(false);
    }
  };
  const handleUnsubscribe = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.delete("/push/subscribe", {
          data: { endpoint: subscription.endpoint },
        });
        await subscription.unsubscribe();
      }
      setSubscribed(false);
      window.dispatchEvent(new Event("push-subscription-changed"));
      toast.success(t("account.notify.push.disabled"));
    } catch {
      toast.error(t("account.notify.push.error"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Paper
      component="section"
      withBorder
      p="xl"
      mt="lg"
      radius="md"
      data-testid="account-push-settings"
      aria-label={t("account.card.push.title")}
    >
      <Group justify="space-between" align="flex-start" gap="lg" wrap="wrap">
        <Stack gap="xs" className={classes.heading}>
          <Group gap="xs">
            <TbBell size={20} aria-hidden="true" />
            <Title order={5}>{t("account.card.push.title")}</Title>
          </Group>
          <Text size="sm" c="dimmed">
            {t("account.card.push.description")}
          </Text>
        </Stack>
        <Button
          leftSection={
            subscribed ? <TbBellOff size={16} /> : <TbBell size={16} />
          }
          variant={subscribed ? "light" : "filled"}
          color={subscribed ? "red" : undefined}
          loading={loading}
          disabled={
            !supported || !configured || (!subscribed && permissionDenied)
          }
          onClick={subscribed ? handleUnsubscribe : handleSubscribe}
          aria-expanded={subscribed}
          aria-controls={preferencesId}
        >
          {t(
            subscribed
              ? "account.card.push.disable"
              : "account.card.push.enable",
          )}
        </Button>
      </Group>
      {!configured && (
        <Text size="sm" c="dimmed" mt="md">
          {t("account.card.push.not-configured")}
        </Text>
      )}
      {configured && !supported && (
        <Text size="sm" c="dimmed" mt="md">
          {t("account.card.push.unsupported")}
        </Text>
      )}
      {permissionDenied && !subscribed && (
        <Text size="sm" c="red" mt="md">
          {t("account.card.push.permission-denied")}
        </Text>
      )}
      {pushBlocked && !subscribed && (
        <Text size="sm" c="orange" mt="md">
          {t("account.card.push.browser-blocked")}
        </Text>
      )}
      <Collapse in={subscribed} transitionDuration={200} id={preferencesId}>
        {children && (
          <>
            <Divider my="lg" />
            {children}
          </>
        )}
      </Collapse>
    </Paper>
  );
}
