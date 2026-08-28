import {
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import Head from "next/head";
import { useRouter } from "next/router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import {
  clearRememberedEmailVerificationEmail,
  getRememberedEmailVerificationEmail,
  rememberEmailVerificationEmail,
} from "../../utils/emailVerification.util";
import toast from "../../utils/toast.util";

type VerificationStatus =
  | "waiting"
  | "verifying"
  | "verified"
  | "invalid"
  | "unreachable";

const readTokenFromHash = (): string | null => {
  const hash = window.location.hash;
  if (!hash) return null;
  return new URLSearchParams(hash.replace(/^#/, "")).get("token");
};

// Strips the secret from the address bar while preserving the Next.js router
// history entry. Overwriting it with null used to break every later in-app
// navigation and the back button.
const stripTokenFromUrl = () => {
  const cleanUrl = window.location.pathname + window.location.search;
  const state = window.history.state;
  const preservedState =
    state && typeof state === "object"
      ? { ...state, url: cleanUrl, as: cleanUrl }
      : state;
  window.history.replaceState(preservedState, "", cleanUrl);
};

const VerifyEmailPage = () => {
  const router = useRouter();
  const { locale } = useIntl();
  const { user: currentUser, refreshUser } = useUser();
  const french = locale.startsWith("fr");
  const [status, setStatus] = useState<VerificationStatus>("waiting");
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Read through refs so the hash listener below can stay registered once and
  // still see the session that finishes loading after the first render.
  const sessionRef = useRef({ currentUser, refreshUser });
  sessionRef.current = { currentUser, refreshUser };
  // A token is single-use: consuming the same one twice would turn a successful
  // verification into a spurious "invalid link". Tracking them individually
  // still lets a *different* token be consumed while the page stays mounted.
  const consumedTokens = useRef(new Set<string>());

  const consumeTokenFromHash = useCallback(() => {
    const token = readTokenFromHash();
    if (!token || consumedTokens.current.has(token)) return;
    consumedTokens.current.add(token);
    stripTokenFromUrl();

    setStatus("verifying");
    authService
      .verifyEmail(token)
      .then(() => {
        clearRememberedEmailVerificationEmail();
        setStatus("verified");
        if (sessionRef.current.currentUser) {
          void sessionRef.current.refreshUser({ refresh: false });
        }
      })
      .catch((error) => {
        // A request that never reached the server consumed nothing: release the
        // token so reopening the same link retries instead of burning it here,
        // and say so rather than blaming a link that may be perfectly valid.
        if (error?.response) {
          setStatus("invalid");
          return;
        }
        consumedTokens.current.delete(token);
        setStatus("unreachable");
      });
  }, []);

  useEffect(() => {
    setEmail(getRememberedEmailVerificationEmail());
    consumeTokenFromHash();

    // Opening the link while this page is already displayed is a same-document
    // navigation: nothing remounts, so the token has to be picked up from the
    // hash change itself. Next.js routes some of those through its own event
    // instead of the DOM one, hence both listeners.
    window.addEventListener("hashchange", consumeTokenFromHash);
    router.events.on("hashChangeComplete", consumeTokenFromHash);
    return () => {
      window.removeEventListener("hashchange", consumeTokenFromHash);
      router.events.off("hashChangeComplete", consumeTokenFromHash);
    };
  }, [consumeTokenFromHash, router.events]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = async () => {
    const normalized = email.trim();
    if (!normalized || cooldown > 0) return;
    setResending(true);
    rememberEmailVerificationEmail(normalized);
    try {
      const { accepted, retryAfterSeconds } =
        await authService.resendEmailVerification(normalized);
      setCooldown(retryAfterSeconds);
      if (accepted) {
        toast.success(
          french
            ? "Si ce compte nécessite une validation, un lien vient d’être envoyé. La remise peut prendre plusieurs minutes : pensez aux indésirables. Les liens déjà reçus restent valables."
            : "If this account requires verification, a link has just been sent. Delivery can take several minutes, so check your spam folder. Links you already received remain valid.",
        );
      } else {
        toast.error(
          french
            ? `Un lien a déjà été demandé il y a moins d’une minute. Attendez ${retryAfterSeconds} s avant d’en redemander un.`
            : `A link was already requested less than a minute ago. Wait ${retryAfterSeconds}s before requesting another one.`,
        );
      }
    } catch (error: any) {
      const statusCode = error?.response?.status;
      if (statusCode === 429) {
        setCooldown(60);
        toast.error(
          french
            ? "Trop de demandes d’envoi. Réessayez dans quelques minutes."
            : "Too many resend requests. Try again in a few minutes.",
        );
      } else if (statusCode === 503) {
        toast.error(
          french
            ? "L’envoi d’e-mails n’est pas configuré sur ce serveur. Contactez l’administrateur."
            : "Email delivery is not configured on this server. Contact the administrator.",
        );
      } else {
        toast.error(
          french
            ? "Impossible d’envoyer le message pour le moment."
            : "The message could not be sent right now.",
        );
      }
    } finally {
      setResending(false);
    }
  };

  const continueAfterVerification = async () => {
    if (!currentUser) {
      await router.replace("/auth/signIn");
      return;
    }
    const user = await refreshUser({ refresh: true });
    if (!user) {
      await router.replace("/auth/signIn");
      return;
    }
    await router.replace(user.isAdmin ? "/admin/intro" : "/account");
  };

  return (
    <>
      <Meta
        title={french ? "Vérification de l’e-mail" : "Email verification"}
        noIndex
      />
      <Head>
        <meta name="referrer" content="no-referrer" />
      </Head>
      <Container size={520} my={40}>
        <Title order={1} ta="center">
          {french ? "Vérifiez votre e-mail" : "Verify your email"}
        </Title>
        <Paper withBorder shadow="md" p="xl" mt="xl" radius="md">
          <Stack>
            {status === "verifying" && (
              <Group justify="center">
                <Loader size="sm" />
                <Text>{french ? "Validation en cours…" : "Verifying…"}</Text>
              </Group>
            )}
            {status === "verified" && (
              <>
                <Text c="green">
                  {french
                    ? "Votre adresse e-mail est vérifiée."
                    : "Your email address is verified."}
                </Text>
                <Button onClick={continueAfterVerification}>
                  {french ? "Continuer" : "Continue"}
                </Button>
              </>
            )}
            {status === "invalid" && (
              <Text c="red">
                {french
                  ? "Ce lien est invalide ou a expiré. Demandez-en un nouveau."
                  : "This link is invalid or expired. Request a new one."}
              </Text>
            )}
            {status === "unreachable" && (
              <Text c="red">
                {french
                  ? "La validation n’a pas pu aboutir : le serveur est injoignable. Rouvrez le lien depuis votre e-mail, il reste valable."
                  : "Verification could not complete: the server is unreachable. Reopen the link from your email, it is still valid."}
              </Text>
            )}
            {(status === "waiting" ||
              status === "invalid" ||
              status === "unreachable") && (
              <>
                <Text size="sm" c="dimmed">
                  {french
                    ? "Le renvoi ne prolonge pas les délais de 5 et 14 jours."
                    : "Resending does not extend the 5-day or 14-day deadlines."}
                </Text>
                <Text size="sm" c="dimmed">
                  {french
                    ? "La remise peut prendre plusieurs minutes. Chaque lien reçu reste valable 24 h, même après un renvoi."
                    : "Delivery can take several minutes. Every link you receive stays valid for 24h, even after a resend."}
                </Text>
                <TextInput
                  type="email"
                  label={french ? "Adresse e-mail" : "Email address"}
                  value={email}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  maxLength={254}
                />
                <Button
                  loading={resending}
                  disabled={!email.trim() || cooldown > 0}
                  onClick={resend}
                >
                  {cooldown > 0
                    ? french
                      ? `Renvoyer le lien (${cooldown} s)`
                      : `Resend link (${cooldown}s)`
                    : french
                      ? "Renvoyer le lien"
                      : "Resend link"}
                </Button>
              </>
            )}
          </Stack>
        </Paper>
      </Container>
    </>
  );
};

export default VerifyEmailPage;
