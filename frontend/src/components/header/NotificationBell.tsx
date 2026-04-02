import { Indicator, Tooltip, UnstyledButton } from "@mantine/core";
import { TbBell, TbBellOff, TbBellRinging } from "react-icons/tb";
import { useCallback, useEffect, useState } from "react";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import api from "../../services/api.service";
import toast from "../../utils/toast.util";
import { useStyles } from "./Header.styles";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

const NotificationBell = () => {
  const config = useConfig();
  const t = useTranslate();
  const { classes, cx } = useStyles();

  const [mounted, setMounted] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  const pushEnabled = config.get("pushNotifications.enabled");
  const vapidPublicKey = config.get("pushNotifications.vapidPublicKey");

  // Delay rendering until after hydration to avoid SSR/client mismatch (#418)
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
  }, [supported, pushEnabled, vapidPublicKey, checkSubscription]);

  if (!mounted || !pushEnabled || !vapidPublicKey || !supported) return null;

  const handleToggle = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (subscribed) {
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
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          toast.error(t("account.card.push.permission-denied"));
          return;
        }
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
      }
    } catch {
      toast.error(t("account.notify.push.error"));
    } finally {
      setLoading(false);
    }
  };

  const label = subscribed
    ? t("account.card.push.disable")
    : t("account.card.push.enable");

  const Icon = subscribed ? TbBellRinging : TbBell;

  return (
    <Tooltip label={label} withArrow>
      <UnstyledButton
        className={cx(classes.link, classes.withIcon)}
        onClick={handleToggle}
        aria-label={label}
      >
        <Indicator
          color="green"
          size={8}
          offset={2}
          disabled={!subscribed}
          processing={loading}
        >
          <Icon size={18} />
        </Indicator>
      </UnstyledButton>
    </Tooltip>
  );
};

export default NotificationBell;
