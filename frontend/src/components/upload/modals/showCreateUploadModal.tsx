import {
  Accordion,
  Alert,
  Button,
  Center,
  Checkbox,
  Col,
  Grid,
  Group,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { useForm, yupResolver } from "@mantine/form";
import { useModals } from "@mantine/modals";
import { ModalsContextProps } from "@mantine/modals/lib/context";
import dayjs from "../../../utils/dayjs";
import { ManipulateType } from "dayjs";
import React, { useRef, useState } from "react";
import { TbAlertCircle } from "react-icons/tb";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import useTranslate, {
  translateOutsideContext,
} from "../../../hooks/useTranslate.hook";
import shareService from "../../../services/share.service";
import { FileUpload } from "../../../types/File.type";
import { CreateShare } from "../../../types/share.type";
import { getExpirationPreview } from "../../../utils/date.util";
import toast from "../../../utils/toast.util";
import { Timespan } from "../../../types/timespan.type";
import useConfig from "../../../hooks/config.hook";

const showCreateUploadModal = (
  modals: ModalsContextProps,
  options: {
    isUserSignedIn: boolean;
    isReverseShare: boolean;
    allowUnauthenticatedShares: boolean;
    enableEmailRecepients: boolean;
    enableE2EKeyEmailSharing: boolean;
    maxExpiration: Timespan;
    anonymousMaxExpiration: Timespan;
    shareIdLength: number;
    simplified: boolean;
    captchaSiteKey?: string;
  },
  files: FileUpload[],
  uploadCallback: (_createShare: CreateShare, _files: FileUpload[]) => void,
  pastRecipients: string[] = [],
) => {
  const t = translateOutsideContext();

  if (options.simplified) {
    return modals.openModal({
      title: t("upload.modal.title"),
      children: (
        <SimplifiedCreateUploadModalModal
          options={options}
          files={files}
          uploadCallback={uploadCallback}
        />
      ),
    });
  }

  return modals.openModal({
    title: t("upload.modal.title"),
    children: (
      <CreateUploadModalBody
        options={options}
        files={files}
        uploadCallback={uploadCallback}
        pastRecipients={pastRecipients}
      />
    ),
  });
};

const generateShareId = (length: number = 16) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomArray = new Uint8Array(length >= 3 ? length : 3);
  crypto.getRandomValues(randomArray);
  randomArray.forEach((number) => {
    result += chars[number % chars.length];
  });
  return result;
};

const generateAvailableLink = async (
  shareIdLength: number,
  times: number = 10,
): Promise<string> => {
  if (times <= 0) {
    throw new Error("Could not generate available link");
  }
  const _link = generateShareId(shareIdLength);
  if (!(await shareService.isShareIdAvailable(_link))) {
    return await generateAvailableLink(shareIdLength, times - 1);
  } else {
    return _link;
  }
};

