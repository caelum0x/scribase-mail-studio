import { ObjectStorageClient, models } from "oci-objectstorage";
import { env } from "~/env";
import { readOciConfig } from "~/server/provider/oci/config";
import { createOciAuthProvider } from "~/server/provider/oci/factory";

/**
 * Image uploads for the email editor, stored in OCI Object Storage.
 * The browser uploads directly with a short-lived pre-authenticated request
 * (PAR) scoped to a single object; images are served from STORAGE_PUBLIC_URL
 * (a public bucket URL or a CDN in front of it).
 */

const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;

let client: ObjectStorageClient | null = null;

export const isStorageConfigured = () =>
  Boolean(
    env.OCI_STORAGE_NAMESPACE &&
    env.OCI_STORAGE_BUCKET &&
    env.STORAGE_PUBLIC_URL &&
    createOciAuthProvider(readOciConfig(env)),
  );

const getClient = () => {
  if (client) {
    return client;
  }

  const config = readOciConfig(env);
  const authenticationDetailsProvider = createOciAuthProvider(config);
  if (!authenticationDetailsProvider) {
    return null;
  }

  client = new ObjectStorageClient({ authenticationDetailsProvider });
  client.regionId = config.region;
  return client;
};

export function getStoragePublicUrl(key: string) {
  return `${(env.STORAGE_PUBLIC_URL ?? "").replace(/\/+$/, "")}/${key}`;
}

export const getDocumentUploadUrl = async (key: string) => {
  const storage = getClient();

  if (!storage || !env.OCI_STORAGE_NAMESPACE || !env.OCI_STORAGE_BUCKET) {
    throw new Error("Object storage is not configured");
  }

  const response = await storage.createPreauthenticatedRequest({
    namespaceName: env.OCI_STORAGE_NAMESPACE,
    bucketName: env.OCI_STORAGE_BUCKET,
    createPreauthenticatedRequestDetails: {
      name: `upload-${key.replace(/[^a-zA-Z0-9-]/g, "-")}`.slice(0, 120),
      objectName: key,
      accessType:
        models.CreatePreauthenticatedRequestDetails.AccessType.ObjectWrite,
      timeExpires: new Date(Date.now() + UPLOAD_URL_TTL_MS),
    },
  });

  const accessUri = response.preauthenticatedRequest.accessUri;
  return accessUri.startsWith("http")
    ? accessUri
    : `https://objectstorage.${readOciConfig(env).region}.oraclecloud.com${accessUri}`;
};
