import {
  Accordion,
  Alert,
  Button,
  Center,
  Checkbox,
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
import { useForm } from "@mantine/form";
import { yupResolver } from "mantine-form-yup-resolver";
import { useModals } from "@mantine/modals";
import dayjs from "../../../utils/dayjs";
import { ManipulateType } from "dayjs";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { TbAlertCircle } from "react-icons/tb";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { FormattedMessage } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import * as yup from "yup";
import useTranslate, {
  translateOutsideContext,
} from "../../../hooks/useTranslate.hook";
import shareService from "../../../services/share.service";
import teamService from "../../../services/team.service";
import { FileUpload } from "../../../types/File.type";
import { CreateShare } from "../../../types/share.type";
import { getExpirationPreview } from "../../../utils/date.util";
import toast from "../../../utils/toast.util";
import { Timespan } from "../../../types/timespan.type";
import useConfig from "../../../hooks/config.hook";

const showCreateUploadModal = (
  modals: ReturnType<typeof useModals>,
  options: {
    isUserSignedIn: boolean;
    isReverseShare: boolean;
    allowUnauthenticatedShares: boolean;
    enableEmailRecepients: boolean;
    enableE2EKeyEmailSharing: boolean;
    userHasE2E: boolean;
    maxExpiration: Timespan;
    anonymousMaxExpiration: Timespan;
    planMaxExpirationDays: number;
    shareIdLength: number;
    simplified: boolean;
    captchaSiteKey?: string;
    preselectedTeamFolderId?: string;
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
    userHasE2E: boolean;
    enableE2EKeyEmailSharing: boolean;
    maxExpiration: Timespan;
    anonymousMaxExpiration: Timespan;
    planMaxExpirationDays: number;
    shareIdLength: number;
    captchaSiteKey?: string;
    preselectedTeamFolderId?: string;
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

  const handleCaptchaExpire = () => setCaptchaToken(null);
  const handleCaptchaError = (error: any) => {
    console.warn("[hCaptcha Error]", error);
    // Attempt to reset the captcha on error (e.g., WebGL context lost on Safari)
    if (captchaRef.current?.resetCaptcha) {
      captchaRef.current.resetCaptcha();
    }
  };

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
  const [emailSearch, setEmailSearch] = useState("");

  // iOS contacts: force autocomplete="email" on Mantine's internal search
  // input so Safari's contact-picker keyboard button can pre-fill the field.
  // The attribute is set after mount via DOM access because Mantine v6 does
  // not expose a direct searchProps passthrough on MultiSelect.
  const recipientWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = recipientWrapperRef.current?.querySelector("input");
    if (input) {
      input.setAttribute("autocomplete", "email");
      // When iOS autofills via the contact picker it fires a native "input"
      // event rather than a React synthetic event.  Capture it here so the
      // email ends up in the form field.
      const handleNativeInput = (e: Event) => {
        const value = (e.target as HTMLInputElement).value.trim();
        if (value && value.match(/^\S+@\S+\.\S+$/)) {
          if (!storedRecipients.includes(value)) {
            setStoredRecipients((prev) => [...prev, value]);
          }
          form.setFieldValue("recipients", [
            ...form.values.recipients,
            value,
          ]);
          form.setFieldError("recipients", null);
          (e.target as HTMLInputElement).value = "";
          setEmailSearch("");
        } else {
          setEmailSearch(value);
        }
      };
      input.addEventListener("change", handleNativeInput);
      return () => input.removeEventListener("change", handleNativeInput);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const recipientOptions = useMemo(() => {
    const options = [...storedRecipients];
    const trimmed = emailSearch.trim();
    if (trimmed && trimmed.match(/^\S+@\S+\.\S+$/) && !options.includes(trimmed)) {
      options.push(trimmed);
    }
    return options;
  }, [storedRecipients, emailSearch]);

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
      notifyOnDownload: false,
      teamFolderId: options.preselectedTeamFolderId || (undefined as string | undefined),
    },
    validate: yupResolver(validationSchema),
  });

  // Fetch team folders the user can write to (only when signed in & not reverse share)
  const { data: teamFolders } = useQuery({
    queryKey: ["teams", "writable-folders"],
    queryFn: () => teamService.getMyWritableFolders(),
    enabled: options.isUserSignedIn && !options.isReverseShare,
    staleTime: 120_000,
  });

  // Fetch user's teams to detect "has teams but no writable folders"
  const { data: myTeams } = useQuery({
    queryKey: ["teams", "my"],
    queryFn: () => teamService.getMyTeams(),
    enabled: options.isUserSignedIn && !options.isReverseShare,
    staleTime: 120_000,
  });

  const teamFolderOptions = useMemo(() => {
    if (!teamFolders?.length) return [];
    // Group folders by team name for better readability
    const grouped: Record<string, { value: string; label: string }[]> = {};
    for (const tf of teamFolders) {
      if (!grouped[tf.teamName]) grouped[tf.teamName] = [];
      grouped[tf.teamName].push({
        value: tf.folder.id,
        label: tf.folder.name,
      });
    }
    // If only one team, return flat list
    const teamNames = Object.keys(grouped);
    if (teamNames.length === 1) {
      return grouped[teamNames[0]].map((item) => ({
        value: item.value,
        label: `${teamNames[0]} / ${item.label}`,
      }));
    }
    // Multiple teams: return grouped format
    return teamNames.map((teamName) => ({
      group: teamName,
      items: grouped[teamName],
    }));
  }, [teamFolders]);

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

      // For authenticated users with a per-plan limit, use planMaxExpirationDays
      // planMaxExpirationDays === 0 means unlimited (admin) -> no check
      // For anonymous users, use anonymousMaxExpiration
      // Fallback to global maxExpiration (only for anonymous without specific limit)
      let expirationExceeded = false;
      let maxHumanized = "";

      if (options.isUserSignedIn && options.planMaxExpirationDays === 0) {
        // Unlimited (admin) - no expiration enforcement
      } else if (options.isUserSignedIn && options.planMaxExpirationDays > 0) {
        // Per-plan limit (accounts for team membership)
        const planMaxDate = dayjs().add(options.planMaxExpirationDays, "days");
        if (form.values.never_expires || expirationDate.isAfter(planMaxDate)) {
          expirationExceeded = true;
          maxHumanized = dayjs.duration(options.planMaxExpirationDays, "days").humanize();
        }
      } else if (!options.isUserSignedIn && options.anonymousMaxExpiration.value !== 0) {
        const anonMaxDate = dayjs().add(
          options.anonymousMaxExpiration.value,
          options.anonymousMaxExpiration.unit as ManipulateType,
        );
        if (form.values.never_expires || expirationDate.isAfter(anonMaxDate)) {
          expirationExceeded = true;
          maxHumanized = dayjs
            .duration(options.anonymousMaxExpiration.value, options.anonymousMaxExpiration.unit as ManipulateType)
            .humanize();
        }
      } else if (!options.isUserSignedIn && options.maxExpiration.value != 0) {
        const globalMaxDate = dayjs().add(
          options.maxExpiration.value,
          options.maxExpiration.unit as ManipulateType,
        );
        if (form.values.never_expires || expirationDate.isAfter(globalMaxDate)) {
          expirationExceeded = true;
          maxHumanized = dayjs
            .duration(options.maxExpiration.value, options.maxExpiration.unit as ManipulateType)
            .humanize();
        }
      }

      if (expirationExceeded) {
        form.setFieldError(
          "expiration_num",
          t("upload.modal.expires.error.too-long", { max: maxHumanized }),
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
          notifyOnDownload: values.notifyOnDownload,
          ...(values.teamFolderId && { teamFolderId: values.teamFolderId }),
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
          {!options.isReverseShare && (
            <>
              <Grid align={form.errors.expiration_num ? "center" : "flex-end"}>
                <Grid.Col span={{ base: 12, xs: 6 }}>
                  <NumberInput
                    min={1}
                    max={99999}
                    decimalScale={0}
                    variant="filled"
                    label={t("upload.modal.expires.label")}
                    disabled={form.values.never_expires}
                    {...form.getInputProps("expiration_num")}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, xs: 6 }}>
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
                </Grid.Col>
              </Grid>
              {options.isUserSignedIn && options.planMaxExpirationDays === 0 && (
                <Checkbox
                  label={t("upload.modal.expires.never-long")}
                  {...form.getInputProps("never_expires")}
                />
              )}
              <Text
                fs="italic"
                size="xs"
                style={{
                  color: "var(--mantine-color-gray-6)",
                }}
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
            <Accordion.Item value="link" style={{ borderBottom: "none" }}>
              <Accordion.Control>
                <FormattedMessage id="upload.modal.accordion.link.title" />
              </Accordion.Control>
              <Accordion.Panel>
                <Stack align="stretch">
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
                      <FormattedMessage id="common.button.random" />
                    </Button>
                  </Group>
                  <Text
                    truncate="end"
                    fs="italic"
                    size="xs"
                    style={{
                      color: "var(--mantine-color-gray-6)",
                    }}
                  >
                    {`${config.get("general.appUrl")}/s/${form.values.link}`}
                  </Text>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="description" style={{ borderBottom: "none" }}>
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
              <Accordion.Item value="recipients" style={{ borderBottom: "none" }}>
                <Accordion.Control>
                  <FormattedMessage id="upload.modal.accordion.email.title" />
                </Accordion.Control>
                <Accordion.Panel>
                  <div ref={recipientWrapperRef}>
                  <MultiSelect
                    data={recipientOptions}
                    placeholder={t("upload.modal.accordion.email.placeholder")}
                    searchable
                    id="recipient-emails"
                    inputMode="email"
                    searchValue={emailSearch}
                    onSearchChange={setEmailSearch}
                    {...form.getInputProps("recipients")}
                    onOptionSubmit={(value) => {
                      if (!storedRecipients.includes(value)) {
                        setStoredRecipients((prev) => [...prev, value]);
                      }
                      if (!form.values.recipients.includes(value)) {
                        form.setFieldValue("recipients", [
                          ...form.values.recipients,
                          value,
                        ]);
                      }
                      form.setFieldError("recipients", null);
                      setEmailSearch("");
                    }}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "," || e.key === ";") {
                        e.preventDefault();
                        const inputValue = (
                          e.target as HTMLInputElement
                        ).value.trim();
                        if (inputValue.match(/^\S+@\S+\.\S+$/)) {
                          if (!storedRecipients.includes(inputValue)) {
                            setStoredRecipients((prev) => [...prev, inputValue]);
                          }
                          form.setFieldValue("recipients", [
                            ...form.values.recipients,
                            inputValue,
                          ]);
                          form.setFieldError("recipients", null);
                          setEmailSearch("");
                        }
                      } else if (e.key === " ") {
                        e.preventDefault();
                      }
                    }}
                  />
                  </div>
                </Accordion.Panel>
              </Accordion.Item>
            )}

            {/* Team folder selector: only shown when user is signed in, not a reverse share, has team folders, and no preselected folder */}
            {options.isUserSignedIn && !options.isReverseShare && !options.preselectedTeamFolderId && teamFolderOptions.length > 0 && (
              <Accordion.Item value="team-folder" style={{ borderBottom: "none" }}>
                <Accordion.Control>
                  <FormattedMessage id="upload.modal.team-folder.title" />
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack align="stretch">
                    <Select
                      variant="filled"
                      label={t("upload.modal.team-folder.label")}
                      placeholder={t("upload.modal.team-folder.placeholder")}
                      data={teamFolderOptions}
                      clearable
                      searchable
                      {...form.getInputProps("teamFolderId")}
                    />
                    <Text size="xs" c="dimmed">
                      <FormattedMessage id="upload.modal.team-folder.description" />
                    </Text>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            )}

            {/* Info: user has teams but no writable folders yet */}
            {options.isUserSignedIn && !options.isReverseShare && teamFolderOptions.length === 0 && myTeams && myTeams.length > 0 && (
              <Accordion.Item value="team-folder-info" style={{ borderBottom: "none" }}>
                <Accordion.Control>
                  <FormattedMessage id="upload.modal.team-folder.title" />
                </Accordion.Control>
                <Accordion.Panel>
                  <Alert
                    icon={<TbAlertCircle size={16} />}
                    color="blue"
                    variant="light"
                  >
                    Vous faites partie d'une équipe mais aucun dossier n'y est
                    encore créé. Pour envoyer des fichiers dans votre équipe,
                    rendez-vous d'abord sur la page de l'équipe et créez un
                    dossier dans l'onglet « Dossiers ».
                  </Alert>
                </Accordion.Panel>
              </Accordion.Item>
            )}

            <Accordion.Item value="security" style={{ borderBottom: "none" }}>
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
                      variant="filled"
                      placeholder={t(
                        "upload.modal.accordion.security.max-views.placeholder",
                      )}
                      label={t("upload.modal.accordion.security.max-views.label")}
                      {...form.getInputProps("maxViews")}
                    />
                  )}
                  {/* [UX/Security] E2E key email checkbox hidden
                     Also hidden when the user has not yet set up E2E encryption
                     in their account: the key doesn't exist yet so sharing it
                     via email would be meaningless. */}
                  {!options.isReverseShare &&
                    options.isUserSignedIn &&
                    options.userHasE2E &&
                    options.enableEmailRecepients &&
                    options.enableE2EKeyEmailSharing && (
                      <Checkbox
                        label={t(
                          "upload.modal.accordion.security.e2e-key-email.label",
                        )}
                        description={t(
                          "upload.modal.accordion.security.e2e-key-email.description",
                        )}
                        styles={{ description: { whiteSpace: "pre-line" } }}
                        {...form.getInputProps("shareE2EKeyViaEmail", {
                          type: "checkbox",
                        })}
                      />
                    )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Checkbox
            label={t("upload.modal.notify-download.label")}
            description={t("upload.modal.notify-download.description")}
            styles={{ description: { whiteSpace: "pre-line" } }}
            {...form.getInputProps("notifyOnDownload", {
              type: "checkbox",
            })}
          />
          {showCaptcha && (
            <Center>
              <HCaptcha
                ref={captchaRef}
                sitekey={options.captchaSiteKey!}
                onVerify={setCaptchaToken}
                onExpire={handleCaptchaExpire}
                onError={handleCaptchaError}
                theme={theme.other.colorScheme}
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
    planMaxExpirationDays: number;
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

  const handleCaptchaExpire = () => setCaptchaToken(null);
  const handleCaptchaError = (error: any) => {
    console.warn("[hCaptcha Error]", error);
    // Attempt to reset the captcha on error (e.g., WebGL context lost on Safari)
    if (captchaRef.current?.resetCaptcha) {
      captchaRef.current.resetCaptcha();
    }
  };

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

    // Expiration defaults:
    // - Anonymous: anonymousMaxExpiration (5d), fallback to maxExpiration
    // - Signed-in with plan limit: planMaxExpirationDays
    // - Admin (planMaxExpirationDays === 0): "never" (unlimited)
    let expiration: string;
    if (!options.isUserSignedIn && options.anonymousMaxExpiration.value !== 0) {
      expiration = `${options.anonymousMaxExpiration.value}-${options.anonymousMaxExpiration.unit}`;
    } else if (!options.isUserSignedIn && options.maxExpiration.value !== 0) {
      expiration = `${options.maxExpiration.value}-${options.maxExpiration.unit}`;
    } else if (options.isUserSignedIn && options.planMaxExpirationDays > 0) {
      expiration = `${options.planMaxExpirationDays}-days`;
    } else {
      // Admin SaaS (planMaxExpirationDays === 0) = unlimited
      expiration = "never";
    }

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
                onExpire={handleCaptchaExpire}
                onError={handleCaptchaError}
                theme={theme.other.colorScheme}
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