const CreateUploadModalBody = ({
  uploadCallback,
  files,
  options,
  pastRecipients = [],
}: {
  files: FileUpload[];
  uploadCallback: (_createShare: CreateShare, _files: FileUpload[]) => void;
  options: {
    isUserSignedIn: boolean;
    isReverseShare: boolean;
    allowUnauthenticatedShares: boolean;
    enableEmailRecepients: boolean;
    enableE2EKeyEmailSharing: boolean;
    maxExpiration: Timespan;
    anonymousMaxExpiration: Timespan;
    shareIdLength: number;
    captchaSiteKey?: string;
  };
  pastRecipients?: string[];
}) => {
  const modals = useModals();
  const config = useConfig();
  const t = useTranslate();
  const theme = useMantineTheme();

  const captchaRef = useRef<HCaptcha>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const showCaptcha = !options.isUserSignedIn && !!options.captchaSiteKey;

  const generatedLink = generateShareId(options.shareIdLength);

  const [showNotSignedInAlert, setShowNotSignedInAlert] = useState(true);

  const validationSchema = yup.object().shape({
    link: yup
      .string()
      .required(t("common.error.field-required"))
      .min(3, t("common.error.too-short", { length: 3 }))
      .max(50, t("common.error.too-long", { length: 50 }))
      .matches(new RegExp("^[a-zA-Z0-9_-]*$"), {
        message: t("upload.modal.link.error.invalid"),
      }),
    name: yup
      .string()
      .transform((value) => value || undefined)
      .min(3, t("common.error.too-short", { length: 3 }))
      .max(90, t("common.error.too-long", { length: 90 })),
    password: yup
      .string()
      .transform((value) => value || undefined)
      .min(3, t("common.error.too-short", { length: 3 }))
      .max(90, t("common.error.too-long", { length: 90 })),
    maxViews: yup
      .number()
      .transform((value) => value || undefined)
      .min(1),
    senderName: !options.isUserSignedIn && !options.isReverseShare
      ? yup
          .string()
          .required(t("common.error.field-required"))
          .min(2, t("common.error.too-short", { length: 2 }))
          .max(100, t("common.error.too-long", { length: 100 }))
      : yup.string().optional(),
    senderEmail: !options.isUserSignedIn && !options.isReverseShare
      ? yup
          .string()
          .required(t("common.error.field-required"))
          .email(t("upload.modal.accordion.email.invalid-email"))
      : yup.string().optional(),
  });

  const [storedRecipients, setStoredRecipients] =
    useState<string[]>(pastRecipients);

  const form = useForm({
    initialValues: {
      name: undefined,
      link: generatedLink,
      recipients: [] as string[],
      password: undefined,
      maxViews: undefined,
      description: undefined,
      expiration_num: 1,
      expiration_unit: "-days",
      never_expires: false,
      shareE2EKeyViaEmail: false,
      senderName: "",
      senderEmail: "",
    },
    validate: yupResolver(validationSchema),
  });

  const onSubmit = form.onSubmit(async (values) => {
    if (!(await shareService.isShareIdAvailable(values.link))) {
      form.setFieldError("link", t("upload.modal.link.error.taken"));
    } else {
      const expirationString = form.values.never_expires
        ? "never"
        : form.values.expiration_num + form.values.expiration_unit;

      const expirationDate = dayjs().add(
        form.values.expiration_num,
        form.values.expiration_unit.replace(
          "-",
          "",
        ) as ManipulateType,
      );

      // Use anonymous limit when user is not signed in, otherwise use global max
      const effectiveMax = !options.isUserSignedIn && options.anonymousMaxExpiration.value !== 0
        ? options.anonymousMaxExpiration
        : options.maxExpiration;

      if (
        effectiveMax.value != 0 &&
        (form.values.never_expires ||
          expirationDate.isAfter(
            dayjs().add(
              effectiveMax.value,
              effectiveMax.unit as ManipulateType,
            ),
          ))
      ) {
        form.setFieldError(
          "expiration_num",
          t("upload.modal.expires.error.too-long", {
            max: dayjs
              .duration(effectiveMax.value, effectiveMax.unit as ManipulateType)
              .humanize(),
          }),
        );
        return;
      }

      uploadCallback(
        {
          id: values.link,
          name: values.name,
          expiration: expirationString,
          recipients: values.recipients,
          description: values.description,
          security: {
            password: values.password || undefined,
            maxViews: values.maxViews || undefined,
          },
          shareE2EKeyViaEmail: values.shareE2EKeyViaEmail,
          ...(captchaToken && { captchaToken }),
          ...(values.senderName && { senderName: values.senderName }),
          ...(values.senderEmail && { senderEmail: values.senderEmail }),
        },
        files,
      );
      modals.closeAll();
    }
  });

  return (
    <>
      {showNotSignedInAlert && !options.isUserSignedIn && (
        <Alert
          withCloseButton
          onClose={() => setShowNotSignedInAlert(false)}
          icon={<TbAlertCircle size={16} />}
          title={t("upload.modal.not-signed-in")}
          color="yellow"
        >
          <FormattedMessage id="upload.modal.not-signed-in-description" />
        </Alert>
      )}
      <form onSubmit={onSubmit}>
        <Stack align="stretch">
          {!options.isUserSignedIn && !options.isReverseShare && (
            <Group grow>
              <TextInput
                variant="filled"
                label={t("upload.modal.sender.name.label")}
                placeholder={t("upload.modal.sender.name.placeholder")}
                {...form.getInputProps("senderName")}
              />
              <TextInput
                variant="filled"
                label={t("upload.modal.sender.email.label")}
                placeholder={t("upload.modal.sender.email.placeholder")}
                inputMode="email"
                {...form.getInputProps("senderEmail")}
              />
            </Group>
          )}
          <Group align={form.errors.link ? "center" : "flex-end"}>
            <TextInput
              style={{ flex: "1" }}
              variant="filled"
              label={t("upload.modal.link.label")}
              placeholder="myAwesomeShare"
              {...form.getInputProps("link")}
            />
            <Button
              style={{ flex: "0 0 auto" }}
              variant="outline"
              onClick={() =>
                form.setFieldValue(
                  "link",
                  generateShareId(options.shareIdLength),
                )
              }
            >
              <FormattedMessage id="common.button.generate" />
            </Button>
          </Group>

          <Text
            truncate
            italic
            size="xs"
            sx={(theme) => ({
              color: theme.colors.gray[6],
            })}
          >
            {`${config.get("general.appUrl")}/s/${form.values.link}`}
          </Text>
          {!options.isReverseShare && (
            <>
              <Grid align={form.errors.expiration_num ? "center" : "flex-end"}>
                <Col xs={6}>
                  <NumberInput
                    min={1}
                    max={99999}
                    precision={0}
                    variant="filled"
                    label={t("upload.modal.expires.label")}
                    disabled={form.values.never_expires}
                    {...form.getInputProps("expiration_num")}
                  />
                </Col>
                <Col xs={6}>
                  <Select
                    disabled={form.values.never_expires}
                    {...form.getInputProps("expiration_unit")}
                    data={[
                      {
                        value: "-minutes",
                        label:
                          form.values.expiration_num == 1
                            ? t("upload.modal.expires.minute-singular")
                            : t("upload.modal.expires.minute-plural"),
                      },
                      {
                        value: "-hours",
                        label:
                          form.values.expiration_num == 1
                            ? t("upload.modal.expires.hour-singular")
                            : t("upload.modal.expires.hour-plural"),
                      },
                      {
                        value: "-days",
                        label:
                          form.values.expiration_num == 1
                            ? t("upload.modal.expires.day-singular")
                            : t("upload.modal.expires.day-plural"),
                      },
                      {
                        value: "-weeks",
                        label:
                          form.values.expiration_num == 1
                            ? t("upload.modal.expires.week-singular")
                            : t("upload.modal.expires.week-plural"),
                      },
                      {
                        value: "-months",
                        label:
                          form.values.expiration_num == 1
                            ? t("upload.modal.expires.month-singular")
                            : t("upload.modal.expires.month-plural"),
                      },
                      {
                        value: "-years",
                        label:
                          form.values.expiration_num == 1
                            ? t("upload.modal.expires.year-singular")
                            : t("upload.modal.expires.year-plural"),
                      },
                    ]}
                  />
                </Col>
              </Grid>
              {options.maxExpiration.value == 0 && options.isUserSignedIn && (
                <Checkbox
                  label={t("upload.modal.expires.never-long")}
                  {...form.getInputProps("never_expires")}
                />
              )}
              <Text
                italic
                size="xs"
                sx={(theme) => ({
                  color: theme.colors.gray[6],
                })}
              >
                {getExpirationPreview(
                  {
                    neverExpires: t("upload.modal.completed.never-expires"),
                    expiresOn: t("upload.modal.completed.expires-on"),
                  },
                  form,
                )}
              </Text>
            </>
          )}
          <Accordion>
            <Accordion.Item value="description" sx={{ borderBottom: "none" }}>
              <Accordion.Control>
                <FormattedMessage id="upload.modal.accordion.name-and-description.title" />
              </Accordion.Control>
              <Accordion.Panel>
                <Stack align="stretch">
                  <TextInput
                    variant="filled"
                    placeholder={t(
                      "upload.modal.accordion.name-and-description.name.placeholder",
                    )}
                    {...form.getInputProps("name")}
                  />
                  <Textarea
                    variant="filled"
                    placeholder={t(
                      "upload.modal.accordion.name-and-description.description.placeholder",
                    )}
                    {...form.getInputProps("description")}
                  />
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
            {/* [UX/Security] Disabled for reverse share uploads: the uploader
               must not be able to forward encrypted files to unintended
               third-party recipients. Only the reverse share creator
               should receive the completed share link. */}
            {options.enableEmailRecepients && !options.isReverseShare && (
              <Accordion.Item value="recipients" sx={{ borderBottom: "none" }}>
                <Accordion.Control>
                  <FormattedMessage id="upload.modal.accordion.email.title" />
                </Accordion.Control>
                <Accordion.Panel>
                  <MultiSelect
                    data={storedRecipients}
                    placeholder={t("upload.modal.accordion.email.placeholder")}
                    searchable
                    creatable
                    id="recipient-emails"
                    inputMode="email"
                    getCreateLabel={(query) => `+ ${query}`}
                    onCreate={(query) => {
                      if (!query.match(/^\S+@\S+\.\S+$/)) {
                        form.setFieldError(
                          "recipients",
                          t("upload.modal.accordion.email.invalid-email"),
                        );
                      } else {
                        setStoredRecipients((prev) => [...prev, query]);
                        form.setFieldError("recipients", null);
                        form.setFieldValue("recipients", [
                          ...form.values.recipients,
                          query,
                        ]);
                        return query;
                      }
                    }}
                    {...form.getInputProps("recipients")}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      // Add email on comma or semicolon
                      if (e.key === "Enter" || e.key === "," || e.key === ";") {
                        e.preventDefault();
                        const inputValue = (
                          e.target as HTMLInputElement
                        ).value.trim();
                        if (inputValue.match(/^\S+@\S+\.\S+$/)) {
                          form.setFieldValue("recipients", [
                            ...form.values.recipients,
                            inputValue,
                          ]);
                          (e.target as HTMLInputElement).value = "";
                        }
                      } else if (e.key === " ") {
                        e.preventDefault();
                        (e.target as HTMLInputElement).value = "";
                      }
                    }}
                  />
                </Accordion.Panel>
              </Accordion.Item>
            )}

            <Accordion.Item value="security" sx={{ borderBottom: "none" }}>
              <Accordion.Control>
                <FormattedMessage id="upload.modal.accordion.security.title" />
              </Accordion.Control>
              <Accordion.Panel>
                <Stack align="stretch">
                  <PasswordInput
                    variant="filled"
                    placeholder={t(
                      "upload.modal.accordion.security.password.placeholder",
                    )}
                    label={t("upload.modal.accordion.security.password.label")}
                    autoComplete="new-password"
                    {...form.getInputProps("password")}
                  />
                  {/* [UX/Security] Max views hidden for reverse share uploads:
                     the uploader could exhaust the view quota before the
                     reverse share creator ever accesses the share. */}
                  {!options.isReverseShare && (
                    <NumberInput
                      min={1}
                      type="number"
                      variant="filled"
                      placeholder={t(
                        "upload.modal.accordion.security.max-views.placeholder",
                      )}
                      label={t("upload.modal.accordion.security.max-views.label")}
                      {...form.getInputProps("maxViews")}
                    />
                  )}
                  {/* [UX/Security] E2E key email checkbox hidden for reverse
                     shares: K_rs is delivered via the URL fragment (#key=...),
                     not email. The checkbox would be misleading. */}
                  {!options.isReverseShare &&
                    options.isUserSignedIn &&
                    options.enableEmailRecepients &&
                    options.enableE2EKeyEmailSharing && (
                      <Checkbox
                        label={t(
                          "upload.modal.accordion.security.e2e-key-email.label",
                        )}
                        description={t(
                          "upload.modal.accordion.security.e2e-key-email.description",
                        )}
                        {...form.getInputProps("shareE2EKeyViaEmail", {
                          type: "checkbox",
                        })}
                      />
                    )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          {showCaptcha && (
            <Center>
              <HCaptcha
                ref={captchaRef}
                sitekey={options.captchaSiteKey!}
                onVerify={setCaptchaToken}
                onExpire={() => setCaptchaToken(null)}
                theme={theme.colorScheme}
              />
            </Center>
          )}
          <Button
            type="submit"
            data-autofocus
            disabled={showCaptcha && !captchaToken}
          >
            <FormattedMessage id="common.button.share" />
          </Button>
        </Stack>
      </form>
    </>
  );
};

