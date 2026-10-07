import type {
  models as loggingModels,
  requests as loggingRequests,
  responses as loggingResponses,
} from "oci-logging";
import type {
  requests as searchRequests,
  responses as searchResponses,
} from "oci-loggingsearch";
import { createHash } from "crypto";
import { logger } from "~/server/logger/log";
import type {
  ProviderDeliveryAction,
  ProviderDeliveryEvent,
  ProviderDeliveryEventPage,
  ProviderDeliveryLogsResult,
} from "../types";
import { stripAngleBrackets } from "./mappers";

/*
 * OCI Email Delivery service logs (verified 2026-10-07 against
 * docs.oracle.com Email/Reference/log-guide.htm,
 * Logging/Reference/details_for_emaildelivery.htm and the live
 * Logging ListServices API):
 *   service  = "emaildelivery"
 *   resource = email domain OCID (resource type "emaildomain")
 *   category = "outboundaccepted" | "outboundrelayed"
 *   record type = com.oraclecloud.emaildelivery.emaildomain.<category>
 */
export const EMAIL_DELIVERY_LOG_SERVICE = "emaildelivery";
export const DELIVERY_LOG_CATEGORIES = [
  "outboundrelayed",
  "outboundaccepted",
] as const;
export const OUTBOUND_RELAYED_TYPE =
  "com.oraclecloud.emaildelivery.emaildomain.outboundrelayed";
export const DEFAULT_LOG_GROUP_NAME = "scribase-mail";

const SEARCH_PAGE_LIMIT = 1000;
const SEARCH_MAX_PAGES = 20;
const LIST_PAGE_LIMIT = 100;
const ENSURED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const KNOWN_ACTIONS = new Set<ProviderDeliveryAction>([
  "relay",
  "bounce",
  "complaint",
  "open",
  "click",
  "unsubscribe",
]);

/* eslint-disable no-unused-vars -- parameter names in type signatures */
/** Subset of the OCI LoggingManagementClient used here (eases mocking). */
export type OciLoggingApi = {
  listLogGroups(
    req: loggingRequests.ListLogGroupsRequest,
  ): Promise<Pick<loggingResponses.ListLogGroupsResponse, "items">>;
  createLogGroup(req: loggingRequests.CreateLogGroupRequest): Promise<unknown>;
  listLogs(
    req: loggingRequests.ListLogsRequest,
  ): Promise<
    Pick<loggingResponses.ListLogsResponse, "items"> & { opcNextPage?: string }
  >;
  createLog(req: loggingRequests.CreateLogRequest): Promise<unknown>;
};

/** Subset of the OCI LogSearchClient used here. */
export type OciLogSearchApi = {
  searchLogs(req: searchRequests.SearchLogsRequest): Promise<
    Pick<searchResponses.SearchLogsResponse, "searchResponse"> & {
      opcNextPage?: string;
    }
  >;
};
/* eslint-enable no-unused-vars */

export type OciDeliveryLogsDeps = {
  compartmentId: string | undefined;
  logGroupName?: string;
  logging: OciLoggingApi | null;
  logSearch: OciLogSearchApi | null;
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  sleep: (durationMs: number) => Promise<void>;
  logGroupPollAttempts?: number;
  logGroupPollIntervalMs?: number;
};

export class DeliveryLogsNotConfiguredError extends Error {
  constructor() {
    super("Oracle Cloud Logging API is not configured");
    this.name = "DeliveryLogsNotConfiguredError";
  }
}

function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

/** OCI log display names: letters, digits, `-`, `_`, `.`; max 100 here. */
export function deliveryLogDisplayName(domain: string, category: string) {
  const safe = domain.toLowerCase().replace(/[^a-z0-9-]/g, "_");
  return `${safe}_${category}`.slice(0, 100);
}

/**
 * Logging Search query for relay / bounce / complaint records. Scoped to the
 * compartment (not only our log group) so logs enabled from the Console into
 * another group in the same compartment are picked up too.
 */
