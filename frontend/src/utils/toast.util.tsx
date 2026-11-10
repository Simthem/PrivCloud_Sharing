import { NotificationData, showNotification } from "@mantine/notifications";
import { TbCheck, TbInfoCircle, TbX } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import type { ThrownError } from "../types/thrownError.type";

const error = (message: string, config?: Omit<NotificationData, "message">) =>
  showNotification({
    icon: <TbX />,
    color: "red",
    radius: "md",
    title: <FormattedMessage id="common.error" />,
    message: message,

    autoClose: true,

    ...config,
  });

const axiosError = (axiosError: unknown) =>
  error(
    (axiosError as ThrownError | undefined)?.response?.data?.message ??
      "An unknown error occurred",
  );

const success = (message: string, config?: Omit<NotificationData, "message">) =>
  showNotification({
    icon: <TbCheck />,
    color: "green",
    radius: "md",
    title: <FormattedMessage id="common.success" />,
    message: message,
    autoClose: true,
    ...config,
  });

const info = (message: string, config?: Omit<NotificationData, "message">) =>
  showNotification({
    icon: <TbInfoCircle />,
    color: "blue",
    radius: "md",
    title: <FormattedMessage id="common.info" />,
    message: message,
    autoClose: true,
    ...config,
  });

const toast = {
  error,
  success,
  info,
  axiosError,
};
export default toast;
