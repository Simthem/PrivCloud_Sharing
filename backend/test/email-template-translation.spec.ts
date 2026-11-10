import assert from "node:assert/strict";
import { EmailService } from "src/email/email.service";

function serviceWith(values: Record<string, string>) {
  const sent: { subject: string; text: string }[] = [];
  const config = {
    get: (key: string) => values[key],
  };
  const service = new EmailService(config as never);
  service.sendMail = async (_email: string, subject: string, text: string) => {
    sent.push({ subject, text });
  };
  return { service, sent };
}

const base = {
  "general.appUrl": "https://example.test",
  "email.resetPasswordSubject": "Réinitialisation",
  "email.resetPasswordMessage": "Lien : {url}",
};

async function run() {
  // no translation keeps a single language
  {
    const { service, sent } = serviceWith({
      ...base,
      "email.resetPasswordSubjectTranslation": "",
      "email.resetPasswordMessageTranslation": "  ",
    });

    await service.sendResetPasswordEmail("user@example.test", "token");

    assert.deepEqual(sent, [
      {
        subject: "Réinitialisation",
        text: "Lien : https://example.test/auth/resetPassword/token",
      },
    ]);
  }

  // a translation adds the second language and its placeholders
  {
    const { service, sent } = serviceWith({
      ...base,
      "email.resetPasswordSubjectTranslation": "Password reset",
      "email.resetPasswordMessageTranslation": "Link: {url}",
    });

    await service.sendResetPasswordEmail("user@example.test", "token");

    assert.deepEqual(sent, [
      {
        subject: "Réinitialisation / Password reset",
        text:
          "Lien : https://example.test/auth/resetPassword/token\n\n---\n\n" +
          "Link: https://example.test/auth/resetPassword/token",
      },
    ]);
  }
}

void run();
