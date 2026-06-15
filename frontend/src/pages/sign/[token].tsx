import { useRouter } from "next/router";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useIntl } from "react-intl";
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
  PinInput,
  Stack,
  Stepper,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  TbCheck,
  TbDownload,
  TbExternalLink,
  TbLock,
  TbMail,
  TbPencil,
  TbShieldCheck,
  TbX,
} from "react-icons/tb";
import Meta from "../../components/Meta";
import SignaturePad from "../../components/signing/SignaturePad";
import signingService from "../../services/signing.service";
import toast from "../../utils/toast.util";
import { importKeyFromBase64, decryptFileAuto } from "../../utils/crypto.util";

/**
 * Public signing page: /sign/[token]
 * Recipients access this page via email link.
 * Steps: 1) View document 2) OTP verification 3) Sign/Reject
 */
const SignPage = () => {
  const router = useRouter();
  const intl = useIntl();
  const { token } = router.query;
  const tokenStr = Array.isArray(token) ? token[0] : token || "";
  const isMobile = useMediaQuery("(max-width: 768px)");

  const [step, setStep] = useState(0);
  const [otpCode, setOtpCode] = useState("");
  const [otpVerified, setOtpVerified] = useState(false);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [signatureType, setSignatureType] = useState<"DRAW" | "TYPE" | "UPLOAD">("DRAW");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [downloadingSignedPdf, setDownloadingSignedPdf] = useState(false);

  // --- E2E: read encryption key from URL fragment (#key=...) ---
  const [e2eKey, setE2eKey] = useState<string | null>(null);
  const [decryptedBlobUrl, setDecryptedBlobUrl] = useState<string | null>(null);
  const [decryptError, setDecryptError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  // Extract key from hash on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    const match = hash.match(/#key=([A-Za-z0-9_-]+)/);
    if (match) setE2eKey(match[1]);
  }, []);

  // Fetch signing page data
  const {
    data: signingData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["signing.page", tokenStr],
    queryFn: () => signingService.getSigningPage(tokenStr),
    enabled: !!tokenStr,
  });

  useEffect(() => {
    if (!signingData?.recipient?.otpVerified) return;
    setOtpVerified(true);
    setStep((current) => (current < 2 ? 2 : current));
  }, [signingData?.recipient?.otpVerified]);

  // E2E: fetch encrypted preview, decrypt client-side, create blob URL
  useEffect(() => {
    const canPreviewDocument = otpVerified || !!signingData?.recipient?.otpVerified;
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
        const previewUrl = signingService.getPreviewUrl(tokenStr);
        const resp = await fetch(previewUrl);
        if (!resp.ok) throw new Error("Preview fetch failed");
        const encryptedBuf = await resp.arrayBuffer();
        const cryptoKey = await importKeyFromBase64(e2eKey);
        // Default chunk size 5MB - decryptFileAuto tries multiple sizes
        const decryptedBuf = await decryptFileAuto(encryptedBuf, cryptoKey, 5_000_000);
        if (cancelled) return;
        const blob = new Blob([decryptedBuf], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setDecryptedBlobUrl(url);
      } catch {
        if (!cancelled) setDecryptError(true);
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [e2eKey, tokenStr, signingData, otpVerified, step, decryptedBlobUrl]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  // Send OTP mutation
  const sendOtpMutation = useMutation({
    mutationFn: () => signingService.sendOtp(tokenStr),
    onSuccess: () => {
      toast.success("Code de vérification envoyé à votre adresse email");
      setStep(1);
    },
    onError: () => toast.error("Impossible d'envoyer le code de vérification"),
  });

  // Verify OTP mutation
  const verifyOtpMutation = useMutation({
    mutationFn: () => signingService.verifyOtp(tokenStr, otpCode),
    onSuccess: (data) => {
      if (data.verified) {
        setOtpVerified(true);
        setStep(2);
        toast.success("Identité vérifiée avec succès");
      } else {
        toast.error("Code incorrect ou expiré");
      }
    },
    onError: () => toast.error("Erreur lors de la vérification"),
  });

  // Sign mutation
  const signMutation = useMutation({
    mutationFn: () =>
      signingService.signDocument(tokenStr, {
        signatureData: signatureImage || "",
        signatureType,
      }),
    onSuccess: () => {
      toast.success("Document signé avec succès !");
      setStep(3);
    },
    onError: () => toast.error("Erreur lors de la signature du document"),
  });

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: () => signingService.rejectDocument(tokenStr, rejectReason),
    onSuccess: () => {
      toast.success("Document refusé");
      setStep(3);
    },
    onError: () => toast.error("Erreur lors du refus"),
  });

  if (!tokenStr) {
    return (
      <Container size="sm" mt="xl">
        <Alert color="red" title="Lien invalide">
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
        <Alert color="red" title="Erreur">
          Ce document n'existe pas, a déjà été signé, ou le lien a expiré.
        </Alert>
      </Container>
    );
  }

  const { document: sigDoc, recipient, fields: _fields } = signingData;

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
                color={sigDoc.signatureLevel === "QES" ? "violet" : "blue"}
                variant="light"
                size="lg"
              >
                <Group gap={4}>
                  <TbShieldCheck size={14} />
                  eIDAS {sigDoc.signatureLevel}
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
            active={step >= 3 ? 4 : step}
            mb="xl"
            size={isMobile ? "xs" : "sm"}
            completedIcon={<TbCheck size={isMobile ? 14 : 18} />}
          >
            <Stepper.Step
              label={isMobile ? undefined : "Consulter"}
              description={isMobile ? undefined : "Lire le document"}
              icon={<TbPencil size={isMobile ? 14 : 18} />}
            />
            <Stepper.Step
              label={isMobile ? undefined : "Verifier"}
              description={isMobile ? undefined : "Confirmer votre identite"}
              icon={<TbMail size={isMobile ? 14 : 18} />}
            />
            <Stepper.Step
              label={isMobile ? undefined : "Signer"}
              description={isMobile ? undefined : "Apposer votre signature"}
              icon={<TbLock size={isMobile ? 14 : 18} />}
            />
            <Stepper.Step
              label={isMobile ? undefined : "Termine"}
              description={isMobile ? undefined : "Document signe"}
              icon={<TbCheck size={isMobile ? 14 : 18} />}
              completedIcon={<TbCheck size={isMobile ? 14 : 18} />}
              color="green"
            />
          </Stepper>

          {/* Step 0: Start identity verification */}
          {step === 0 && (
            <Stack gap="md">
              <Paper
                withBorder
                style={{
                  minHeight: isMobile ? 240 : 280,
                  overflow: "hidden",
                  background: "#f8f9fa",
                  borderRadius: "var(--mantine-radius-md)",
                }}
              >
                <Center style={{ minHeight: isMobile ? 240 : 280 }} p="md">
                  <Stack align="center" gap="sm" maw={520}>
                    <TbLock size={44} color="var(--mantine-color-blue-6)" />
                    <Title order={3} ta="center">
                      Verification d'identite requise
                    </Title>
                    <Text size="sm" c="dimmed" ta="center">
                      Pour proteger ce document, son contenu sera affiche
                      uniquement apres verification de l'adresse email du
                      signataire.
                    </Text>
                    <Text size="sm" ta="center">
                      Un code a 6 chiffres sera envoye a{" "}
                      <strong>{recipient.email}</strong>.
                    </Text>
                  </Stack>
                </Center>
              </Paper>

              <Alert variant="light" color="blue" icon={<TbShieldCheck />}>
                <Text size="sm">
                  <strong>Niveau de signature eIDAS {sigDoc.signatureLevel}</strong>
                  <br />
                  {sigDoc.signatureLevel === "AES"
                    ? "Signature électronique avancée : vérification d'identité par code OTP email, horodatage certifié et piste d'audit complète."
                    : "Signature électronique qualifiée : certificat qualifié délivré par un prestataire de confiance, valeur juridique équivalente à une signature manuscrite."}
                </Text>
              </Alert>

              <Group justify="center">
                <Button
                  size="lg"
                  leftSection={<TbMail size={20} />}
                  onClick={() => sendOtpMutation.mutate()}
                  loading={sendOtpMutation.isPending}
                >
                  Vérifier mon identité pour signer
                </Button>
              </Group>
            </Stack>
          )}

          {/* Step 1: OTP Verification */}
          {step === 1 && (
            <Stack gap="md" align="center">
              <TbMail size={48} color="var(--mantine-color-blue-6)" />
              <Title order={3} ta="center">Verification d'identite</Title>
              <Text size="sm" c="dimmed" ta="center" maw={400} px="xs">
                Un code a 6 chiffres a ete envoye a{" "}
                <strong>{recipient.email}</strong>. Entrez-le ci-dessous pour
                confirmer votre identite (valide 10 minutes).
              </Text>

              <Box style={{ width: "100%", maxWidth: 320, overflow: "hidden" }}>
                <PinInput
                  length={6}
                  type="number"
                  size={isMobile ? "md" : "lg"}
                  value={otpCode}
                  onChange={setOtpCode}
                  oneTimeCode
                  style={{ justifyContent: "center" }}
                />
              </Box>

              <Group justify="center" wrap="wrap" gap="sm">
                <Button
                  onClick={() => verifyOtpMutation.mutate()}
                  loading={verifyOtpMutation.isPending}
                  disabled={otpCode.length !== 6}
                >
                  Verifier
                </Button>
                <Button
                  variant="subtle"
                  onClick={() => sendOtpMutation.mutate()}
                  loading={sendOtpMutation.isPending}
                >
                  Renvoyer le code
                </Button>
              </Group>
            </Stack>
          )}

          {/* Step 2: Sign or Reject */}
          {step === 2 && !rejecting && (
            <Stack gap="md">
              <Alert color="green" icon={<TbCheck />}>
                Identite verifiee. Vous pouvez maintenant apposer votre
                signature.
              </Alert>

              <Paper
                withBorder
                style={{
                  height: isMobile ? 320 : 520,
                  overflow: "hidden",
                  background: "#f8f9fa",
                  borderRadius: "var(--mantine-radius-md)",
                }}
              >
                {sigDoc.isE2EEncrypted && e2eKey ? (
                  decryptedBlobUrl ? (
                    isMobile ? (
                      <Stack align="center" justify="center" h="100%" gap="md" p="md">
                        <TbPencil size={40} color="var(--mantine-color-blue-6)" />
                        <Text size="sm" ta="center" c="dimmed">
                          {intl.formatMessage({ id: "signing.mobile.pdf-e2e-unavailable" })}
                        </Text>
                        <Button
                          variant="light"
                          leftSection={<TbExternalLink size={16} />}
                          component="a"
                          href={decryptedBlobUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {intl.formatMessage({ id: "share.modal.file-preview.pdf-open" })}
                        </Button>
                      </Stack>
                    ) : (
                      <iframe
                        src={decryptedBlobUrl}
                        title="Apercu du document (E2E)"
                        style={{ width: "100%", height: "100%", border: "none" }}
                      />
                    )
                  ) : decryptError ? (
                    <Center style={{ height: "100%" }}>
                      <Alert color="red" title={intl.formatMessage({ id: "signing.mobile.decrypt-error-title" })}>
                        {intl.formatMessage({ id: "signing.mobile.decrypt-error-description" })}
                      </Alert>
                    </Center>
                  ) : (
                    <Center style={{ height: "100%" }}>
                      <Stack align="center" gap="xs">
                        <Loader />
                        <Text size="sm" c="dimmed">Dechiffrement du document...</Text>
                      </Stack>
                    </Center>
                  )
                ) : sigDoc.isE2EEncrypted && !e2eKey ? (
                  <Center style={{ height: "100%" }}>
                    <Alert color="orange" icon={<TbLock />} title="Document chiffre">
                      Ce document est protege par chiffrement de bout en bout.
                      Le lien que vous avez recu semble incomplet (cle manquante).
                    </Alert>
                  </Center>
                ) : tokenStr ? (
                  isMobile ? (
                    <Stack align="center" justify="center" h="100%" gap="md" p="md">
                      <TbPencil size={40} color="var(--mantine-color-blue-6)" />
                      <Text size="sm" ta="center" c="dimmed">
                        {intl.formatMessage({ id: "signing.mobile.view-before-sign" })}
                      </Text>
                      <Button
                        variant="light"
                        leftSection={<TbExternalLink size={16} />}
                        component="a"
                        href={signingService.getPreviewUrl(tokenStr)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {intl.formatMessage({ id: "share.modal.file-preview.pdf-open" })}
                      </Button>
                      <object
                        data={signingService.getPreviewUrl(tokenStr)}
                        type="application/pdf"
                        style={{ width: "100%", height: "220px", border: "none" }}
                      >
                        <Text size="xs" c="dimmed" ta="center" mt="xs">
                          {intl.formatMessage({ id: "signing.mobile.pdf-fallback-hint" })}
                        </Text>
                      </object>
                    </Stack>
                  ) : (
                    <iframe
                      src={signingService.getPreviewUrl(tokenStr)}
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

              <Text fw={500} size="lg">
                Apposer votre signature
              </Text>
              <Text size="sm" c="dimmed">
                Dessinez, saisissez ou importez votre signature ci-dessous.
              </Text>

              <Box style={{ width: "100%", overflow: "hidden" }}>
                <Center>
                  <SignaturePad
                    width={isMobile ? Math.min(window.innerWidth - 64, 340) : 400}
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

              <Text size="xs" c="dimmed" ta="center" maw={500} mx="auto" px="xs">
                En cliquant sur "Signer le document", vous attestez avoir lu
                le document, approuver son contenu et acceptez que votre
                signature electronique a la meme valeur juridique qu'une
                signature manuscrite conformement au reglement eIDAS (UE)
                910/2014. La mention "Lu et approuve le{" "}
                {new Date().toLocaleDateString("fr-FR")} " sera apposee.
              </Text>

              <Group justify="center" mt="md" wrap="wrap" gap="sm">
                <Button
                  size={isMobile ? "md" : "lg"}
                  color="green"
                  leftSection={<TbPencil size={20} />}
                  onClick={() => signMutation.mutate()}
                  loading={signMutation.isPending}
                  disabled={!signatureImage}
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
                    ? intl.formatMessage({ id: "signing.sign.success.e2e-desc" })
                    : intl.formatMessage({ id: "signing.sign.success.desc" })}
              </Text>
              <Badge
                color="green"
                size="lg"
                variant="light"
                style={{ maxWidth: "100%", whiteSpace: "normal", height: "auto", padding: "6px 12px" }}
              >
                <Group gap={4} wrap="nowrap" style={{ flexWrap: "wrap", justifyContent: "center" }}>
                  <TbShieldCheck size={14} style={{ flexShrink: 0 }} />
                  <Text size="xs" span style={{ lineHeight: 1.3 }}>
                    {intl.formatMessage({ id: "signing.sign.eidas.badge" })}
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
                      const blob = await signingService.downloadSignedByToken(tokenStr);
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${sigDoc.fileName?.replace(".pdf", "") || "document"}_signed.pdf`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch {
                      toast.error(intl.formatMessage({ id: "signing.sign.download-not-ready" }));
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
