import { Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { TbBell, TbBellOff } from "react-icons/tb";
import { useCallback, useEffect, useState } from "react";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import api from "../../services/api.service";
import toast from "../../utils/toast.util";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

const PushNotificationSection = () => {
  const config = useConfig();
  const t = useTranslate();

  const [mounted, setMounted] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const pushEnabled = config.get("pushNotifications.enabled");
  const vapidPublicKey = config.get("pushNotifications.vapidPublicKey");

  // Delay client-only checks until after hydration to avoid SSR mismatch (#418)
  useEffect(() => {
    setMounted(true);
  }, []);

  const supported =
    mounted &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window;

  const checkSubscription = useCallback(async () => {
    if (!supported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setSubscribed(!!sub);
    } catch {
      // Non-critical
    }
  }, [supported]);

  useEffect(() => {
    if (supported && pushEnabled && vapidPublicKey) checkSubscription();
    if (mounted && "Notification" in window && Notification.permission === "denied") {
      setPermissionDenied(true);
    }
  }, [mounted, supported, pushEnabled, vapidPublicKey, checkSubscription]);

  if (!mounted || !pushEnabled || !vapidPublicKey) return null;
  if (!supported) return null;

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = sub.toJSON();
      await api.post("/push/subscribe", {
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      });
      setSubscribed(true);
      toast.success(t("account.notify.push.enabled"));
    } catch {
      toast.error(t("account.notify.push.error"));
    } finally {
      setLoading(false);
    }
  };

  const handleUnsubscribe = async () => {
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.delete("/push/subscribe", {
          data: { endpoint: sub.endpoint },
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast.success(t("account.notify.push.disabled"));
    } catch {
      toast.error(t("account.notify.push.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Paper withBorder p="xl" mt="lg">
      <Group mb="xs" spacing="xs">
        <TbBell size={20} />
        <Title order={5}>{t("account.card.push.title")}</Title>
      </Group>
      <Text size="sm" color="dimmed" mb="md">
        {t("account.card.push.description")}
      </Text>
      <Stack spacing="xs">
        {permissionDenied && !subscribed && (
          <Text size="sm" color="red">
            {t("account.card.push.permission-denied")}
          </Text>
        )}
        <Group position="right">
          {subscribed ? (
            <Button
              leftIcon={<TbBellOff size={16} />}
              variant="light"
              color="red"
              loading={loading}
              onClick={handleUnsubscribe}
            >
              {t("account.card.push.disable")}
            </Button>
          ) : (
            <Button
              leftIcon={<TbBell size={16} />}
              loading={loading}
              onClick={handleSubscribe}
              disabled={permissionDenied}
            >
              {t("account.card.push.enable")}
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
};

export default PushNotificationSection;
