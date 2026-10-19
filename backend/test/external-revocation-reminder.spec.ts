import "reflect-metadata"
import assert from "node:assert/strict"
import { TeamExternalRevocationService } from "src/teamExternal/team-external-revocation.service"
import { TeamExternalAuditService } from "src/teamExternal/team-external-audit.service"
import { TeamExternalAdminController } from "src/teamExternal/team-external.controller"
import { METHOD_METADATA } from "@nestjs/common/constants"
import { RequestMethod } from "@nestjs/common"
import { createUnitTestRunner } from "./unit-test"

const { testCase, run } = createUnitTestRunner(
  "contractor revocation reminders",
)
const NOW = new Date("2026-10-13T18:00:00Z")
const admin = { id: "admin", email: "admin@example.test" } as never

function fixture(
  options: {
    mode?: string
    status?: string
    activeAdmin?: boolean
    expiresAt?: Date
    emailFails?: boolean
    claimLost?: boolean
  } = {},
) {
  const watch = {
    id: "watch",
    userId: "admin",
    seatId: "seat",
    mode: options.mode ?? "BOTH",
    notifiedAt: null as Date | null,
    user: { email: "admin@example.test" },
    seat: {
      id: "seat",
      teamId: "team",
      email: "contractor@example.test",
      status: options.status ?? "REVOKED",
      revokedAt: NOW,
      accessExpiresAt: options.expiresAt ?? new Date(NOW.getTime() - 1000),
    },
  }
  const emails: unknown[] = [],
    notifications: unknown[] = [],
    delivered: unknown[] = []
  const calls: { preference?: unknown; query?: unknown } = {}
  let failEmail = options.emailFails ?? false
  const tx = {
    $executeRaw: async () => 1,
    teamMember: {
      findFirst: async () =>
        options.activeAdmin === false ? null : { id: "member" },
    },
    teamExternalSeat: {
      findFirst: async (args: { where: { teamId: string; id: string } }) =>
        args.where.teamId === "team" && args.where.id === "seat"
          ? { id: "seat" }
          : null,
    },
    teamExternalRevocationWatch: {
      findUnique: async () => watch,
      findMany: async (args: unknown) => {
        calls.query = args
        return watch.notifiedAt || watch.mode === "NONE" ? [] : [watch]
      },
      upsert: async (args: { update: { mode: string } }) => {
        calls.preference = args
        watch.mode = args.update.mode
      },
      update: async (args: { data: { mode: string } }) => {
        watch.mode = args.data.mode
      },
      updateMany: async () => {
        if (watch.notifiedAt || options.claimLost) return { count: 0 }
        watch.notifiedAt = NOW
        return { count: 1 }
      },
    },
    teamNotification: {
      create: async (args: { data: unknown }) => {
        notifications.push(args.data)
        return {
          id: "notification",
          teamId: "team",
          userId: "admin",
          title: "generic",
        }
      },
    },
  }
  const prisma = {
    ...tx,
    $transaction: async (callback: (_tx: typeof tx) => Promise<unknown>) => {
      const previous = watch.notifiedAt
      try {
        return await callback(tx)
      } catch (error) {
        watch.notifiedAt = previous
        throw error
      }
    },
  }
  const makeService = () =>
    new TeamExternalRevocationService(
      prisma as never,
      { get: () => "https://share.example.test" } as never,
      {
        enqueue: async (_tx: unknown, message: unknown, key: string) => {
          if (failEmail) throw new Error("mail queue unavailable")
          emails.push({ message, key })
        },
        deliverPending: async () => undefined,
      } as never,
      {
        deliverExternalRevocationNotification: (notification: unknown) =>
          delivered.push(notification),
      } as never,
    )
  return {
    service: makeService(),
    makeService,
    watch,
    emails,
    notifications,
    delivered,
    calls,
    restoreEmail: () => {
      failEmail = false
    },
  }
}

