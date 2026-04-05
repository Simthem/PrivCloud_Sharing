import { ActionIcon, Center, Stack, Text, Tooltip } from "@mantine/core";
import { ModalsContextProps } from "@mantine/modals/lib/context";
import { useState } from "react";
import { TbCheck, TbCopy } from "react-icons/tb";
import { QRCodeSVG } from "qrcode.react";
import { translateOutsideContext } from "../../hooks/useTranslate.hook";
import { copyToClipboard } from "../../utils/clipboard.util";

const showQrCodeModal = (modals: ModalsContextProps, link: string) => {
  const t = translateOutsideContext();
  return modals.openModal({
    title: t("common.modal.qr-code.title"),
    children: <QrCodeContent link={link} />,
  });
};

const QrCodeContent = ({ link }: { link: string }) => {
  const [copied, setCopied] = useState(false);
  const t = translateOutsideContext();

  const handleCopy = async () => {
    const ok = await copyToClipboard(link);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Stack align="center" spacing="md">
      <Center>
        <QRCodeSVG
          value={link}
          size={256}
          level="H"
          marginSize={4}
          bgColor="#FFFFFF"
          fgColor="#000000"
        />
      </Center>
      <Text
        size="xs"
        color="dimmed"
        align="center"
        sx={{ wordBreak: "break-all", maxWidth: 280, cursor: "pointer" }}
        onClick={handleCopy}
      >
        {link}
      </Text>
      <Tooltip label={t("common.button.clickToCopy")}>
        <ActionIcon variant="light" onClick={handleCopy}>
          {copied ? <TbCheck /> : <TbCopy />}
        </ActionIcon>
      </Tooltip>
    </Stack>
  );
};

export default showQrCodeModal;
