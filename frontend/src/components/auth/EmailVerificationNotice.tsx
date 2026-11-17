import { Alert, Button, Container, Group, Text } from "@mantine/core";
import Link from "next/link";
import { useIntl } from "react-intl";
import { CurrentUser } from "../../types/user.type";
import { rememberEmailVerificationEmail } from "../../utils/emailVerification.util";

const EmailVerificationNotice = ({ user }: { user: CurrentUser }) => {
  const { locale } = useIntl();
  const french = locale.startsWith("fr");
  const verifyButton = (
    <Button
      component={Link}
      href="/auth/verify-email"
      size="xs"
      variant="light"
      onClick={() => rememberEmailVerificationEmail(user.email)}
    >
      {french ? "Vérifier maintenant" : "Verify now"}
    </Button>
  );

  if (user.emailVerificationInvited) {
    return (
      <Container size="lg" mt="md">
        <Alert
          color="blue"
          title={
            french ? "Confirmez votre adresse e-mail" : "Confirm your email"
          }
        >
          <Group justify="space-between" align="center">
            <Text size="sm">
              {french
                ? "Un lien de confirmation a été envoyé à " +
                  user.email +
                  ". Votre accès reste entier en attendant."
                : "A confirmation link was sent to " +
                  user.email +
                  ". Your access stays complete in the meantime."}
            </Text>
            {verifyButton}
          </Group>
        </Alert>
      </Container>
    );
  }
  if (!user.emailVerificationRequired || user.emailVerified) return null;

  const blockedAt = user.emailVerificationBlockedAt
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(user.emailVerificationBlockedAt))
    : null;
  const deletionAt = user.emailVerificationDeletionAt
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(user.emailVerificationDeletionAt))
    : null;

  return (
    <Container size="lg" mt="md">
      <Alert
        color="orange"
        title={french ? "E-mail à vérifier" : "Verify your email"}
      >
        <Group justify="space-between" align="center">
          <Text size="sm">
            {french
              ? "Validez " +
                user.email +
                ". L'accès sera bloqué le " +
                blockedAt +
                " et le compte supprimé le " +
                deletionAt +
                "."
              : "Verify " +
                user.email +
                ". Access will be blocked on " +
                blockedAt +
                " and the account deleted on " +
                deletionAt +
                "."}
          </Text>
          {verifyButton}
        </Group>
      </Alert>
    </Container>
  );
};

export default EmailVerificationNotice;