const SimplifiedCreateUploadModalModal = ({
  uploadCallback,
  files,
  options,
}: {
  files: FileUpload[];
  uploadCallback: (_createShare: CreateShare, _files: FileUpload[]) => void;
  options: {
    isUserSignedIn: boolean;
    isReverseShare: boolean;
    allowUnauthenticatedShares: boolean;
    enableEmailRecepients: boolean;
    enableE2EKeyEmailSharing: boolean;
    maxExpiration: Timespan;
    anonymousMaxExpiration: Timespan;
    shareIdLength: number;
    captchaSiteKey?: string;
  };
}) => {
  const modals = useModals();
  const t = useTranslate();
  const theme = useMantineTheme();

  const captchaRef = useRef<HCaptcha>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const showCaptcha = !options.isUserSignedIn && !!options.captchaSiteKey;

  const [showNotSignedInAlert, setShowNotSignedInAlert] = useState(true);

  const validationSchema = yup.object().shape({
    name: yup
      .string()
      .transform((value) => value || undefined)
      .min(3, t("common.error.too-short", { length: 3 }))
      .max(30, t("common.error.too-long", { length: 30 })),
  });

  const form = useForm({
    initialValues: {
      name: undefined,
      description: undefined,
    },
    validate: yupResolver(validationSchema),
  });

  const onSubmit = form.onSubmit(async (values) => {
    const link = await generateAvailableLink(options.shareIdLength).catch(
      () => {
        toast.error(t("upload.modal.link.error.taken"));
        return undefined;
      },
    );

    if (!link) {
      return;
    }

    // For anonymous users, enforce the anonymous max expiration instead of "never"
    const expiration = !options.isUserSignedIn && options.anonymousMaxExpiration.value !== 0
      ? `${options.anonymousMaxExpiration.value}-${options.anonymousMaxExpiration.unit}`
      : "never";

    uploadCallback(
      {
        id: link,
        name: values.name,
        expiration,
        recipients: [],
        description: values.description,
        security: {
          password: undefined,
          maxViews: undefined,
        },
        ...(captchaToken && { captchaToken }),
      },
      files,
    );
    modals.closeAll();
  });

  return (
    <Stack>
      {showNotSignedInAlert && !options.isUserSignedIn && (
        <Alert
          withCloseButton
          onClose={() => setShowNotSignedInAlert(false)}
          icon={<TbAlertCircle size={16} />}
          title={t("upload.modal.not-signed-in")}
          color="yellow"
        >
          <FormattedMessage id="upload.modal.not-signed-in-description" />
        </Alert>
      )}
      <form onSubmit={onSubmit}>
        <Stack align="stretch">
          <Stack align="stretch">
            <TextInput
              variant="filled"
              placeholder={t(
                "upload.modal.accordion.name-and-description.name.placeholder",
              )}
              {...form.getInputProps("name")}
            />
            <Textarea
              variant="filled"
              placeholder={t(
                "upload.modal.accordion.name-and-description.description.placeholder",
              )}
              {...form.getInputProps("description")}
            />
          </Stack>
          {showCaptcha && (
            <Center>
              <HCaptcha
                ref={captchaRef}
                sitekey={options.captchaSiteKey!}
                onVerify={setCaptchaToken}
                onExpire={() => setCaptchaToken(null)}
                theme={theme.colorScheme}
              />
            </Center>
          )}
          <Button
            type="submit"
            data-autofocus
            disabled={showCaptcha && !captchaToken}
          >
            <FormattedMessage id="common.button.share" />
          </Button>
        </Stack>
      </form>
    </Stack>
  );
};

export default showCreateUploadModal;
