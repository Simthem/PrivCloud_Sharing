import { Prisma, PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

export const configVariables = {
  internal: {
    jwtSecret: {
      type: "string",
      value: crypto.randomBytes(256).toString("base64"),
      locked: true,
    },
  },
  general: {
    appName: {
      type: "string",
      defaultValue: "PrivCloud_Sharing",
      secret: false,
    },
    appUrl: {
      type: "string",
      defaultValue: "http://localhost:3000",
      secret: false,
    },
    secureCookies: {
      type: "boolean",
      defaultValue: "false",
    },
    showHomePage: {
      type: "boolean",
      defaultValue: "true",
      secret: false,
    },
    metaDescriptionEn: {
      type: "string",
      defaultValue: "The secure alternative to WeTransfer. Send files with end-to-end encryption and zero-knowledge privacy. No account required. Open-source and GDPR-compliant.",
      secret: false,
    },
    metaDescriptionFr: {
      type: "string",
      defaultValue: "L'alternative sécurisée à WeTransfer. Envoyez vos fichiers avec un chiffrement de bout en bout et une confidentialité zéro connaissance. Aucun compte requis. Open-source et conforme au RGPD.",
      secret: false,
    },
    colorPalette: {
      type: "string",
      defaultValue: "victoria",
      secret: false,
    },
    sessionDuration: {
      type: "timespan",
      defaultValue: "3 months",
      secret: false,
    },
    maintenanceMode: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    maintenanceMessage: {
      type: "text",
      defaultValue:
        "We are currently performing scheduled maintenance. File uploads are temporarily unavailable. Please try again later.",
      secret: false,
    },
    maintenanceAllowedEmails: {
      type: "text",
      defaultValue: "",
      secret: false,
    },
  },
  share: {
    allowRegistration: {
      type: "boolean",
      defaultValue: "true",
      secret: false,
    },
    allowUnauthenticatedShares: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    anonymousMaxExpiration: {
      type: "timespan",
      defaultValue: "5 days",
      secret: false,
    },
    maxExpiration: {
      type: "timespan",
      defaultValue: "0 days",
      secret: false,
    },
    shareIdLength: {
      type: "number",
      defaultValue: "8",
      secret: false,
    },
    maxSize: {
      type: "filesize",
      defaultValue: "1000000000",
      secret: false,
    },
    zipCompressionLevel: {
      type: "number",
      defaultValue: "9",
    },
    chunkSize: {
      type: "filesize",
      defaultValue: "10000000",
      secret: false,
    },
    autoOpenShareModal: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    allowAdminAccessAllShares: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
  },
  cache: {
    "redis-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "redis-url": {
      type: "string",
      defaultValue: "redis://privcloud-redis:6379",
      secret: true,
    },
    ttl: {
      type: "number",
      defaultValue: "60",
    },
    maxItems: {
      type: "number",
      defaultValue: "1000",
    },
  },
  email: {
    enableShareEmailRecipients: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    enableShareEmailPastRecipients: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
      experimental: true,
    },
    enableE2EKeyEmailSharing: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    replyToEmail: {
      type: "string",
      secret: false,
    },
    senderName: {
      type: "string",
      secret: false,
    },
    shareRecipientsSubject: {
      type: "string",
      defaultValue: "Files shared with you",
    },
    shareRecipientsMessage: {
      type: "text",
      defaultValue:
        "Hey!\n\n{creator} ({creatorEmail}) shared some files with you.\n\nTitle: {name}\nDescription: {desc}\n\nYou can view or download the files with this link: {shareUrl}\n\nThe share will expire {expires}.\n\nShared securely with PrivCloud_Sharing 🔒",
    },
    reverseShareSubject: {
      type: "string",
      defaultValue: "Reverse share link used",
    },
    reverseShareMessage: {
      type: "text",
      defaultValue:
        "Hey!\n\nA share was just created with your reverse share link: {shareUrl}\n\nShared securely with PrivCloud_Sharing 🔒",
    },
    resetPasswordSubject: {
      type: "string",
      defaultValue: "PrivCloud_Sharing password reset",
    },
    resetPasswordMessage: {
      type: "text",
      defaultValue:
        "Hey!\n\nYou requested a password reset. Click this link to reset your password: {url}\nThe link expires in an hour.\n\nPrivCloud_Sharing 🔒",
    },
    inviteSubject: {
      type: "string",
      defaultValue: "PrivCloud_Sharing invite",
    },
    inviteMessage: {
      type: "text",
      defaultValue:
        'Hey!\n\nYou were invited to PrivCloud_Sharing. Click this link to accept the invite: {url}\n\nYou can use the email "{email}" and the password "{password}" to sign in.\n\nPrivCloud_Sharing 🔒',
    },
    downloadNotificationSubject: {
      type: "string",
      defaultValue: "Votre partage a été téléchargé",
    },
    downloadNotificationMessage: {
      type: "text",
      defaultValue:
        "Bonjour,\n\nVotre partage \"{shareName}\" a été téléchargé le {date}.\n\nConsulter votre partage : {shareUrl}\n\nPrivCloud_Sharing 🔒",
    },
    downloadDigestSubject: {
      type: "string",
      defaultValue: "Résumé des téléchargements de vos partages",
    },
    downloadDigestMessage: {
      type: "text",
      defaultValue:
        "Bonjour,\n\nVoici un résumé des téléchargements récents :\n\n{digest}\n\nPrivCloud_Sharing 🔒",
    },
    downloadWeeklySubject: {
      type: "string",
      defaultValue: "Résumé hebdomadaire des téléchargements",
    },
    downloadWeeklyMessage: {
      type: "text",
      defaultValue:
        "Bonjour,\n\nVoici votre résumé hebdomadaire des téléchargements :\n\n{digest}\n\nPrivCloud_Sharing 🔒",
    },
    teamShareNotificationSubject: {
      type: "string",
      defaultValue: "New team share",
    },
    teamShareNotificationMessage: {
      type: "text",
      defaultValue:
        "Hello,\n\nYou received a new encrypted share in {teamName}.\n\nSign in to access it: {appUrl}\n\nPrivCloud_Sharing",
    },
  },
  smtp: {
    enabled: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    allowUnauthorizedCertificates: {
      type: "boolean",
      defaultValue: "false",

      secret: false,
    },
    host: {
      type: "string",
      defaultValue: "",
    },
    port: {
      type: "number",
      defaultValue: "0",
    },
    email: {
      type: "string",
      defaultValue: "",
    },
    username: {
      type: "string",
      defaultValue: "",
    },
    password: {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
  },
  ldap: {
    enabled: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },

    url: {
      type: "string",
      defaultValue: "",
    },

    bindDn: {
      type: "string",
      defaultValue: "",
    },
    bindPassword: {
      type: "string",
      defaultValue: "",
      obscured: true,
    },

    searchBase: {
      type: "string",
      defaultValue: "",
    },
    searchQuery: {
      type: "string",
      defaultValue: "",
    },

    adminGroups: {
      type: "string",
      defaultValue: "",
    },

    fieldNameMemberOf: {
      type: "string",
      defaultValue: "memberOf",
    },
    fieldNameEmail: {
      type: "string",
      defaultValue: "userPrincipalName",
    },
  },
  oauth: {
    allowRegistration: {
      type: "boolean",
      defaultValue: "true",
    },
    ignoreTotp: {
      type: "boolean",
      defaultValue: "true",
    },
    disablePassword: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    "github-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "github-clientId": {
      type: "string",
      defaultValue: "",
    },
    "github-clientSecret": {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
    "google-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "google-clientId": {
      type: "string",
      defaultValue: "",
    },
    "google-clientSecret": {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
    "microsoft-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "microsoft-tenant": {
      type: "string",
      defaultValue: "common",
    },
    "microsoft-clientId": {
      type: "string",
      defaultValue: "",
    },
    "microsoft-clientSecret": {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
    "discord-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "discord-limitedGuild": {
      type: "string",
      defaultValue: "",
    },
    "discord-limitedUsers": {
      type: "string",
      defaultValue: "",
    },
    "discord-clientId": {
      type: "string",
      defaultValue: "",
    },
    "discord-clientSecret": {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
    "oidc-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "oidc-discoveryUri": {
      type: "string",
      defaultValue: "",
    },
    "oidc-signOut": {
      type: "boolean",
      defaultValue: "false",
    },
    "oidc-scope": {
      type: "string",
      defaultValue: "openid email profile",
    },
    "oidc-usernameClaim": {
      type: "string",
      defaultValue: "",
    },
    "oidc-rolePath": {
      type: "string",
      defaultValue: "",
    },
    "oidc-roleGeneralAccess": {
      type: "string",
      defaultValue: "",
    },
    "oidc-roleAdminAccess": {
      type: "string",
      defaultValue: "",
    },
    "oidc-clientId": {
      type: "string",
      defaultValue: "",
    },
    "oidc-clientSecret": {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
  },
  s3: {
    enabled: {
      type: "boolean",
      defaultValue: "false",
    },
    endpoint: {
      type: "string",
      defaultValue: "",
    },
    region: {
      type: "string",
      defaultValue: "",
    },
    bucketName: {
      type: "string",
      defaultValue: "",
    },
    bucketPath: {
      type: "string",
      defaultValue: "",
    },
    key: {
      type: "string",
      defaultValue: "",
      secret: true,
    },
    secret: {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
    useChecksum: {
      type: "boolean",
      defaultValue: "true",
    },
  },
  legal: {
    enabled: {
      type: "boolean",
      defaultValue: "true",
      secret: false,
    },
    imprintText: {
      type: "text",
      defaultValue:
        "# Legal Notice\n\n" +
        "## Service Operator\n\n" +
        "**Instance Operator**  \n" +
        "Cybersecurity Expert - System & Network Architecture  \n" +
        "Contact: [admin@example.com](mailto:admin@example.com)  \n" +
        "Website: [example.com](https://example.com)\n\n" +
        "## About This Service\n\n" +
        "PrivCloud\\_Sharing is a self-hosted file sharing platform operated by the configured instance administrator. " +
        "This instance is hosted on a dedicated infrastructure located in the European Union, " +
        "managed in compliance with EU data protection regulations.\n\n" +
        "## Intellectual Property\n\n" +
        "PrivCloud\\_Sharing is an open-source project released under the BSD 2-Clause license. " +
        "The source code is available at [github.com/Simthem/PrivCloud\\_Sharing](https://github.com/Simthem/PrivCloud_Sharing). " +
        "Review branding and logo rights before publishing a public instance.\n\n" +
        "## Hosting Provider\n\n" +
        "Your hosting provider  \n" +
        "Your hosting provider address  \n" +
        "[provider.example.com](https://provider.example.com)\n\n" +
        "## Applicable Law\n\n" +
        "This service is governed by the laws of France and the European Union. " +
        "Any disputes shall be submitted to the competent courts of Lyon, France.\n\n" +
        "## Regulatory Compliance\n\n" +
        "This infrastructure is operated in accordance with:\n\n" +
        "- **GDPR** (EU 2016/679) - General Data Protection Regulation\n" +
        "- **NIS2** (EU 2022/2555) - Network and Information Security Directive\n" +
        "- **ISO 27001:2022** - Information Security Management (best practices)\n\n" +
        "## Contact\n\n" +
        "For any legal inquiry or to exercise your data protection rights, please contact: " +
        "[admin@example.com](mailto:admin@example.com)",
      secret: false,
    },
    imprintUrl: {
      type: "string",
      defaultValue: "",
      secret: false,
    },
    metaDescriptionImprint: {
      type: "string",
      defaultValue:
        "Legal notice for PrivCloud: service operator, hosting provider, GDPR and NIS2 compliance, applicable law.",
      secret: false,
    },
    privacyPolicyText: {
      type: "text",
      defaultValue:
        "# Privacy Policy\n\n" +
        "*Last updated: March 2026*\n\n" +
        "## 1. Data Controller\n\n" +
        "**Instance Operator**  \n" +
        "Contact: [admin@example.com](mailto:admin@example.com)  \n" +
        "Website: [example.com](https://example.com)\n\n" +
        "## 2. Data We Collect\n\n" +
        "When you use PrivCloud\\_Sharing, we may collect:\n\n" +
        "| Data | Purpose | Retention |\n" +
        "|---|---|---|\n" +
        "| Email address | Account creation, notifications | Until account deletion |\n" +
        "| Username | Authentication, display | Until account deletion |\n" +
        "| IP address | Security logs, abuse prevention | 90 days |\n" +
        "| Uploaded files | File sharing (core service) | Until share expiration or manual deletion |\n" +
        "| Browser user-agent | Security monitoring | 90 days |\n\n" +
        "## 3. How We Use Your Data\n\n" +
        "Your data is processed exclusively to provide the file sharing service. We do **not**:\n\n" +
        "- Sell or share your data with third parties\n" +
        "- Use your data for advertising or profiling\n" +
        "- Transfer your data outside the European Union\n" +
        "- Access the content of your shared files\n\n" +
        "When end-to-end encryption (E2E) is enabled, the encryption key exists only in the share URL fragment and is **never** transmitted to the server. " +
        "We have zero knowledge of the file contents.\n\n" +
        "## 4. Legal Basis (GDPR Art. 6)\n\n" +
        "- **Consent** (Art. 6(1)(a)): Account creation\n" +
        "- **Contract performance** (Art. 6(1)(b)): Providing the file sharing service\n" +
        "- **Legitimate interest** (Art. 6(1)(f)): Security monitoring, abuse prevention\n\n" +
        "## 5. Data Security\n\n" +
        "We implement industry-standard security measures including:\n\n" +
        "- TLS 1.3 encryption for all connections\n" +
        "- AES-256-GCM end-to-end encryption (optional, per share)\n" +
        "- Hardened infrastructure (CIS benchmarks, regular vulnerability scanning)\n" +
        "- Intrusion detection and monitoring (Wazuh, Zabbix)\n" +
        "- Automated backups with Restic (encrypted, off-site)\n" +
        "- Compliance with NIS2 (EU 2022/2555) and ISO 27001:2022 best practices\n\n" +
        "## 6. Your Rights (GDPR Art. 15-22)\n\n" +
        "You have the right to:\n\n" +
        "- **Access** your personal data\n" +
        "- **Rectify** inaccurate data\n" +
        "- **Erase** your data (\"right to be forgotten\")\n" +
        "- **Restrict** processing\n" +
        "- **Data portability** (receive your data in a structured format)\n" +
        "- **Object** to processing\n" +
        "- **Lodge a complaint** with the French DPA (CNIL): [www.cnil.fr](https://www.cnil.fr)\n\n" +
        "To exercise your rights, contact: [admin@example.com](mailto:admin@example.com)\n\n" +
        "## 7. Cookies\n\n" +
        "PrivCloud\\_Sharing uses only **strictly necessary cookies** for authentication and session management. " +
        "No tracking cookies, analytics, or third-party cookies are used.\n\n" +
        "## 8. Data Breach Notification\n\n" +
        "In the event of a personal data breach, we will notify the CNIL within 72 hours " +
        "and affected users without undue delay, as required by GDPR Art. 33-34.\n\n" +
        "## 9. Changes to This Policy\n\n" +
        "We may update this privacy policy from time to time. The latest version is always " +
        "available on this page with the \"Last updated\" date.",
      secret: false,
    },
    privacyPolicyUrl: {
      type: "string",
      defaultValue: "",
      secret: false,
    },
    metaDescriptionPrivacy: {
      type: "string",
      defaultValue:
        "PrivCloud Privacy Policy: data collected, GDPR legal basis, end-to-end encryption, user rights and DPO contact.",
      secret: false,
    },
  },
  pushNotifications: {
    enabled: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    vapidSubject: {
      type: "string",
      defaultValue: "",
      secret: false,
    },
    vapidPublicKey: {
      type: "string",
      defaultValue: "",
      secret: false,
    },
    vapidPrivateKey: {
      type: "string",
      defaultValue: "",
      secret: true,
      obscured: true,
    },
  },
  hcaptcha: {
    enabled: {
      type: "boolean",
      defaultValue: "false",
      secret: false,
    },
    siteKey: {
      type: "string",
      defaultValue: "",
      secret: false,
    },
    secretKey: {
      type: "string",
      defaultValue: "",
      secret: true,
      obscured: true,
    },
  },
  signing: {
    enabled: {
      type: "boolean",
      defaultValue: "true",
      secret: false,
    },
    certificatePath: {
      type: "string",
      defaultValue: "",
      secret: true,
    },
    certificatePassword: {
      type: "string",
      defaultValue: "",
      secret: true,
      obscured: true,
    },
    tsaUrl: {
      type: "string",
      defaultValue: "http://timestamp.digicert.com",
      secret: false,
    },
    defaultLevel: {
      type: "string",
      defaultValue: "AES",
      secret: false,
    },
  },
  team: {
    enabled: {
      type: "boolean",
      defaultValue: "true",
      secret: false,
    },
    maxTeamsPerUser: {
      type: "number",
      defaultValue: "5",
      secret: false,
    },
    basePrice: {
      type: "number",
      defaultValue: "1799",
      secret: false,
    },
    extraMemberPrice: {
      type: "number",
      defaultValue: "499",
      secret: false,
    },
  },
} satisfies ConfigVariables;

