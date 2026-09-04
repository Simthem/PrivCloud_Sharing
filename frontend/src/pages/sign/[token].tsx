import { useRouter } from "next/router";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useIntl } from "react-intl";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import "@mantine/core/styles/Stepper.css";
import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Stepper,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  TbCheck,
  TbDownload,
  TbExternalLink,
  TbLock,
  TbFingerprint,
  TbFileDescription,
  TbLogin,
  TbMailCheck,
  TbPencil,
  TbShieldCheck,
  TbX,
} from "react-icons/tb";
import Meta from "../../components/Meta";
import SignaturePad from "../../components/signing/SignaturePad";
import signingService from "../../services/signing.service";
import useUser from "../../hooks/user.hook";
import {
  buildSignInRedirectPath,
  rememberPostAuthRedirectTarget,
} from "../../utils/authRedirect.util";
import toast from "../../utils/toast.util";
import { importKeyFromBase64, decryptFileAuto } from "../../utils/crypto.util";

const readableDangerAlertStyles = {
  root: {
    backgroundColor: "var(--mantine-color-red-9)",
    borderColor: "var(--mantine-color-red-9)",
    color: "var(--mantine-color-white)",
  },
  title: { color: "var(--mantine-color-white)" },
  message: { color: "var(--mantine-color-white)" },
  icon: { color: "var(--mantine-color-white)" },
};

/**
 * Public signing page: /sign/[token]
 * Standard requests require a short-lived code delivered to the assigned
 * email before explicit consent. Reinforced requests require the assigned
 * verified account and a fresh WebAuthn action.
 */
