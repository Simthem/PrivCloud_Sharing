import { ActionIcon, TextInput, Tooltip } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useRef, useState } from "react";
import { IoOpenOutline } from "react-icons/io5";
import { TbCheck, TbCopy, TbQrcode } from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";
import { copyToClipboard } from "../../utils/clipboard.util";
import toast from "../../utils/toast.util";
import showQrCodeModal from "../core/showQrCodeModal";

function CopyTextField(props: { link: string }) {
  const modals = useModals();
  const t = useTranslate();

  const [checkState, setCheckState] = useState(false);
  const [textClicked, setTextClicked] = useState(false);
  const timerRef = useRef<number | ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const copyLink = async () => {
    const ok = await copyToClipboard(props.link);
    if (ok) {
      toast.success(t("common.notify.copied-link"));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCheckState(false);
      }, 1500);
      setCheckState(true);
    }
  };

  return (
    <TextInput
      readOnly
      label={t("common.text.link")}
      variant="filled"
      value={props.link}
      onClick={() => {
        if (!textClicked) {
          copyLink();
          setTextClicked(true);
        }
      }}
      rightSectionWidth={92}
      rightSection={
        <>
          <Tooltip
            label={t("common.button.showQrCode")}
            position="top"
            offset={-2}
            openDelay={200}
          >
            <ActionIcon onClick={() => showQrCodeModal(modals, props.link)}>
              <TbQrcode />
            </ActionIcon>
          </Tooltip>

          <Tooltip
            label={t("common.text.navigate-to-link")}
            position="top"
            offset={-2}
            openDelay={200}
          >
            <a href={props.link}>
              <ActionIcon>
                <IoOpenOutline />
              </ActionIcon>
            </a>
          </Tooltip>

          <Tooltip
            label={t("common.button.clickToCopy")}
            position="top"
            offset={-2}
            openDelay={200}
          >
            <ActionIcon onClick={copyLink}>
              {checkState ? <TbCheck /> : <TbCopy />}
            </ActionIcon>
          </Tooltip>
        </>
      }
    />
  );
}

export default CopyTextField;