testCase(
  "reminder choices belong to the authenticated administrator and the selected team's seat",
  async () => {
    const f = fixture()
    await f.service.setPreference("team", "seat", admin, "EMAIL")
    assert.deepEqual((f.calls.preference as { where: unknown }).where, {
      seatId_userId: { seatId: "seat", userId: "admin" },
    })
    await assert.rejects(
      f.service.setPreference("other-team", "seat", admin, "BOTH"),
    )
    await assert.rejects(
      f.service.setPreference("team", "seat", admin, "arbitrary" as never),
    )
    await assert.rejects(
      fixture({ activeAdmin: false }).service.setPreference(
        "team",
        "seat",
        admin,
        "BOTH",
      ),
    )
  },
)

testCase(
  "notification channels respect each explicit personal choice",
  async () => {
    for (const mode of ["NONE", "EMAIL", "PUSH", "BOTH"]) {
      const f = fixture({ mode })
      await f.service.notifyEndedAccess(undefined, undefined, NOW)
      assert.equal(f.emails.length, ["EMAIL", "BOTH"].includes(mode) ? 1 : 0)
      assert.equal(
        f.notifications.length,
        ["PUSH", "BOTH"].includes(mode) ? 1 : 0,
      )
      assert.equal(f.delivered.length, f.notifications.length)
      const visible = JSON.stringify(f.notifications)
      assert.ok(!visible.includes("contractor@example.test"))
      assert.ok(!visible.includes("admin@example.test"))
      assert.ok(!visible.includes("preuve.json"))
    }
  },
)

testCase(
  "automatic expiry and manual revocation produce reminders, never active future access",
  async () => {
    for (const status of ["REVOKED", "ACTIVE"]) {
      const f = fixture({ status })
      await f.service.notifyEndedAccess(undefined, undefined, NOW)
      assert.equal(f.emails.length, 1)
    }
    const active = fixture({
      status: "ACTIVE",
      expiresAt: new Date(NOW.getTime() + 1000),
    })
    await active.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(active.emails.length, 0)
    assert.equal(active.watch.notifiedAt, null)
  },
)

testCase(
  "a former administrator receives neither mail nor notification",
  async () => {
    const f = fixture({ activeAdmin: false })
    await f.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(f.emails.length, 0)
    assert.equal(f.notifications.length, 0)
    assert.equal(f.watch.mode, "NONE")
  },
)

testCase(
  "repeated workers and a lost claim cannot duplicate a reminder",
  async () => {
    const f = fixture()
    await Promise.all([
      f.service.notifyEndedAccess(undefined, undefined, NOW),
      f.makeService().notifyEndedAccess(undefined, undefined, NOW),
    ])
    await f.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(f.emails.length, 1)
    assert.equal(f.notifications.length, 1)
    const lost = fixture({ claimLost: true })
    await lost.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(lost.emails.length, 0)
    assert.equal(lost.notifications.length, 0)
  },
)

testCase(
  "queue failure leaves access revoked and the unclaimed reminder retryable",
  async () => {
    const f = fixture({ emailFails: true })
    await f.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(f.watch.seat.status, "REVOKED")
    assert.equal(f.watch.notifiedAt, null)
    assert.equal(f.notifications.length, 0)
    f.restoreEmail()
    await f.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(f.emails.length, 1)
  },
)

testCase(
  "changing a choice never resends a previously claimed ending",
  async () => {
    const f = fixture()
    await f.service.notifyEndedAccess(undefined, undefined, NOW)
    await f.service.setPreference("team", "seat", admin, "EMAIL")
    await f.service.notifyEndedAccess(undefined, undefined, NOW)
    assert.equal(f.emails.length, 1)
  },
)

testCase("certificates and archives have no GET session-only route", () => {
  for (const method of ["certificate", "evidence", "prepareDownload"] as const)
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        TeamExternalAdminController.prototype[method],
      ),
      RequestMethod.POST,
    )
})

testCase(
  "evidence download rechecks the administrator role after the passkey assertion",
  async () => {
    let allowed = true,
      downloads = 0
    const audit = new TeamExternalAuditService(
      {
        teamMember: {
          findFirst: async () => (allowed ? { id: "member" } : null),
        },
      } as never,
      {} as never,
      {} as never,
      {
        verifyTeamEvidence: async () => {
          allowed = false
        },
      } as never,
    )
    audit.certificateOf = async () => {
      downloads++
      return Buffer.from("secret")
    }
    await assert.rejects(audit.certificate("team", "copy", admin, {} as never))
    assert.equal(downloads, 0)
  },
)

void run()
