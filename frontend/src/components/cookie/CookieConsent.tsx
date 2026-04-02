import { Anchor, Button, Group, Paper, Text } from "@mantine/core";
import { getCookie, setCookie } from "cookies-next";
import { useEffect, useState } from "react";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";

const CONSENT_COOKIE = "cookie_consent";
const CONSENT_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

const CookieConsent = () => {
  const [visible, setVisible] = useState(false);
  const config = useConfig();
  const t = useTranslate();

  const legalEnabled = config.get("legal.enabled");
  const hasPrivacy = !!(
    config.get("legal.privacyPolicyUrl") ||
    config.get("legal.privacyPolicyText")
  );
  const privacyUrl =
    (!config.get("legal.privacyPolicyText") &&
      config.get("legal.privacyPolicyUrl")) ||
    "/privacy";

  useEffect(() => {
    const consent = getCookie(CONSENT_COOKIE);
    if (!consent) {
      setVisible(true);
    }
  }, []);

  const acceptCookies = () => {
    setCookie(CONSENT_COOKIE, "accepted", {
      maxAge: CONSENT_MAX_AGE,
      sameSite: "lax",
      path: "/",
    });
    setVisible(false);
  };

  const rejectCookies = () => {
    setCookie(CONSENT_COOKIE, "rejected", {
      maxAge: CONSENT_MAX_AGE,
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
      sx={{
        position: "fixed",
        bottom: 16,
        left: 16,
        right: 16,
        zIndex: 9999,
        maxWidth: 520,
        marginLeft: "auto",
        marginRight: "auto",
      }}
    >
      <Text size="sm" weight={600} mb="sm" sx={(theme) => ({ color: theme.colorScheme === "dark" ? theme.colors.gray[3] : theme.colors.gray[8] })}>
        {t("cookie.banner.message")}{" "}
        {hasPrivacy && (
          <Anchor size="sm" href={privacyUrl} underline>
            {t("cookie.banner.learn-more")}
          </Anchor>
        )}
      </Text>
      <Group position="right" spacing="xs">
        <Button variant="outline" size="xs" onClick={rejectCookies}>
          {t("cookie.banner.reject")}
        </Button>
        <Button size="xs" onClick={acceptCookies}>
          {t("cookie.banner.accept")}
        </Button>
      </Group>
    </Paper>
  );
};

export default CookieConsent;
