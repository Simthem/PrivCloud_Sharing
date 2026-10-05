import "reflect-metadata";
import assert from "node:assert/strict";
import { ValidationPipe } from "@nestjs/common";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSignatureRequestDTO } from "src/signing/dto/createSignatureRequest.dto";
import { collectValidationIssues } from "src/validation-error.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Signature request validation");
const payload = () => ({
  shareId: "test-share",
  fileId: "00000000-0000-4000-8000-000000000001",
  recipients: [
    { name: "Signer", email: "signer@example.test", role: "SIGNER" },
  ],
  fields: [
    {
      type: "SIGNATURE",
      page: 1,
      posX: 50,
      posY: 100,
      width: 120,
      height: 60,
      required: true,
      assignedRecipientEmail: "signer@example.test",
    },
  ],
  pageRotations: [{ page: 1, rotation: 90 }],
});

testCase(
  "the modal request survives nested transformation and whitelist validation",
  async () => {
    const request = await new ValidationPipe({
      whitelist: true,
      transform: true,
    }).transform(payload(), {
      type: "body",
      metatype: CreateSignatureRequestDTO,
    });
    assert.equal(request.recipients[0].email, "signer@example.test");
    assert.equal(request.fields[0].width, 120);
    assert.equal(request.pageRotations[0].rotation, 90);
  },
);

testCase(
  "recipient and field errors retain their full paths and constraint codes",
  async () => {
    const request = payload();
    request.recipients[0].email = "signer@example..test";
    request.fields[0].assignedRecipientEmail = "signer@example..test";
    const errors = await validate(
      plainToInstance(CreateSignatureRequestDTO, request),
    );
    const issues = collectValidationIssues(errors);
    assert.deepEqual(
      issues.map(({ property, codes }) => ({ property, codes })),
      [
        { property: "recipients.0.email", codes: ["isEmail"] },
        { property: "fields.0.assignedRecipientEmail", codes: ["isEmail"] },
      ],
    );
    const diagnostics = JSON.stringify(
      issues.map(({ property, codes }) => ({ property, codes })),
    );
    assert.ok(!diagnostics.includes("signer@example..test"));
    assert.ok(!diagnostics.includes('"target"'));
    assert.ok(!diagnostics.includes('"value"'));
    assert.ok(issues.flatMap(({ messages }) => messages).length > 0);
  },
);

testCase(
  "malformed nested values still fail instead of weakening signing validation",
  async () => {
    const request = {
      ...payload(),
      fields: [{ ...payload().fields[0], width: 0, posX: -1 }],
    };
    const issues = collectValidationIssues(
      await validate(plainToInstance(CreateSignatureRequestDTO, request)),
    );
    assert.ok(
      issues.some(
        ({ property, codes }) =>
          property === "fields.0.width" && codes.includes("min"),
      ),
    );
    assert.ok(
      issues.some(
        ({ property, codes }) =>
          property === "fields.0.posX" && codes.includes("min"),
      ),
    );
  },
);

testCase(
  "deeper validation trees include all failures without submitted secrets",
  async () => {
    const issues = collectValidationIssues([
      {
        property: "recipients",
        target: { e2eKey: "secret" },
        value: "secret",
        children: [
          {
            property: "0",
            children: [
              {
                property: "contact",
                children: [
                  {
                    property: "email",
                    value: "secret",
                    constraints: { isEmail: "email must be an email" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(issues[0].property, "recipients.0.contact.email");
    assert.ok(!JSON.stringify(issues).includes("secret"));
  },
);

run();
