import { randomUUID, createHmac } from 'node:crypto';
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { bytesToHex } from '@noble/hashes/utils';
import { getDb } from '../db/postgres';
import { getConfig } from '../config';
import { delegationsService } from './delegations';
import type {
  AuthContext,
  StoragePrepareUploadInput,
  StoragePrepareUploadResult,
  StorageCompleteUploadInput,
  StorageObjectOutput,
  StorageUsageResult,
} from '../types';

const TABLE = 'superbased_storage_objects';

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.slice(0, 128) || 'file.bin';
}

function parseMaybeNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
}

function toStorageOutput(row: any): StorageObjectOutput {
  return {
    id: row.id,
    app_pubkey: row.app_pubkey,
    owner_pubkey: row.owner_pubkey,
    bucket: row.bucket,
    object_key: row.object_key,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: parseMaybeNumber(row.size_bytes),
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
    deleted_at: row.deleted_at,
  };
}

class StorageService {
  private readonly config = getConfig();

  private readonly s3 = new S3Client({
    endpoint: this.config.storageS3Endpoint,
    region: this.config.storageS3Region,
    forcePathStyle: this.config.storageS3ForcePathStyle,
    credentials: {
      accessKeyId: this.config.storageS3AccessKey,
      secretAccessKey: this.config.storageS3SecretKey,
    },
  });
  private readonly presignS3 = new S3Client({
    endpoint: this.config.storageS3PublicEndpoint,
    region: this.config.storageS3Region,
    forcePathStyle: this.config.storageS3ForcePathStyle,
    credentials: {
      accessKeyId: this.config.storageS3AccessKey,
      secretAccessKey: this.config.storageS3SecretKey,
    },
  });

  private get bucketName(): string {
    return this.config.storageS3Bucket;
  }

  private async getUsageBytes(appPubkey: string, ownerPubkey: string): Promise<number> {
    const sql = getDb();
    const rows = await sql`
      SELECT COALESCE(SUM(size_bytes), 0) AS used
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
        AND status = 'ready'
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    `;
    return parseMaybeNumber(rows[0]?.used);
  }

  private ensureEnabled() {
    if (!this.config.storageEnabled) {
      throw new Error('storage_disabled');
    }
  }