export function buildDeliveryEventsQuery(compartmentId: string) {
  return (
    `search "${compartmentId}"` +
    ` | type='${OUTBOUND_RELAYED_TYPE}'` +
    ` and (data.action='relay' or data.action='bounce' or data.action='complaint')` +
    ` | sort by datetime asc`
  );
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function date(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseAction(value: unknown): ProviderDeliveryAction {
  const action = str(value)?.toLowerCase() as ProviderDeliveryAction;
  return KNOWN_ACTIONS.has(action) ? action : "unknown";
}

/** errorType is documented as "hard"/"soft" ("Hard bounce" in the table). */
function parseBounceType(value: unknown): "hard" | "soft" | undefined {
  const raw = str(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("hard")) return "hard";
  if (raw.includes("soft")) return "soft";
  return undefined;
}

/**
 * Maps one Logging Search result (`{ datetime, logContent: {...} }`) to a
 * typed delivery event. Returns null for anything that is not an
 * Email Delivery record.
 */
export function mapSearchResult(result: unknown): ProviderDeliveryEvent | null {
  const root = (result ?? {}) as { datetime?: unknown; logContent?: unknown };
  const content = (root.logContent ?? root) as {
    id?: unknown;
    time?: unknown;
    type?: unknown;
    source?: unknown;
    data?: Record<string, unknown>;
  };
  const data = content.data;
  if (!data || typeof data !== "object") {
    return null;
  }

  const action = parseAction(data.action);
  const messageIdRaw = str(data.messageId);
  const messageId = messageIdRaw ? stripAngleBrackets(messageIdRaw) : undefined;
  const recipient = str(data.recipient)?.toLowerCase();
  const timestamp =
    date(content.time) ?? date(root.datetime) ?? date(data.reportGeneratedTime);
  if (!timestamp) {
    return null;
  }

  // Record ids are unique per log entry; fall back to a content hash.
  const id =
    str(content.id) ??
    createHash("sha256")
      .update(
        [
          str(content.type),
          action,
          messageId,
          recipient,
          timestamp.toISOString(),
        ].join("|"),
      )
      .digest("hex");

  const processing = Number(data.internalProcessingDurationInMs);

  return {
    id,
    action,
    timestamp,
    messageId,
    recipient,
    sender: str(data.sender),
    domain: str(content.source),
    bounceType: parseBounceType(data.errorType),
    bounceCategory: str(data.bounceCategory),
    bounceCode: str(data.bounceCode),
    smtpStatus: str(data.smtpStatus),
    message: str(data.message),
    recipientMailServer: str(data.recipientMailServer),
    processingTimeMs: Number.isFinite(processing) ? processing : undefined,
    reportGeneratedTime: date(data.reportGeneratedTime),
  };
}

/**
 * Creates and reads the OCI Email Delivery service logs used for
 * delivered / bounced / complained events (Resend-style), polled through the
 * Logging Search API instead of push notifications (Connector Hub ->
 * Notifications HTTPS is capped at 60 messages/min per topic).
 */
export class OciDeliveryLogs {
  private readonly deps: OciDeliveryLogsDeps;
  private readonly logGroupName: string;
  private readonly ensuredUntil = new Map<string, number>();
  private logGroupId: string | null = null;

  constructor(deps: OciDeliveryLogsDeps) {
    this.deps = deps;
    this.logGroupName = deps.logGroupName || DEFAULT_LOG_GROUP_NAME;
  }

  private get logging(): OciLoggingApi {
    if (!this.deps.logging || !this.deps.compartmentId) {
      throw new DeliveryLogsNotConfiguredError();
    }
    return this.deps.logging;
  }

  private get compartmentId(): string {
    if (!this.deps.compartmentId) {
      throw new DeliveryLogsNotConfiguredError();
    }
    return this.deps.compartmentId;
  }

  /** True when logs for this email domain were ensured recently. */
  isEnsured(emailDomainId: string) {
    const cachedUntil = this.ensuredUntil.get(emailDomainId);
    return Boolean(cachedUntil && cachedUntil > Date.now() && this.logGroupId);
  }

  async ensureForEmailDomain(
    emailDomainId: string,
    domainName: string,
  ): Promise<ProviderDeliveryLogsResult> {
    if (this.isEnsured(emailDomainId) && this.logGroupId) {
      return { status: "enabled", logGroupId: this.logGroupId, created: [] };
    }

    const logGroupId = await this.ensureLogGroup();
    const existing = await this.listExistingCategories(emailDomainId);
    const created: string[] = [];

    for (const category of DELIVERY_LOG_CATEGORIES) {
      if (existing.has(category)) continue;
      try {
        await this.logging.createLog({
          logGroupId,
          createLogDetails: {
            displayName: deliveryLogDisplayName(domainName, category),
            logType: "SERVICE" as loggingModels.CreateLogDetails.LogType,
            isEnabled: true,
            configuration: {
              compartmentId: this.compartmentId,
              source: {
                sourceType: "OCISERVICE",
                service: EMAIL_DELIVERY_LOG_SERVICE,
                resource: emailDomainId,
                category,
              },
            },
          },
        });
        created.push(category);
      } catch (error) {
        // 409 = a log for this domain/category already exists (possibly in
        // another log group, e.g. enabled from the Console).
        if (getStatusCode(error) !== 409) {
          throw error;
        }
      }
    }

    if (created.length > 0) {
      logger.info(
        { domain: domainName, emailDomainId, created },
        "[OciDeliveryLogs]: Enabled Email Delivery service logs",
      );
    }

    this.ensuredUntil.set(emailDomainId, Date.now() + ENSURED_CACHE_TTL_MS);
    return { status: "enabled", logGroupId, created };
  }

  private async findLogGroupId(): Promise<string | undefined> {
    const res = await this.logging.listLogGroups({
      compartmentId: this.compartmentId,
      displayName: this.logGroupName,
    });
    return (res.items ?? []).find(
      (group) =>
        group.displayName === this.logGroupName &&
        String(group.lifecycleState ?? "ACTIVE") !== "DELETING",
    )?.id;
  }

  private async ensureLogGroup(): Promise<string> {
    if (this.logGroupId) {
      return this.logGroupId;
    }

    let id = await this.findLogGroupId();
    if (!id) {
      try {
        await this.logging.createLogGroup({
          createLogGroupDetails: {
            compartmentId: this.compartmentId,
            displayName: this.logGroupName,
            description: "Scribase Mail delivery events (Email Delivery logs)",
          },
        });
        logger.info(
          { logGroupName: this.logGroupName },
          "[OciDeliveryLogs]: Created log group",
        );
      } catch (error) {
        if (getStatusCode(error) !== 409) {
          throw error;
        }
      }

      // CreateLogGroup is asynchronous (work request); wait until listable.
      const attempts = this.deps.logGroupPollAttempts ?? 10;
      const interval = this.deps.logGroupPollIntervalMs ?? 2000;
      for (let attempt = 0; attempt < attempts && !id; attempt++) {
        id = await this.findLogGroupId();
        if (!id) await this.deps.sleep(interval);
      }
    }

    if (!id) {
      throw new Error(`Log group ${this.logGroupName} is not available yet`);
    }

    this.logGroupId = id;
    return id;
  }

  private async listExistingCategories(emailDomainId: string) {
    const categories = new Set<string>();
    const logGroupId = await this.ensureLogGroup();
    let page: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await this.logging.listLogs({
        logGroupId,
        sourceService: EMAIL_DELIVERY_LOG_SERVICE,
        sourceResource: emailDomainId,
        limit: LIST_PAGE_LIMIT,
        page,
      });
      for (const log of res.items ?? []) {
        const state = String(log.lifecycleState ?? "");
        const category = log.configuration?.source?.category;
        if (category && !["DELETING", "INACTIVE"].includes(state)) {
          categories.add(category);
        }
      }
      page = res.opcNextPage;
      if (!page) break;
    }
    return categories;
  }

  async listEvents(
    since: Date,
    until: Date,
  ): Promise<ProviderDeliveryEventPage> {
    if (!this.deps.logSearch || !this.deps.compartmentId) {
      throw new DeliveryLogsNotConfiguredError();
    }

    const events: ProviderDeliveryEvent[] = [];
    const searchQuery = buildDeliveryEventsQuery(this.deps.compartmentId);
    let page: string | undefined;

    for (let i = 0; i < SEARCH_MAX_PAGES; i++) {
      const res = await this.deps.logSearch.searchLogs({
        searchLogsDetails: {
          timeStart: since,
          timeEnd: until,
          searchQuery,
          isReturnFieldInfo: false,
        },
        limit: SEARCH_PAGE_LIMIT,
        page,
      });

      for (const result of res.searchResponse?.results ?? []) {
        const event = mapSearchResult(result.data);
        if (event) events.push(event);
      }

      page = res.opcNextPage;
      if (!page) {
        return { events, truncated: false };
      }
    }

    logger.warn(
      { since, until, pages: SEARCH_MAX_PAGES },
      "[OciDeliveryLogs]: Search page cap reached; the rest is read next poll",
    );
    return { events, truncated: true };
  }
}
