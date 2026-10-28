import { Button, Container, Paper, Stack, Text, Title } from "@mantine/core";
import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import {
  EmailChangeAction,
  parseEmailChangeFragment,
} from "../../utils/emailChange.util";

export default function ChangeEmailPage() {
  const router = useRouter();
  const { locale } = useIntl();
  const { user, refreshUser } = useUser();
  const fr = locale.startsWith("fr");
  const [action, setAction] = useState<EmailChangeAction | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    const read = () => {
      if (!window.location.hash || submitting.current) return;
      const parsed = parseEmailChangeFragment(window.location.hash);
      const clean = window.location.pathname + window.location.search;
      const previous = window.history.state;
      window.history.replaceState(
        previous && typeof previous === "object"
          ? { ...previous, url: clean, as: clean }
          : previous,
        "",
        clean,
      );
      setAction(parsed);
      setMessage(
        parsed
          ? ""
          : fr
            ? "Lien invalide. Recommencez depuis votre compte."
            : "Invalid link. Start again from your account.",
      );
    };
    read();
    window.addEventListener("hashchange", read);
    router.events.on("hashChangeComplete", read);
    return () => {
      window.removeEventListener("hashchange", read);
      router.events.off("hashChangeComplete", read);
    };
  }, [router.events, fr]);

  const submit = async () => {
    if (!action || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (action.action === "cancel") {
        await authService.cancelEmailChange(action.token);
        setMessage(
          fr
            ? "La demande est annulée. Votre adresse n'a pas changé."
            : "Request cancelled. Your address has not changed.",
        );
      } else {
        const result = await authService.confirmEmailChange(action.token);
        setMessage(
          result.changed
            ? fr
              ? "Votre adresse a été modifiée. Utilisez-la pour vos prochaines connexions."
              : "Your address has changed. Use it for future sign-ins."
            : fr
              ? "Cette adresse est confirmée. Confirmez aussi le lien de l'autre boîte pour terminer."
              : "This address is confirmed. Confirm the other mailbox link to finish.",
        );
        if (result.changed && user)
          void refreshUser({ refresh: false }).catch(() => undefined);
      }
      setAction(null);
    } catch (failure: unknown) {
      const status = (failure as { response?: { status?: number } })?.response
        ?.status;
      if (status === 400 || status === 409) {
        setAction(null);
        setMessage(
          fr
            ? "Lien invalide, expiré ou déjà utilisé. Recommencez depuis votre compte."
            : "Invalid, expired or used link. Start again from your account.",
        );
      } else {
        setMessage(
          fr
            ? "Validation temporairement indisponible. Attendez puis réessayez. Si la demande a abouti, vérifiez votre compte."
            : "Confirmation temporarily unavailable. Wait and retry. If the request completed, check your account.",
        );
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Meta
        title={fr ? "Changement d'adresse e-mail" : "Email address change"}
        noIndex
      />
      <Head>
        <meta name="referrer" content="no-referrer" />
      </Head>
      <Container size={520} my={40}>
        <Paper withBorder p="xl">
          <Stack>
            <Title order={1}>
              {fr ? "Changement d'adresse e-mail" : "Email address change"}
            </Title>
            <Text role="status" aria-live="polite">
              {message ||
                (action
                  ? fr
                    ? "Confirmez uniquement un changement que vous avez demandé. Les deux boîtes doivent être confirmées."
                    : "Only confirm a change you requested. Both mailboxes must be confirmed."
                  : fr
                    ? "Ouvrez le lien reçu dans votre boîte e-mail."
                    : "Open the link from your mailbox.")}
            </Text>
            {action && (
              <Button
                loading={busy}
                color={action.action === "cancel" ? "red" : undefined}
                onClick={submit}
              >
                {action.action === "confirm"
                  ? fr
                    ? "Confirmer cette adresse"
                    : "Confirm this address"
                  : fr
                    ? "Annuler la demande"
                    : "Cancel request"}
              </Button>
            )}
            <Button component="a" href="/account" variant="subtle">
              {fr ? "Mon compte" : "My account"}
            </Button>
          </Stack>
        </Paper>
      </Container>
    </>
  );
}