const SignPage = () => {
  const router = useRouter();
  const intl = useIntl();
  const { token } = router.query;
  const tokenStr = Array.isArray(token) ? token[0] : token || "";
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { user } = useUser();

  const [step, setStep] = useState(0);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [signatureType, setSignatureType] = useState<
    "DRAW" | "TYPE" | "UPLOAD"
  >("DRAW");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [downloadingSignedPdf, setDownloadingSignedPdf] = useState(false);
  const [webAuthnSupported, setWebAuthnSupported] = useState(true);
  const [emailOtp, setEmailOtp] = useState("");
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const directDownloadDoneRef = useRef(false);

  // --- E2E: read encryption key from URL fragment (#key=...) ---
  const [e2eKey, setE2eKey] = useState<string | null>(null);
  const [decryptedBlobUrl, setDecryptedBlobUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<
    "unavailable" | "decrypt" | null
  >(null);
  const blobUrlRef = useRef<string | null>(null);

  // Extract key from hash on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    setWebAuthnSupported(browserSupportsWebAuthn());
    const hash = window.location.hash;
    const match = hash.match(/#key=([A-Za-z0-9_-]+)/);
    if (match) setE2eKey(match[1]);
  }, []);

  // Fetch signing page data
  const {
    data: signingData,
    isLoading,
    error,
    refetch: refetchSigningData,
  } = useQuery({
    queryKey: ["signing.page", tokenStr],
    queryFn: () => signingService.getSigningPage(tokenStr),
    enabled: !!tokenStr,
    // A removed/expired signing token is a final state, not a transient
    // failure. Do not keep the recipient on the loader while React Query
    // retries the API's 404 response.
    retry: false,
  });

  const fillableFields =
    signingData?.fields?.filter((field) =>
      ["TEXT", "APPROVAL", "DATE"].includes(field.type),
    ) || [];

  const normalizeFieldText = (value: string) =>
    value.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");

  const fieldIsComplete = (field: (typeof fillableFields)[number]) => {
    const value = (fieldValues[field.id] || "").trim();
    if (field.required && !value) return false;
    if (
      field.type === "APPROVAL" &&
      field.label &&
      normalizeFieldText(value) !== normalizeFieldText(field.label)
    ) {
      return false;
    }
    return true;
  };

  const allRequiredFieldsComplete = fillableFields.every(fieldIsComplete);

  const isReinforced = signingData?.document.signatureLevel === "REINFORCED";
  const isEmailVerified = Boolean(signingData?.recipient.emailVerified);
  const hasPendingEmailOtp = Boolean(
    emailOtpSent || signingData?.emailVerificationCodePending,
  );
  const isAssignedAccount = Boolean(
    user?.email &&
    signingData?.recipient.email &&
    user.email.toLowerCase() === signingData.recipient.email.toLowerCase(),
  );
  const previewUrl = tokenStr
    ? isReinforced
      ? signingService.getAuthenticatedPreviewUrl(tokenStr)
      : signingService.getPreviewUrl(tokenStr)
    : "";

  // A final encrypted team notification resolves here with ?download=1. Do
  // not make the signer hunt through the document list: download immediately
  // once finalization is complete. E2E results are decrypted locally with the
  // key carried only inside the recipient-encrypted notification action.
  useEffect(() => {
    if (
      router.query.download !== "1" ||
      directDownloadDoneRef.current ||
      !signingData ||
      signingData.recipient.status !== "SIGNED" ||
      signingData.documentStatus !== "COMPLETED" ||
      (signingData.document.isE2EEncrypted && !e2eKey)
    )
      return;
    directDownloadDoneRef.current = true;
    void (async () => {
      setDownloadingSignedPdf(true);
      try {
        const downloadedBlob = isReinforced
          ? await signingService.downloadSignedByTokenAuthenticated(tokenStr)
          : await signingService.downloadSignedByToken(tokenStr);
        let blob = downloadedBlob;
        if (signingData.document.isE2EEncrypted && e2eKey) {
          const decrypted = await decryptFileAuto(
            await downloadedBlob.arrayBuffer(),
            await importKeyFromBase64(e2eKey),
            5_000_000,
          );
          blob = new Blob([decrypted], { type: "application/pdf" });
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${signingData.document.fileName.replace(/\.pdf$/i, "")}_signed.pdf`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        toast.error("Le document signé n'est pas encore disponible.");
      } finally {
        setDownloadingSignedPdf(false);
      }
    })();
  }, [e2eKey, isReinforced, router.query.download, signingData, tokenStr]);

  useEffect(() => {
    if (!signingData || step >= 3) return;
    if (!isReinforced) {
      setStep(isEmailVerified ? 2 : 1);
    } else if (isAssignedAccount && signingData.hasRegisteredPasskey) {
      setStep(2);
    } else {
      setStep(0);
    }
  }, [isAssignedAccount, isEmailVerified, isReinforced, signingData, step]);

  useEffect(() => {
    if (!signingData?.fields?.length) return;
    setFieldValues((current) => {
      const next = { ...current };
      for (const field of signingData.fields) {
        if (field.type === "DATE" && !next[field.id]) {
          next[field.id] = new Date().toLocaleDateString("fr-FR", {
            day: "numeric",
            month: "long",
            year: "numeric",
            timeZone: "Europe/Paris",
          });
        }
      }
      return next;
    });
  }, [signingData?.fields]);

  // E2E: fetch encrypted preview, decrypt client-side, create blob URL
  useEffect(() => {
    const canPreviewDocument = isReinforced
      ? isAssignedAccount && signingData?.hasRegisteredPasskey
      : isEmailVerified;
    if (
      !canPreviewDocument ||
      step < 2 ||
      !e2eKey ||
      !tokenStr ||
      !signingData?.document?.isE2EEncrypted
    ) {
      return;
    }
    if (decryptedBlobUrl) return; // already done

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(previewUrl, { credentials: "include" });
        if (!resp.ok) {
          if (!cancelled) setPreviewError("unavailable");
          return;
        }
        const encryptedBuf = await resp.arrayBuffer();
        const cryptoKey = await importKeyFromBase64(e2eKey);
        // Default chunk size 5MB - decryptFileAuto tries multiple sizes
        const decryptedBuf = await decryptFileAuto(
          encryptedBuf,
          cryptoKey,
          5_000_000,
        );
        if (cancelled) return;
        const blob = new Blob([decryptedBuf], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setDecryptedBlobUrl(url);
        setPreviewError(null);
      } catch {
        if (!cancelled) setPreviewError("decrypt");
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [
    e2eKey,
    tokenStr,
    signingData,
    isReinforced,
    isEmailVerified,
    isAssignedAccount,
    previewUrl,
    step,
    decryptedBlobUrl,
  ]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const registerPasskeyMutation = useMutation({
    mutationFn: async () => {
      const ceremony = await signingService.beginPasskeyRegistration(tokenStr);
      const response = await startRegistration({
        optionsJSON: ceremony.options as unknown as Parameters<
          typeof startRegistration
        >[0]["optionsJSON"],
      });
      return signingService.finishPasskeyRegistration(
        tokenStr,
        ceremony.challengeId,
        response as unknown as Record<string, unknown>,
      );
    },
    onSuccess: async () => {
      await refetchSigningData();
      setStep(2);
      toast.success("Passkey enregistrée. Votre compte est prêt à signer.");
    },
    onError: () =>
      toast.error("L'enregistrement de la passkey a été annulé ou a échoué."),
  });

  const sendEmailOtpMutation = useMutation({
    mutationFn: () => signingService.sendSigningEmailOtp(tokenStr),
    onSuccess: (result) => {
      if (result.verified) {
        void refetchSigningData();
        setStep(2);
        return;
      }
      setEmailOtpSent(true);
      toast.success(intl.formatMessage({ id: "signing.sign.otp.sent" }));
    },
    onError: () =>
      toast.error(intl.formatMessage({ id: "signing.sign.otp.send-error" })),
  });

  const verifyEmailOtpMutation = useMutation({
    mutationFn: () => signingService.verifySigningEmailOtp(tokenStr, emailOtp),
    onSuccess: async () => {
      await refetchSigningData();
      setEmailOtp("");
      setStep(2);
      toast.success(intl.formatMessage({ id: "signing.sign.otp.verified" }));
    },
    onError: () =>
      toast.error(intl.formatMessage({ id: "signing.sign.otp.invalid" })),
  });

  // Sign mutation
  const signMutation = useMutation({
    mutationFn: async () => {
      const fieldsToSubmit = fillableFields
        .map((field) => ({
          fieldId: field.id,
          value: (fieldValues[field.id] || "").trim(),
        }))
        .filter((field) => field.value.length > 0);

      const payload = {
        signatureData: signatureImage || "",
        signatureType,
        fieldValues: fieldsToSubmit,
      };
      if (!isReinforced) {
        return signingService.signDocument(tokenStr, payload);
      }

      const ceremony = await signingService.beginPasskeyAction(tokenStr, {
        action: "SIGN",
        ...payload,
      });
      const assertion = await startAuthentication({
        optionsJSON: ceremony.options as unknown as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"],
      });
      return signingService.signDocument(tokenStr, {
        ...payload,
        passkeyChallengeId: ceremony.challengeId,
        passkeyResponse: assertion as unknown as Record<string, unknown>,
      });
    },
    onSuccess: () => {
      toast.success("Document signé avec succès !");
      setStep(3);
    },
    onError: () => toast.error("Erreur lors de la signature du document"),
  });

  const handleSign = () => {
    const invalidField = fillableFields.find(
      (field) => !fieldIsComplete(field),
    );
    if (invalidField) {
      toast.error(
        invalidField.type === "APPROVAL"
          ? "La mention obligatoire doit être recopiée exactement."
          : "Veuillez compléter tous les champs obligatoires.",
      );
      return;
    }
    signMutation.mutate();
  };

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: async () => {
      if (!isReinforced) {
        return signingService.rejectDocument(tokenStr, {
          reason: rejectReason || undefined,
        });
      }
      const ceremony = await signingService.beginPasskeyAction(tokenStr, {
        action: "REJECT",
        reason: rejectReason || undefined,
      });
      const assertion = await startAuthentication({
        optionsJSON: ceremony.options as unknown as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"],
      });
      return signingService.rejectDocument(tokenStr, {
        reason: rejectReason || undefined,
        passkeyChallengeId: ceremony.challengeId,
        passkeyResponse: assertion as unknown as Record<string, unknown>,
      });
    },
    onSuccess: () => {
      toast.success("Document refusé");
      setStep(3);
    },
    onError: () => toast.error("Erreur lors du refus"),
  });

  if (!tokenStr) {
    return (
      <Container size="sm" mt="xl">
        <Alert
          variant="filled"
          color="red"
          styles={readableDangerAlertStyles}
          title={intl.formatMessage({ id: "signing.sign.unavailable.title" })}
        >
          Ce lien de signature est invalide ou incomplet.
        </Alert>
      </Container>
    );
  }

  if (isLoading) {
    return (
      <Center mt="xl">
        <Loader size="lg" />
      </Center>
    );
  }

  if (error || !signingData) {
    return (
      <Container size="sm" mt="xl">
        <Alert
          variant="filled"
          color="red"
          styles={readableDangerAlertStyles}
          title={intl.formatMessage({ id: "signing.sign.unavailable.title" })}
        >
          {intl.formatMessage({ id: "signing.sign.unavailable.description" })}
        </Alert>
      </Container>
    );
  }

  const { document: sigDoc, recipient } = signingData;

  // Already completed
  if (recipient.status === "SIGNED") {
    return (
      <Container size="sm" mt="xl">
        <Alert color="green" icon={<TbCheck />} title="Déjà signé">
          Vous avez déjà signé ce document.
        </Alert>
      </Container>
    );
  }

  if (recipient.status === "REJECTED") {
    return (
      <Container size="sm" mt="xl">
        <Alert color="orange" icon={<TbX />} title="Refusé">
          Vous avez refusé ce document.
        </Alert>
      </Container>
    );
  }

  return (
    <>
      <Meta title={`Signer - ${sigDoc.fileName}`} noIndex />
      <Container size="md" mt="xl" mb="xl" px={isMobile ? "xs" : undefined}>
        <Paper shadow="sm" p={isMobile ? "md" : "xl"} radius="md" withBorder>
          {/* Header */}
          <Stack gap="md" mb="lg">
            <Group justify="space-between">
              <Title order={2}>{sigDoc.fileName}</Title>
              <Badge
                color={isReinforced ? "violet" : "blue"}
                variant="light"
                size="lg"
              >
                <Group gap={4}>
                  <TbShieldCheck size={14} />
                  {isReinforced ? "Signature renforcée" : "Signature standard"}
                </Group>
              </Badge>
            </Group>
            {sigDoc.message && (
              <Text c="dimmed" size="sm">
                {sigDoc.message}
              </Text>
            )}
            <Text size="sm">
              Signataire : <strong>{recipient.name}</strong> ({recipient.email})
            </Text>
          </Stack>

          <Divider mb="lg" />

          {/* Stepper */}
          <Stepper
            active={step >= 3 ? 5 : step === 2 ? (reviewConfirmed ? 3 : 2) : 1}
            mb="xl"
            size={isMobile ? "xs" : "sm"}
            completedIcon={<TbCheck size={isMobile ? 14 : 18} />}
          >
            <Stepper.Step
              label={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: "signing.sign.steps.invitation",
                    })
              }
              description={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: "signing.sign.steps.invitation.description",
                    })
              }
              icon={<TbMailCheck size={isMobile ? 14 : 18} />}
            />
            <Stepper.Step
              label={
                isMobile
                  ? undefined
                  : intl.formatMessage({ id: "signing.sign.steps.review" })
              }
              description={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: "signing.sign.steps.review.description",
                    })
              }
              icon={<TbFileDescription size={isMobile ? 14 : 18} />}
            />
            <Stepper.Step
              label={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: isReinforced
                        ? "signing.sign.steps.secure"
                        : "signing.sign.steps.email",
                    })
              }
              description={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: isReinforced
                        ? "signing.sign.steps.secure.description"
                        : "signing.sign.steps.email.description",
                    })
              }
              icon={
                isReinforced ? (
                  <TbFingerprint size={isMobile ? 14 : 18} />
                ) : (
                  <TbMailCheck size={isMobile ? 14 : 18} />
                )
              }
            />
            <Stepper.Step
              label={
                isMobile
                  ? undefined
                  : intl.formatMessage({ id: "signing.sign.steps.sign" })
              }
              description={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: "signing.sign.steps.sign.description",
                    })
              }
              icon={<TbLock size={isMobile ? 14 : 18} />}
            />
            <Stepper.Step
              label={
                isMobile
                  ? undefined
                  : intl.formatMessage({ id: "signing.sign.steps.done" })
              }
              description={
                isMobile
                  ? undefined
                  : intl.formatMessage({
                      id: "signing.sign.steps.done.description",
                    })
              }
              icon={<TbCheck size={isMobile ? 14 : 18} />}
              completedIcon={<TbCheck size={isMobile ? 14 : 18} />}
              color="green"
            />
          </Stepper>

          {/* Step 0: reinforced-account and passkey gate */}
          {step === 0 && isReinforced && (
            <Stack gap="md">
              <Paper
                withBorder
                style={{
                  minHeight: isMobile ? 240 : 280,
                  overflow: "hidden",
                  // Theme-aware: a hard-coded light panel makes every
                  // Mantine child render dark-on-dark or light-on-light.
                  background: "var(--mantine-color-default)",
                  borderRadius: "var(--mantine-radius-md)",
                }}
              >
                <Center style={{ minHeight: isMobile ? 240 : 280 }} p="md">
                  <Stack align="center" gap="sm" maw={520}>
                    <TbFingerprint
                      size={48}
                      color="var(--mantine-color-violet-6)"
                    />
                    <Title order={3} ta="center">
                      Compte vérifié et passkey requis
                    </Title>
                    <Text size="sm" c="dimmed" ta="center">
                      Ce parcours renforcé est réservé au compte PrivCloud
                      attribué à <strong>{recipient.email}</strong>. La passkey
                      demandera ensuite la biométrie ou le code local de
                      l'appareil pour chaque décision.
                    </Text>
                  </Stack>
                </Center>
              </Paper>

              <Alert variant="light" color="violet" icon={<TbShieldCheck />}>
                <Text size="sm">
                  <strong>Alignement eIDAS — niveau renforcé</strong>
                  <br />
                  {intl.formatMessage({
                    id: "signing.sign.legal.reinforced-short",
                  })}
                </Text>
              </Alert>

              <Group justify="center">
                {!user || !isAssignedAccount ? (
                  <Button
                    size="lg"
                    leftSection={<TbLogin size={20} />}
                    onClick={() => {
                      const target = `/sign/${tokenStr}${typeof window !== "undefined" ? window.location.hash : ""}`;
                      rememberPostAuthRedirectTarget(target);
                      void router.push(
                        buildSignInRedirectPath(`/sign/${tokenStr}`),
                      );
                    }}
                  >
                    {!user
                      ? "Se connecter avec le compte attribué"
                      : "Changer de compte PrivCloud"}
                  </Button>
                ) : (
                  <Stack align="center" gap="sm">
                    {!webAuthnSupported && (
                      <Alert color="red">
                        Ce navigateur ne prend pas en charge WebAuthn. Utilisez
                        un navigateur récent ou une clé de sécurité compatible.
                      </Alert>
                    )}
                    <Button
                      size="lg"
                      color="violet"
                      leftSection={<TbFingerprint size={20} />}
                      onClick={() => registerPasskeyMutation.mutate()}
                      loading={registerPasskeyMutation.isPending}
                      disabled={!webAuthnSupported}
                    >
                      Enregistrer une passkey de signature
                    </Button>
                  </Stack>
                )}
              </Group>
            </Stack>
          )}

          {/* Step 1: standard email-control verification */}
          {step === 1 && !isReinforced && (
            <Stack gap="md">
              <Paper
                withBorder
                p={isMobile ? "md" : "xl"}
                style={{
                  background: "var(--mantine-color-blue-light)",
                  borderRadius: "var(--mantine-radius-md)",
                }}
              >
                <Stack align="center" gap="sm" maw={560} mx="auto">
                  <TbMailCheck size={48} color="var(--mantine-color-blue-7)" />
                  <Title order={3} ta="center">
                    {intl.formatMessage({ id: "signing.sign.otp.title" })}
                  </Title>
                  <Text size="sm" ta="center">
                    {intl.formatMessage(
                      { id: "signing.sign.otp.description" },
                      { email: recipient.email },
                    )}
                  </Text>
                </Stack>
              </Paper>

              <Alert variant="light" color="blue" icon={<TbShieldCheck />}>
                {intl.formatMessage({
                  id: "signing.sign.legal.standard-short",
                })}
              </Alert>

              {!hasPendingEmailOtp ? (
                <Group justify="center">
                  <Button
                    size="lg"
                    leftSection={<TbMailCheck size={20} />}
                    onClick={() => sendEmailOtpMutation.mutate()}
                    loading={sendEmailOtpMutation.isPending}
                  >
                    {intl.formatMessage({ id: "signing.sign.otp.send" })}
                  </Button>
                </Group>
              ) : (
                <Stack gap="sm" maw={360} mx="auto" w="100%">
                  <TextInput
                    label={intl.formatMessage({
                      id: "signing.sign.otp.code-label",
                    })}
                    placeholder={intl.formatMessage({
                      id: "signing.sign.otp.placeholder",
                    })}
                    value={emailOtp}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    onChange={(event) =>
                      setEmailOtp(
                        event.currentTarget.value
                          .replace(/\D/g, "")
                          .slice(0, 6),
                      )
                    }
                  />
                  <Button
                    onClick={() => verifyEmailOtpMutation.mutate()}
                    loading={verifyEmailOtpMutation.isPending}
                    disabled={!/^\d{6}$/.test(emailOtp)}
                  >
                    {intl.formatMessage({ id: "signing.sign.otp.verify" })}
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => sendEmailOtpMutation.mutate()}
                    loading={sendEmailOtpMutation.isPending}
                  >
                    {intl.formatMessage({ id: "signing.sign.otp.resend" })}
                  </Button>
                </Stack>
              )}
            </Stack>
          )}

          {/* Step 2: Sign or Reject */}
          {step === 2 && !rejecting && (
            <Stack gap="md">
              <Alert color="green" icon={<TbCheck />}>
                {isReinforced
                  ? intl.formatMessage({
                      id: "signing.sign.assurance.reinforced",
                    })
                  : intl.formatMessage({
                      id: "signing.sign.assurance.standard",
                    })}
              </Alert>

              <Paper
                withBorder
                style={{
                  height: isMobile ? 320 : 520,
                  overflow: "hidden",
                  // Theme-aware: a hard-coded light panel makes every
                  // Mantine child render dark-on-dark or light-on-light.
                  background: "var(--mantine-color-default)",
                  borderRadius: "var(--mantine-radius-md)",
                }}
              >
                {sigDoc.isE2EEncrypted && e2eKey ? (
                  decryptedBlobUrl ? (
                    isMobile ? (
                      <Stack
                        align="center"
                        justify="center"
                        h="100%"
                        gap="md"
                        p="md"
                      >
                        <TbPencil
                          size={40}
                          color="var(--mantine-color-blue-6)"
                        />
                        <Text size="sm" ta="center" c="dimmed">
                          {intl.formatMessage({
                            id: "signing.mobile.pdf-e2e-unavailable",
                          })}
                        </Text>
                        <Button
                          variant="light"
                          leftSection={<TbExternalLink size={16} />}
                          component="a"
                          href={decryptedBlobUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {intl.formatMessage({
                            id: "share.modal.file-preview.pdf-open",
                          })}
                        </Button>
                      </Stack>
                    ) : (
                      <iframe
                        src={decryptedBlobUrl}
                        title="Apercu du document (E2E)"
                        style={{
                          width: "100%",
                          height: "100%",
                          border: "none",
                        }}
                      />
                    )
                  ) : previewError ? (
                    <Center style={{ height: "100%" }}>
                      <Alert
                        variant="filled"
                        color="red"
                        styles={readableDangerAlertStyles}
                        title={intl.formatMessage({
                          id:
                            previewError === "unavailable"
                              ? "signing.preview.unavailable.title"
                              : "signing.mobile.decrypt-error-title",
                        })}
                      >
                        {intl.formatMessage({
                          id:
                            previewError === "unavailable"
                              ? "signing.preview.unavailable.description"
                              : "signing.mobile.decrypt-error-description",
                        })}
                      </Alert>
                    </Center>
                  ) : (
                    <Center style={{ height: "100%" }}>
                      <Stack align="center" gap="xs">
                        <Loader />
                        <Text size="sm" c="dimmed">
                          Déchiffrement du document…
                        </Text>
                      </Stack>
                    </Center>
                  )
                ) : sigDoc.isE2EEncrypted && !e2eKey ? (
                  <Center style={{ height: "100%" }}>
                    <Alert
                      variant="filled"
                      color="blue"
                      icon={<TbLock />}
                      title="Document chiffré — clé manquante"
                      styles={{
                        root: {
                          backgroundColor: "var(--mantine-color-blue-9)",
                          borderColor: "var(--mantine-color-blue-9)",
                          color: "var(--mantine-color-white)",
                        },
                        title: { color: "var(--mantine-color-white)" },
                        message: { color: "var(--mantine-color-white)" },
                        icon: { color: "var(--mantine-color-white)" },
                      }}
                    >
                      Ce document est protégé par chiffrement de bout en bout.
                      Le lien reçu est incomplet : sa clé de déchiffrement est
                      absente.
                    </Alert>
                  </Center>
                ) : tokenStr ? (
                  isMobile ? (
                    <Stack
                      align="center"
                      justify="center"
                      h="100%"
                      gap="md"
                      p="md"
                    >
                      <TbPencil size={40} color="var(--mantine-color-blue-6)" />
                      <Text size="sm" ta="center" c="dimmed">
                        {intl.formatMessage({
                          id: "signing.mobile.view-before-sign",
                        })}
                      </Text>
                      <Button
                        variant="light"
                        leftSection={<TbExternalLink size={16} />}
                        component="a"
                        href={previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {intl.formatMessage({
                          id: "share.modal.file-preview.pdf-open",
                        })}
                      </Button>
                      <object
                        data={previewUrl}
                        type="application/pdf"
                        style={{
                          width: "100%",
                          height: "220px",
                          border: "none",
                        }}
                      >
                        <Text size="xs" c="dimmed" ta="center" mt="xs">
                          {intl.formatMessage({
                            id: "signing.mobile.pdf-fallback-hint",
                          })}
                        </Text>
                      </object>
                    </Stack>
                  ) : (
                    <iframe
                      src={previewUrl}
                      title="Apercu du document"
                      style={{ width: "100%", height: "100%", border: "none" }}
                    />
                  )
                ) : (
                  <Center style={{ height: "100%" }}>
                    <Loader />
                  </Center>
                )}
              </Paper>

              {!reviewConfirmed ? (
                <Stack align="center" gap="sm">
                  <Text size="sm" c="dimmed" ta="center">
                    {intl.formatMessage({
                      id: "signing.sign.review.confirm-description",
                    })}
                  </Text>
                  <Group justify="center">
                    <Button
                      size={isMobile ? "md" : "lg"}
                      leftSection={<TbCheck size={20} />}
                      onClick={() => setReviewConfirmed(true)}
                    >
                      {intl.formatMessage({
                        id: "signing.sign.review.confirm",
                      })}
                    </Button>
                    <Button
                      variant="light"
                      color="red"
                      size={isMobile ? "md" : "lg"}
                      onClick={() => setRejecting(true)}
                    >
                      {intl.formatMessage({
                        id: "signing.sign.review.reject",
                      })}
                    </Button>
                  </Group>
                </Stack>
              ) : (
                <>
                  <Text fw={500} size="lg">
                    Apposer votre signature
                  </Text>
                  <Text size="sm" c="dimmed">
                    Dessinez, saisissez ou importez votre signature ci-dessous.
                  </Text>

                  {fillableFields.length > 0 && (
                    <Paper withBorder p="md">
                      <Stack gap="sm">
                        <div>
                          <Text fw={600}>Mentions et champs à compléter</Text>
                          <Text size="xs" c="dimmed">
                            Ces informations seront ajoutées au PDF signé.
                          </Text>
                        </div>
                        {fillableFields.map((field) => {
                          const exactMentionRequired =
                            field.type === "APPROVAL" && field.label;
                          return (
                            <Textarea
                              key={field.id}
                              label={
                                field.type === "APPROVAL"
                                  ? "Mention obligatoire"
                                  : field.type === "DATE"
                                    ? "Date"
                                    : field.label || "Champ texte"
                              }
                              description={
                                exactMentionRequired
                                  ? `Recopiez exactement : ${field.label}`
                                  : field.label || undefined
                              }
                              required={field.required}
                              autosize
                              minRows={field.type === "APPROVAL" ? 2 : 1}
                              readOnly={field.type === "DATE"}
                              value={fieldValues[field.id] || ""}
                              onChange={(event) =>
                                setFieldValues((current) => ({
                                  ...current,
                                  [field.id]: event.currentTarget.value,
                                }))
                              }
                              error={
                                field.type === "APPROVAL" &&
                                field.label &&
                                (fieldValues[field.id] || "").trim() &&
                                !fieldIsComplete(field)
                                  ? "La mention ne correspond pas au texte attendu."
                                  : undefined
                              }
                            />
                          );
                        })}
                      </Stack>
                    </Paper>
                  )}

                  <Box style={{ width: "100%", overflow: "hidden" }}>
                    <Center>
                      <SignaturePad
                        width={
                          isMobile ? Math.min(window.innerWidth - 64, 340) : 400
                        }
                        height={isMobile ? 140 : 160}
                        onSignatureChange={setSignatureImage}
                        onModeChange={(mode) =>
                          setSignatureType(
                            mode.toUpperCase() as "DRAW" | "TYPE" | "UPLOAD",
                          )
                        }
                      />
                    </Center>
                  </Box>

                  <Divider />

                  <Text
                    size="xs"
                    c="dimmed"
                    ta="center"
                    maw={500}
                    mx="auto"
                    px="xs"
                  >
                    {intl.formatMessage({
                      id: isReinforced
                        ? "signing.sign.legal.reinforced"
                        : "signing.sign.legal.standard",
                    })}
                  </Text>

                  <Group justify="center" mt="md" wrap="wrap" gap="sm">
                    <Button
                      size={isMobile ? "md" : "lg"}
                      color="green"
                      leftSection={<TbPencil size={20} />}
                      onClick={handleSign}
                      loading={signMutation.isPending}
                      disabled={!signatureImage || !allRequiredFieldsComplete}
                    >
                      Signer le document
                    </Button>
                    <Button
                      variant="light"
                      color="red"
                      size={isMobile ? "md" : "lg"}
                      onClick={() => setRejecting(true)}
                    >
                      Refuser
                    </Button>
                  </Group>
                </>
              )}
            </Stack>
          )}

          {/* Reject form */}
          {step === 2 && rejecting && (
            <Stack gap="md">
              <Title order={3}>Refuser le document</Title>
              <Text size="sm" c="dimmed">
                Vous pouvez indiquer un motif de refus (optionnel).
              </Text>
              <Textarea
                placeholder="Motif du refus..."
                value={rejectReason}
                onChange={(e) => setRejectReason(e.currentTarget.value)}
                minRows={3}
              />
              <Group>
                <Button
                  color="red"
                  onClick={() => rejectMutation.mutate()}
                  loading={rejectMutation.isPending}
                >
                  Confirmer le refus
                </Button>
                <Button variant="subtle" onClick={() => setRejecting(false)}>
                  Annuler
                </Button>
              </Group>
            </Stack>
          )}

          {/* Step 3: Done */}
          {step === 3 && (
            <Stack gap="md" align="center">
              <TbCheck size={64} color="var(--mantine-color-green-6)" />
              <Title order={3} ta="center">
                {rejectMutation.isSuccess
                  ? intl.formatMessage({ id: "signing.sign.rejected.title" })
                  : intl.formatMessage({ id: "signing.sign.success.title" })}
              </Title>
              <Text c="dimmed" ta="center" maw={400}>
                {rejectMutation.isSuccess
                  ? intl.formatMessage({ id: "signing.sign.rejected.desc" })
                  : sigDoc.isE2EEncrypted
                    ? intl.formatMessage({
                        id: "signing.sign.success.e2e-desc",
                      })
                    : intl.formatMessage({ id: "signing.sign.success.desc" })}
              </Text>
              <Badge
                color="green"
                size="lg"
                variant="light"
                style={{
                  maxWidth: "100%",
                  whiteSpace: "normal",
                  height: "auto",
                  padding: "6px 12px",
                }}
              >
                <Group
                  gap={4}
                  wrap="nowrap"
                  style={{ flexWrap: "wrap", justifyContent: "center" }}
                >
                  <TbShieldCheck size={14} style={{ flexShrink: 0 }} />
                  <Text size="xs" span style={{ lineHeight: 1.3 }}>
                    Dossier de preuve et empreinte cryptographique enregistrés
                  </Text>
                </Group>
              </Badge>
              {!rejectMutation.isSuccess && !sigDoc.isE2EEncrypted && (
                <Button
                  variant="light"
                  color="green"
                  leftSection={<TbDownload size={16} />}
                  loading={downloadingSignedPdf}
                  onClick={async () => {
                    setDownloadingSignedPdf(true);
                    try {
                      const blob = isReinforced
                        ? await signingService.downloadSignedByTokenAuthenticated(
                            tokenStr,
                          )
                        : await signingService.downloadSignedByToken(tokenStr);
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${sigDoc.fileName?.replace(".pdf", "") || "document"}_signed.pdf`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch {
                      toast.error(
                        intl.formatMessage({
                          id: "signing.sign.download-not-ready",
                        }),
                      );
                    } finally {
                      setDownloadingSignedPdf(false);
                    }
                  }}
                >
                  {intl.formatMessage({ id: "signing.sign.download-signed" })}
                </Button>
              )}
            </Stack>
          )}
        </Paper>
      </Container>
    </>
  );
};

export default SignPage;
