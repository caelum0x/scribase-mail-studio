import type { ProviderSetting } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger/log";
import { getProviderRegion } from "../provider";
import { EmailQueueService } from "./email-queue-service";

export const DEFAULT_SEND_RATE_LIMIT = 1;
export const DEFAULT_TRANSACTIONAL_QUOTA = 50;

/**
 * Sending settings (rate limit + transactional share) for the email provider.
 * A row for the configured provider region is created automatically, so a
 * fresh install can send without any admin setup.
 */
export class ProviderSettingsService {
  static async ensureDefaultSetting(
    region: string = getProviderRegion(),
  ): Promise<ProviderSetting> {
    return db.providerSetting.upsert({
      where: { region },
      create: {
        region,
        provider: "oci",
        sendRateLimit: DEFAULT_SEND_RATE_LIMIT,
        transactionalQuota: DEFAULT_TRANSACTIONAL_QUOTA,
      },
      update: {},
    });
  }

  static async getSetting(
    region: string = getProviderRegion(),
  ): Promise<ProviderSetting> {
    const existing = await db.providerSetting.findUnique({ where: { region } });
    return existing ?? this.ensureDefaultSetting(region);
  }

  static async getAllSettings(): Promise<ProviderSetting[]> {
    await this.ensureDefaultSetting();
    return db.providerSetting.findMany({ orderBy: { createdAt: "asc" } });
  }

  static async getAvailableRegions(): Promise<string[]> {
    const settings = await this.getAllSettings();
    return [...new Set(settings.map((setting) => setting.region))];
  }

  static async updateSetting({
    id,
    sendRateLimit,
    transactionalQuota,
  }: {
    id: string;
    sendRateLimit: number;
    transactionalQuota: number;
  }): Promise<ProviderSetting> {
    const setting = await db.providerSetting.update({
      where: { id },
      data: { sendRateLimit, transactionalQuota },
    });

    EmailQueueService.initializeQueue(
      setting.region,
      setting.sendRateLimit,
      setting.transactionalQuota,
    );

    logger.info(
      {
        region: setting.region,
        sendRateLimit: setting.sendRateLimit,
        transactionalQuota: setting.transactionalQuota,
      },
      "[ProviderSettingsService]: Sending settings updated",
    );

    return setting;
  }
}
