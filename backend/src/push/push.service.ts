import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as webpush from "web-push";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private ready = false;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.configure();
    this.config.on("update", (key: string) => {
      if (key.startsWith("pushNotifications.")) this.configure();
    });
  }

  private configure() {
    if (!this.config.get("pushNotifications.enabled")) {
      this.ready = false;
      return;
    }
    const publicKey = this.config.get("pushNotifications.vapidPublicKey");
    const privateKey = this.config.get("pushNotifications.vapidPrivateKey");
    const subject = this.config.get("pushNotifications.vapidSubject");
    if (!publicKey || !privateKey || !subject) {
      this.logger.warn(
        "Push notifications enabled but VAPID keys or subject not configured",
      );
      this.ready = false;
      return;
    }
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.ready = true;
      this.logger.log("VAPID configured - push notifications ready");
    } catch (e) {
      this.logger.error("Failed to configure VAPID", (e as Error).message);
      this.ready = false;
    }
  }

  async subscribe(
    userId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
  ) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { p256dh, auth, userId },
      create: { endpoint, p256dh, auth, userId },
    });
  }

  async unsubscribe(userId: string, endpoint: string) {
    return this.prisma.pushSubscription.deleteMany({
      where: { endpoint, userId },
    });
  }

  /**
   * Send a push notification to all subscriptions of a given user.
   */
  async sendToUser(
    userId: string,
    payload: { title: string; body: string; url?: string },
  ) {
    if (!this.ready) return;

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });

    const data = JSON.stringify(payload);

    // Send to all subscriptions in parallel for faster delivery
    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            data,
            {
              urgency: "high",
              TTL: 86400,
              timeout: 10000, // 10s max per push endpoint
            },
          );
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          const errCode = (err as { code?: string }).code;
          if (statusCode === 410 || statusCode === 404) {
            await this.prisma.pushSubscription.delete({
              where: { id: sub.id },
            });
            this.logger.debug(
              `Removed stale push subscription: ${sub.endpoint}`,
            );
          } else if (
            errCode === "EPROTO" ||
            errCode === "ECONNREFUSED" ||
            errCode === "ECONNRESET" ||
            errCode === "ETIMEDOUT" ||
            errCode === "ERR_SSL_WRONG_VERSION_NUMBER"
          ) {
            await this.prisma.pushSubscription.delete({
              where: { id: sub.id },
            });
            this.logger.warn(
              `Removed unreachable push subscription (${errCode}): ${sub.endpoint}`,
            );
          } else {
            this.logger.error(
              `Push failed for ${sub.endpoint}: ${(err as Error).message}`,
            );
          }
        }
      }),
    );
  }
}
