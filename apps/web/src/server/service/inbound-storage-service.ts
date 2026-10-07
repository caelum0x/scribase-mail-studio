/**
 * OCI Object Storage helpers for inbound mail (raw .eml files and attachments).
 *
 * Re-uses the existing OCI client from `storage-service.ts` but is a separate
 * file so the two concerns stay isolated and parallel agents don't conflict.
 *
 * Signed download URLs expire after 1 hour by default.
 */

import { ObjectStorageClient, models } from "oci-objectstorage";
import { env } from "~/env";
import { readOciConfig } from "~/server/provider/oci/config";
import { createOciAuthProvider } from "~/server/provider/oci/factory";
import { logger } from "~/server/logger/log";
import path from "path";
import { mkdirSync, writeFileSync } from "fs";

const DOWNLOAD_URL_TTL_MS = 60 * 60 * 1000; // 1 hour

let _client: ObjectStorageClient | null = null;

function getClient(): ObjectStorageClient | null {
  if (_client) return _client;
  try {
    const config = readOciConfig(env);
    const provider = createOciAuthProvider(config);
    if (!provider) return null;
    _client = new ObjectStorageClient({ authenticationDetailsProvider: provider });
    _client.regionId = config.region;
    return _client;
  } catch {
    return null;
  }
}

/**
 * Generate a short-lived pre-authenticated request (PAR) for downloading an object.
 * Falls back to a local-disk file path (for dev) when OCI is not configured.
 */
export async function getStorageSignedDownloadUrl(
  storageKey: string,
): Promise<string> {
  const client = getClient();

  if (
    client &&
    env.OCI_STORAGE_NAMESPACE &&
    env.OCI_STORAGE_BUCKET
  ) {
    const response = await client.createPreauthenticatedRequest({
      namespaceName: env.OCI_STORAGE_NAMESPACE,
      bucketName: env.OCI_STORAGE_BUCKET,
      createPreauthenticatedRequestDetails: {
        name: `dl-${storageKey.replace(/[^a-zA-Z0-9-]/g, "-")}`.slice(0, 120),
        objectName: storageKey,
        accessType:
          models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
        timeExpires: new Date(Date.now() + DOWNLOAD_URL_TTL_MS),
      },
    });

    const accessUri = response.preauthenticatedRequest.accessUri;
    const region = readOciConfig(env).region;
    return accessUri.startsWith("http")
      ? accessUri
      : `https://objectstorage.${region}.oraclecloud.com${accessUri}`;
  }

  // Dev fallback: return a local path indicator
  const localDir =
    process.env.INBOUND_STORAGE_DIR ?? "/tmp/scribase-inbound";
  return `file://${path.join(localDir, storageKey)}`;
}

/**
 * Put raw bytes into OCI Object Storage or local disk (dev).
 * Returns the stored key.
 */
export async function storeInboundObject(
  key: string,
  data: Buffer,
  contentType = "application/octet-stream",
): Promise<string> {
  const client = getClient();

  if (
    client &&
    env.OCI_STORAGE_NAMESPACE &&
    env.OCI_STORAGE_BUCKET
  ) {
    await client.putObject({
      namespaceName: env.OCI_STORAGE_NAMESPACE,
      bucketName: env.OCI_STORAGE_BUCKET,
      objectName: key,
      putObjectBody: data,
      contentLength: data.length,
      contentType,
    });
    return key;
  }

  // Local disk fallback
  const localDir =
    process.env.INBOUND_STORAGE_DIR ?? "/tmp/scribase-inbound";
  const fullPath = path.join(localDir, key);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, data);
  logger.debug({ key }, "Inbound object stored locally (no OCI configured)");
  return key;
}