export type YamlConfig = {
  [Category in keyof typeof configVariables]: {
    [Key in keyof (typeof configVariables)[Category]]: string;
  };
} & {
  initUser: {
    enabled: string;
    username: string;
    email: string;
    password: string;
    isAdmin: boolean;
    ldapDN: string;
  };
};

type ConfigVariables = {
  [category: string]: {
    [variable: string]: Omit<
      Prisma.ConfigCreateInput,
      "name" | "category" | "order"
    >;
  };
};

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import * as path from "path";

// Prisma CLI resolves file: URLs relative to schema.prisma directory,
// but better-sqlite3 resolves relative to CWD. We must match Prisma's
// resolution so the adapter opens the same DB that 'migrate deploy' created.
function resolveDbUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const raw = url.slice(5);
  const filePath = raw.split("?")[0];
  if (path.isAbsolute(filePath)) return url;
  const schemaDir = path.join(process.cwd(), "prisma");
  return path.resolve(schemaDir, filePath);
}

const dbUrl = process.env.DATABASE_URL || "file:../data/pingvin-share.db?connection_limit=1";
const resolvedDbPath = resolveDbUrl(dbUrl);
console.log(`[seed] DB path: ${resolvedDbPath}  (cwd: ${process.cwd()})`);
const adapter = new PrismaBetterSqlite3({
  url: resolvedDbPath,
});
const prisma = new PrismaClient({ adapter });

