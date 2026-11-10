import {
  Anchor,
  Button,
  getDefaultZIndex,
  Group,
  Paper,
  Text,
} from "@mantine/core";
import { getCookie, setCookie } from "cookies-next";
import { useEffect, useState } from "react";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";

const NOTICE_COOKIE = "cookie_notice";
const NOTICE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

const CookieConsent = () => {
  const [visible, setVisible] = useState(false);
  const config = useConfig();
  const t = useTranslate();

  const legalEnabled = config.getBoolean("legal.enabled");
  const hasPrivacy = !!(
    config.getString("legal.privacyPolicyUrl") ||
    config.getString("legal.privacyPolicyText")
  );
  const privacyUrl =
    (!config.getString("legal.privacyPolicyText") &&
      config.getString("legal.privacyPolicyUrl")) ||
    "/privacy";

  useEffect(() => {
    const noticed = getCookie(NOTICE_COOKIE);
    if (!noticed) {
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    setCookie(NOTICE_COOKIE, "seen", {
      maxAge: NOTICE_MAX_AGE,
      sameSite: "lax",
      path: "/",
    });
    setVisible(false);
  };

  if (!visible || !legalEnabled) return null;

  return (
    <Paper
      shadow="lg"
      p="md"
      withBorder
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        right: 16,
        // Under the modals, so it never hides their actions.
        zIndex: getDefaultZIndex("modal") - 1,
        maxWidth: 520,
        marginLeft: "auto",
        marginRight: "auto",
      }}
    >
      <Text
        size="sm"
        fw={600}
        mb="sm"
        style={{ color: "var(--mantine-color-text)" }}
      >
        {t("cookie.banner.message")}{" "}
        {hasPrivacy && (
          <Anchor size="sm" href={privacyUrl} underline="always">
            {t("cookie.banner.learn-more")}
          </Anchor>
        )}
      </Text>
      <Group justify="right">
        <Button size="xs" onClick={dismiss}>
          {t("cookie.banner.dismiss")}
        </Button>
      </Group>
    </Paper>
  );
};

export default CookieConsent;