  async prepareUpload(appPubkey: string, auth: AuthContext, input: StoragePrepareUploadInput): Promise<StoragePrepareUploadResult> {
    this.ensureEnabled();

    if (!input.filename || !input.mime_type || !Number.isFinite(input.size_bytes)) {
      throw new Error('filename, mime_type, and size_bytes are required');
    }

    const sizeBytes = Math.floor(input.size_bytes);
    if (sizeBytes <= 0) throw new Error('size_bytes must be > 0');
    if (sizeBytes > this.config.storageMaxObjectBytes) throw new Error('object_too_large');

    const used = await this.getUsageBytes(appPubkey, auth.pubkey);
    if (used + sizeBytes > this.config.storageMaxBytesPerNpub) {
      throw new Error('quota_exceeded');
    }

    const ttl = input.ttl_seconds ?? this.config.storageDefaultTtlSeconds;
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null;
    const id = randomUUID();
    const fileName = sanitizeFilename(input.filename);
    const objectKey = `${appPubkey}/${auth.pubkey}/${new Date().toISOString().slice(0, 10)}/${id}-${fileName}`;

    const sql = getDb();
    await sql`
      INSERT INTO ${sql(TABLE)} (
        id, app_pubkey, owner_pubkey, bucket, object_key, file_name, mime_type, size_bytes, status, expires_at
      ) VALUES (
        ${id}, ${appPubkey}, ${auth.pubkey}, ${this.bucketName}, ${objectKey}, ${fileName}, ${input.mime_type}, ${sizeBytes}, 'pending', ${expiresAt}
      )
    `;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: input.mime_type,
      ContentLength: sizeBytes,
    });

    const uploadUrl = await getSignedUrl(this.presignS3, command, {
      expiresIn: this.config.storagePresignUploadTtlSeconds,
    });

    return {
      object_id: id,
      object_key: objectKey,
      bucket: this.bucketName,
      upload_url: uploadUrl,
      expires_at: expiresAt,
    };
  }

  async completeUpload(appPubkey: string, auth: AuthContext, input: StorageCompleteUploadInput): Promise<StorageObjectOutput> {
    this.ensureEnabled();
    if (!input.object_id) throw new Error('object_id required');

    const sql = getDb();
    const rows = await sql`
      SELECT * FROM ${sql(TABLE)}
      WHERE id = ${input.object_id}
        AND app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
      LIMIT 1
    `;

    if (rows.length === 0) throw new Error('object_not_found');
    const row = rows[0] as any;
    if (row.status === 'deleted') throw new Error('object_deleted');

    const head = await this.s3.send(new HeadObjectCommand({
      Bucket: row.bucket,
      Key: row.object_key,
    }));

    if (!head.ContentLength || head.ContentLength <= 0) {
      throw new Error('object_not_uploaded');
    }

    await sql`
      UPDATE ${sql(TABLE)}
      SET status = 'ready',
          size_bytes = ${head.ContentLength},
          completed_at = now(),
          updated_at = now()
      WHERE id = ${input.object_id}
    `;

    const updated = await sql`
      SELECT * FROM ${sql(TABLE)} WHERE id = ${input.object_id} LIMIT 1
    `;

    return toStorageOutput(updated[0]);
  }

  async getDownloadUrl(appPubkey: string, auth: AuthContext, objectId: string, ttlSeconds?: number): Promise<{ download_url: string; expires_in_seconds: number }> {
    this.ensureEnabled();

    const MAX_DOWNLOAD_TTL = 72 * 60 * 60; // 72 hours

    const sql = getDb();
    const rows = await sql`
      SELECT * FROM ${sql(TABLE)}
      WHERE id = ${objectId}
        AND app_pubkey = ${appPubkey}
        AND status = 'ready'
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;

    if (rows.length === 0) throw new Error('object_not_found');
    const row = rows[0] as any;
    const ownerPubkey = row.owner_pubkey as string;

    if (auth.pubkey !== ownerPubkey) {
      const hasReadDelegation = await delegationsService.checkReadPermission(
        appPubkey,
        auth.pubkey,
        ownerPubkey
      );
      if (!hasReadDelegation) {
        throw new Error('object_not_found');
      }
    }

    const command = new GetObjectCommand({
      Bucket: row.bucket,
      Key: row.object_key,
    });

    const expiresIn = Math.min(
      ttlSeconds && ttlSeconds > 0 ? ttlSeconds : this.config.storagePresignDownloadTtlSeconds,
      MAX_DOWNLOAD_TTL
    );
    const downloadUrl = await getSignedUrl(this.presignS3, command, { expiresIn });

    return { download_url: downloadUrl, expires_in_seconds: expiresIn };
  }

  async deleteObject(appPubkey: string, auth: AuthContext, objectId: string): Promise<{ deleted: boolean }> {
    this.ensureEnabled();

    const sql = getDb();
    const rows = await sql`
      SELECT * FROM ${sql(TABLE)}
      WHERE id = ${objectId}
        AND app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
      LIMIT 1
    `;

    if (rows.length === 0) return { deleted: false };
    const row = rows[0] as any;

    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: row.bucket,
        Key: row.object_key,
      }));
    } catch {
      // Keep delete idempotent even if the object is already gone.
    }

    await sql`
      UPDATE ${sql(TABLE)}
      SET status = 'deleted',
          deleted_at = now(),
          updated_at = now()
      WHERE id = ${objectId}
    `;

    return { deleted: true };
  }

  async listObjects(appPubkey: string, auth: AuthContext, limit = 100): Promise<StorageObjectOutput[]> {
    this.ensureEnabled();

    const bounded = Math.min(Math.max(limit, 1), 500);
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
        AND status = 'ready'
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT ${bounded}
    `;

    return rows.map(toStorageOutput);
  }

  async getUsage(appPubkey: string, auth: AuthContext): Promise<StorageUsageResult> {
    this.ensureEnabled();

    const sql = getDb();
    const rows = await sql`
      SELECT
        COUNT(*)::integer AS file_count,
        COALESCE(SUM(size_bytes), 0) AS used_bytes
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
        AND status = 'ready'
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    `;

    const fileCount = parseMaybeNumber(rows[0]?.file_count);
    const usedBytes = parseMaybeNumber(rows[0]?.used_bytes);

    return {
      owner_pubkey: auth.pubkey,
      file_count: fileCount,
      used_bytes: usedBytes,
      max_bytes: this.config.storageMaxBytesPerNpub,
      available_bytes: Math.max(this.config.storageMaxBytesPerNpub - usedBytes, 0),
    };
  }

  createShareToken(objectId: string, ttlSeconds: number): { token: string; expires_at: string } {
    const MAX_SHARE_TTL = 72 * 60 * 60; // 72 hours
    const ttl = Math.min(Math.max(ttlSeconds, 60), MAX_SHARE_TTL);
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const payload = `${objectId}:${expiresAt}`;
    const secret = bytesToHex(this.config.serverPrivateKey);
    const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
    const token = Buffer.from(`${payload}:${sig}`).toString('base64url');
    return { token, expires_at: new Date(expiresAt * 1000).toISOString() };
  }

  async resolveShareToken(token: string): Promise<string> {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) throw new Error('invalid_token');
    const [objectId, expiresAtStr, sig] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error('token_expired');
    }
    const payload = `${objectId}:${expiresAt}`;
    const secret = bytesToHex(this.config.serverPrivateKey);
    const expected = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
    if (sig !== expected) throw new Error('invalid_token');

    const appPubkey = this.config.serverPublicKey;
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM ${sql(TABLE)}
      WHERE id = ${objectId}
        AND status = 'ready'
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    if (rows.length === 0) throw new Error('object_not_found');
    const row = rows[0] as any;

    const command = new GetObjectCommand({
      Bucket: row.bucket,
      Key: row.object_key,
    });
    const presignTtl = Math.min(expiresAt - Math.floor(Date.now() / 1000), 72 * 60 * 60);
    return await getSignedUrl(this.presignS3, command, { expiresIn: presignTtl });
  }

  async pruneExpired(limit = 200): Promise<number> {
    this.ensureEnabled();

    const sql = getDb();
    const rows = await sql`
      SELECT id, bucket, object_key
      FROM ${sql(TABLE)}
      WHERE (expires_at IS NOT NULL AND expires_at <= now())
         OR (status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= now() - (${this.config.storageDeletedRetentionSeconds} * interval '1 second'))
      ORDER BY created_at ASC
      LIMIT ${Math.max(1, Math.min(limit, 5000))}
    `;

    for (const row of rows as any[]) {
      try {
        await this.s3.send(new DeleteObjectCommand({
          Bucket: row.bucket,
          Key: row.object_key,
        }));
      } catch {
        // Ignore S3 delete errors so metadata cleanup can still continue.
      }

      await sql`DELETE FROM ${sql(TABLE)} WHERE id = ${row.id}`;
    }

    return rows.length;
  }
}

export const storageService = new StorageService();