async function seedConfigVariables() {
  for (const [category, configVariablesOfCategory] of Object.entries(
    configVariables,
  )) {
    let order = 0;
    for (const [name, properties] of Object.entries(
      configVariablesOfCategory,
    )) {
      const existingConfigVariable = await prisma.config.findUnique({
        where: { name_category: { name, category } },
      });

      // Create a new config variable if it doesn't exist
      if (!existingConfigVariable) {
        await prisma.config.create({
          data: {
            order,
            name,
            ...properties,
            category,
          },
        });
      }
      order++;
    }
  }
}

async function migrateConfigVariables() {
  const existingConfigVariables = await prisma.config.findMany();
  const orderMap: { [category: string]: number } = {};

  for (const existingConfigVariable of existingConfigVariables) {
    const configVariable =
      configVariables[existingConfigVariable.category]?.[
        existingConfigVariable.name
      ];

    // Delete the config variable if it doesn't exist in the seed
    if (!configVariable) {
      await prisma.config.delete({
        where: {
          name_category: {
            name: existingConfigVariable.name,
            category: existingConfigVariable.category,
          },
        },
      });

      // Update the config variable if it exists in the seed
    } else {
      const variableOrder = Object.keys(
        configVariables[existingConfigVariable.category],
      ).indexOf(existingConfigVariable.name);
      await prisma.config.update({
        where: {
          name_category: {
            name: existingConfigVariable.name,
            category: existingConfigVariable.category,
          },
        },
        data: {
          ...configVariable,
          name: existingConfigVariable.name,
          category: existingConfigVariable.category,
          value: existingConfigVariable.value,
          order: variableOrder,
        },
      });
      orderMap[existingConfigVariable.category] = variableOrder + 1;
    }
  }
}

seedConfigVariables()
  .then(() => migrateConfigVariables())
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
