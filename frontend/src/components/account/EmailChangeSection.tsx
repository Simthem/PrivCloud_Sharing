import {
  Alert,
  Button,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";

export default function EmailChangeSection() {
  const { user } = useUser();
  const { locale } = useIntl();
  const fr = locale.startsWith("fr");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  if (!user || user.isLdap) return null;

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending) return;
        setSending(true);
        setError("");
        setNotice("");
        try {
          const result = await authService.requestEmailChange({
            email: email.trim(),
            ...(password ? { password } : {}),
            ...(code ? { code } : {}),
          });
          setNotice(
            result.currentAddressApproval === false
              ? fr
                ? "Demande enregistrée. Votre adresse actuelle n'a jamais été confirmée : seule la nouvelle boîte doit valider le lien, sous 30 minutes."
                : "Request saved. Your current address was never confirmed: only the new mailbox has to confirm the link, within 30 minutes."
              : fr
                ? "Demande enregistrée. Confirmez les liens des deux boîtes sous 30 minutes. L'ancienne adresse reste active jusque-là et peut annuler la demande."
                : "Request saved. Confirm both mailbox links within 30 minutes. The old address stays active until then and can cancel the request.",
          );
        } catch (failure: unknown) {
          const status = (failure as { response?: { status?: number } })
            ?.response?.status;
          setError(
            status === 503
              ? fr
                ? "L'envoi d'e-mails est indisponible. Contactez un administrateur."
                : "Email delivery is unavailable. Contact an administrator."
              : status === 429
                ? fr
                  ? "Trop de demandes. Attendez avant de réessayer."
                  : "Too many requests. Wait before retrying."
                : fr
                  ? "Demande impossible. Vérifiez l'adresse, votre mot de passe et votre code de sécurité, puis réessayez."
                  : "Request failed. Check the address, password and security code, then retry.",
          );
        } finally {
          setPassword("");
          setCode("");
          setSending(false);
        }
      }}
    >
      <Stack mt="lg">
        <Title order={5}>
          {fr ? "Changer d'adresse e-mail" : "Change email address"}
        </Title>
        <Text size="sm">
          {fr
            ? "Vous devez pouvoir ouvrir votre boîte actuelle et la nouvelle. Le changement n'affecte pas vos fichiers chiffrés ni vos passkeys."
            : "You need access to your current and new mailboxes. Changing the address does not change encrypted files or passkeys."}
        </Text>
        <TextInput
          label={fr ? "Nouvelle adresse e-mail" : "New email address"}
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          disabled={sending}
        />
        {user.hasPassword && (
          <PasswordInput
            label={fr ? "Mot de passe actuel" : "Current password"}
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            disabled={sending}
          />
        )}
        {user.totpVerified && (
          <TextInput
            label={
              fr ? "Code de sécurité ou de secours" : "Security or backup code"
            }
            autoComplete="one-time-code"
            required
            maxLength={16}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            disabled={sending}
          />
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {notice && (
          <Text role="status" aria-live="polite">
            {notice}
          </Text>
        )}
        <Button type="submit" loading={sending}>
          {fr ? "Demander le changement" : "Request change"}
        </Button>
      </Stack>
    </form>
  );
}
