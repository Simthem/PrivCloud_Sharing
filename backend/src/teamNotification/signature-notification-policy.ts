import { Prisma } from "@prisma/client";

// Membership only selects a compatible encrypted action, never eligibility.
export const SIGNATURE_PUSH_MEMBERSHIP = {
  isActive: true,
  role: { in: ["OWNER", "ADMIN", "MEMBER"] },
  team: { isActive: true },
} satisfies Prisma.TeamMemberWhereInput;

export const SIGNATURE_PUSH_FILTER = {
  OR: [
    { type: { notIn: ["SIGNATURE_REQUESTED", "SIGNATURE_COMPLETED"] } },
    { user: { signaturePushEnabled: true } },
  ],
} satisfies Prisma.TeamNotificationWhereInput;
