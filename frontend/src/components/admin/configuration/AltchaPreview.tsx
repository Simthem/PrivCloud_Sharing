import { Badge, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { TbPlayerPlay, TbRefresh } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import { AdminConfig } from "../../../types/config.type";
import {
  normalizeAltchaWidgetOptions,
  type AltchaWidgetOptions,
} from "../../../utils/altcha.util";
import AltchaWidget from "../../captcha/AltchaWidget";
import type { AltchaWidgetHandle } from "../../captcha/AltchaWidget";

const getConfigValue = (
  configVariables: AdminConfig[],
  key: string,
  fallback: string,
) => {
  const configVariable = configVariables.find(
    (variable) => variable.key === key,
  );
  return configVariable?.value ?? configVariable?.defaultValue ?? fallback;
};

const getBooleanConfigValue = (
  configVariables: AdminConfig[],
  key: string,
  fallback: boolean,
) => {
  const value = getConfigValue(configVariables, key, String(fallback));
  return value === "true";
};

const AltchaPreview = ({
  configVariables,
}: {
  configVariables: AdminConfig[];
}) => {
  const widgetRef = useRef<AltchaWidgetHandle>(null);
  const [verified, setVerified] = useState(false);

  const options = useMemo<AltchaWidgetOptions>(
    () =>
      normalizeAltchaWidgetOptions({
        auto: getConfigValue(configVariables, "altcha.auto", "onload"),
        codeChallengeDisplay: getConfigValue(
          configVariables,
          "altcha.codeChallengeDisplay",
          "standard",
        ),
        display: getConfigValue(configVariables, "altcha.display", "standard"),
        language: getConfigValue(configVariables, "altcha.language", "fr-fr"),
        mockChallenge: getBooleanConfigValue(
          configVariables,
          "altcha.mockChallenge",
          true,
        ),
        theme: getConfigValue(configVariables, "altcha.theme", "lime"),
        type: getConfigValue(configVariables, "altcha.type", "checkbox"),
      }),
    [configVariables],
  );

  const optionKey = JSON.stringify(options);

  useEffect(() => {
    setVerified(false);
  }, [optionKey]);

  const reset = () => {
    widgetRef.current?.reset();
    setVerified(false);
  };

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack>
        <Group justify="space-between">
          <Title order={5}>
            <FormattedMessage id="admin.config.altcha.preview.title" />
          </Title>
          <Badge color={verified ? "green" : "gray"} variant="light">
            <FormattedMessage
              id={
                verified
                  ? "admin.config.altcha.preview.verified"
                  : "admin.config.altcha.preview.unverified"
              }
            />
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          <FormattedMessage id="admin.config.altcha.preview.description" />
        </Text>
        <AltchaWidget
          key={optionKey}
          ref={widgetRef}
          onError={() => setVerified(false)}
          onExpire={() => setVerified(false)}
          onVerify={() => setVerified(true)}
          options={options}
        />
        <Group justify="flex-end">
          <Button
            leftSection={<TbPlayerPlay size={16} />}
            variant="light"
            onClick={() => widgetRef.current?.verify()}
          >
            <FormattedMessage id="admin.config.altcha.preview.verify" />
          </Button>
          <Button
            leftSection={<TbRefresh size={16} />}
            variant="outline"
            onClick={reset}
          >
            <FormattedMessage id="admin.config.altcha.preview.reset" />
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
};

export default AltchaPreview;
