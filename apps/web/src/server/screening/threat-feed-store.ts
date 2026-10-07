import { getRedis, redisKey } from "~/server/redis";
import { logger } from "~/server/logger/log";
import { HostHashBuilder, ThreatIndex } from "./threat-index";

/**
 * Downloads threat feeds, stores the compact host index in Redis, and serves
 * it to every process from a small in-memory cache.
 */

const INDEX_KEY = "screening:feed:index";
const META_KEY = "screening:feed:meta";
const MAX_FEED_BYTES = 64 * 1024 * 1024;
const FEED_TIMEOUT_MS = 120_000;
const RECHECK_MS = 5 * 60 * 1000;

export type FeedSourceResult = { url: string; hosts: number; error?: string };

export type ThreatFeedMeta = {
  version: string;
  hosts: number;
  updatedAt: string;
  sources: FeedSourceResult[];
};

export function parseListEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

async function readCapped(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`Feed too large (${declared} bytes)`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Feed larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function downloadFeed(url: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: { "User-Agent": "ScribaseMail-ContentScreening/1.0" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return readCapped(response, MAX_FEED_BYTES);
}

/**
 * Rebuilds the index from all feeds. If any feed fails, the previous index is
 * kept (a partial index would silently drop that feed's entries) unless there
 * is no index yet.
 */
export async function refreshThreatFeeds({
  urls,
  fetchImpl = fetch,
  now = new Date(),
}: {
  urls: string[];
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ saved: boolean; meta: ThreatFeedMeta }> {
  const builder = new HostHashBuilder();
  const sources: FeedSourceResult[] = [];

  for (const url of urls) {
    try {
      const added = builder.addFeedText(await downloadFeed(url, fetchImpl));
      sources.push({ url, hosts: added });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ url, err: error }, "[ThreatFeed]: Feed download failed");
      sources.push({ url, hosts: 0, error: message });
    }
  }

  const index = builder.build();
  const meta: ThreatFeedMeta = {
    version: `${now.getTime()}`,
    hosts: index.length,
    updatedAt: now.toISOString(),
    sources,
  };

  const redis = getRedis();
  const anyFailed = sources.some((s) => s.error);
  const hasExisting = Boolean(await redis.exists(redisKey(META_KEY)));
  if (anyFailed && hasExisting) {
    return { saved: false, meta };
  }

  const buffer = Buffer.from(index.buffer, index.byteOffset, index.byteLength);
  await redis
    .multi()
    .set(redisKey(INDEX_KEY), buffer)
    .set(redisKey(META_KEY), JSON.stringify(meta))
    .exec();
  logger.info(
    { hosts: meta.hosts, sources },
    "[ThreatFeed]: Threat index refreshed",
  );
  return { saved: true, meta };
}

export async function getThreatFeedMeta(): Promise<ThreatFeedMeta | null> {
  const raw = await getRedis().get(redisKey(META_KEY));
  return raw ? (JSON.parse(raw) as ThreatFeedMeta) : null;
}

let cached: { version: string; index: ThreatIndex; checkedAt: number } | null =
  null;

/** Test hook. */
export function resetThreatIndexCache() {
  cached = null;
}

/**
 * The current index, reloaded from Redis when a newer version exists.
 * Returns an empty index (and logs) when Redis is unavailable so sending is
 * not blocked by a feed outage; the heuristics still run.
 */
export async function getThreatIndex(
  extraExemptHosts: string[] = [],
  now = Date.now(),
): Promise<ThreatIndex> {
  if (cached && now - cached.checkedAt < RECHECK_MS) {
    return cached.index;
  }
  try {
    const meta = await getThreatFeedMeta();
    if (!meta) {
      cached = { version: "", index: ThreatIndex.empty(), checkedAt: now };
      return cached.index;
    }
    if (cached && cached.version === meta.version) {
      cached = { ...cached, checkedAt: now };
      return cached.index;
    }
    const buffer = await getRedis().getBuffer(redisKey(INDEX_KEY));
    // Copy into an aligned ArrayBuffer for the typed array view.
    const hashes = buffer
      ? new BigUint64Array(
          buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
          ),
        )
      : new BigUint64Array(0);
    cached = {
      version: meta.version,
      index: new ThreatIndex(hashes, extraExemptHosts),
      checkedAt: now,
    };
    return cached.index;
  } catch (error) {
    logger.error({ err: error }, "[ThreatFeed]: Could not load threat index");
    return cached?.index ?? ThreatIndex.empty();
  }
}
