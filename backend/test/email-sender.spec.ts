import "reflect-metadata";
import assert from "node:assert/strict";
import { EmailService, MailSender } from "src/email/email.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("email sender");

const MAIN = {
  "smtp.enabled": true,
  "smtp.email": "signature@example.test",
  "smtp.host": "smtp.example.test",
  "smtp.port": 465,
  "smtp.username": "signature",
  "smtp.password": "main-secret",
  "general.appName": "PrivCloud",
};

function service(settings: Record<string, unknown> = {}) {
  const sent: {
    from: string;
    subject: string;
    host: string;
    port: number;
    user: string;
  }[] = [];
  const email = new EmailService({
    get: (key: string) => ({ ...MAIN, ...settings })[key as keyof typeof MAIN],
  } as never);
  Object.assign(email, {
    getTransporter(sender: MailSender) {
      const account = email["senderSettings"](sender);
      return {
        sendMail: async (mail: { from: string; subject: string }) => {
          sent.push({
            from: mail.from,
            subject: mail.subject,
            host: account.host,
            port: account.port,
            user: account.username,
          });
        },
      };
    },
  });
  return { email, sent };
}

testCase(
  "without a second account every mail leaves from the main one",
  async () => {
    const { email, sent } = service();
    await email.sendMail("a@example.test", "Verify your email", "text");
    await email.sendSigningMail("b@example.test", "Signature request", "text");
    assert.deepEqual(
      sent.map((mail) => mail.from),
      [
        '"PrivCloud" <signature@example.test>',
        '"PrivCloud" <signature@example.test>',
      ],
    );
  },
);

testCase(
  "with a second account, ordinary mails use it and signature mails never do",
  async () => {
    const { email, sent } = service({
      "smtp.generalEmail": "noreply@example.test",
      "smtp.generalHost": "mail.other.test",
      "smtp.generalPort": 587,
      "smtp.generalUsername": "noreply",
      "smtp.generalPassword": "general-secret",
    });
    await email.sendMail("a@example.test", "Verify your email", "text");
    await email.sendSigningMail("b@example.test", "Signature request", "text");
    assert.deepEqual(sent[0], {
      from: '"PrivCloud" <noreply@example.test>',
      subject: "Verify your email",
      host: "mail.other.test",
      port: 587,
      user: "noreply",
    });
    assert.deepEqual(sent[1], {
      from: '"PrivCloud" <signature@example.test>',
      subject: "Signature request",
      host: "smtp.example.test",
      port: 465,
      user: "signature",
    });
    assert.equal(email["senderSettings"]("general").password, "general-secret");
    assert.equal(email["senderSettings"]("signing").password, "main-secret");
  },
);

testCase(
  "a second mailbox on the same server only needs its address and login",
  async () => {
    const { email } = service({
      "smtp.generalEmail": "noreply@example.test",
      "smtp.generalPort": 0,
      "smtp.generalUsername": "",
    });
    const general = email["senderSettings"]("general");
    assert.equal(general.email, "noreply@example.test");
    assert.equal(general.host, "smtp.example.test");
    assert.equal(general.port, 465);
    // No login of its own: the main account sends it, from the second address.
    assert.equal(general.username, "signature");
    assert.equal(general.password, "main-secret");
  },
);

testCase("the admin test checks every configured account", async () => {
  const single = service();
  await single.email.sendTestMail("admin@example.test");
  assert.deepEqual(
    single.sent.map((mail) => mail.subject),
    ["Test email (signature account)"],
  );
  const both = service({ "smtp.generalEmail": "noreply@example.test" });
  await both.email.sendTestMail("admin@example.test");
  assert.deepEqual(
    both.sent.map((mail) => `${mail.subject} ${mail.from}`),
    [
      'Test email (signature account) "PrivCloud" <signature@example.test>',
      'Test email (general account) "PrivCloud" <noreply@example.test>',
    ],
  );
});

void run();
