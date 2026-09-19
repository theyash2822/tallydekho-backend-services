import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { hashToken } from './deviceCredential.js';

const ROOT = process.env.BACKUP_OBJECT_ROOT || path.join(process.cwd(), 'data', 'workspace-backups');

function s3Configured() {
  return !!(process.env.AWS_S3_BACKUP_BUCKET && (process.env.AWS_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID));
}

export function objectKeyFor(workspaceId, backupId) {
  return `workspace-backups/${workspaceId}/${backupId}.zip`;
}

export async function createUploadAuthorization({ workspaceId, backupId, sizeBytes }) {
  const key = objectKeyFor(workspaceId, backupId);
  if (s3Configured()) {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = new S3Client({
      region: process.env.AWS_S3_REGION || process.env.AWS_SES_REGION || 'ap-south-1',
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BACKUP_BUCKET,
        Key: key,
        ContentType: 'application/zip',
        ContentLength: sizeBytes || undefined,
      }),
      { expiresIn: 60 * 60 }
    );
    return { method: 'PUT', url, headers: { 'Content-Type': 'application/zip' }, objectKey: key, transport: 's3' };
  }

  await fsp.mkdir(ROOT, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const metaPath = path.join(ROOT, `${token}.json`);
  await fsp.writeFile(metaPath, JSON.stringify({ key, backupId, workspaceId, createdAt: Date.now() }));
  return {
    method: 'PUT',
    url: `/desktop/backup/objects/${token}`,
    headers: { 'Content-Type': 'application/zip' },
    objectKey: key,
    transport: 'local',
    uploadToken: token,
  };
}

export async function storeLocalUpload(token, buffer) {
  const metaPath = path.join(ROOT, `${token}.json`);
  const raw = await fsp.readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw);
  const dest = path.join(ROOT, meta.key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buffer);
  await fsp.unlink(metaPath).catch(() => {});
  return { objectKey: meta.key, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

export async function createDownloadAuthorization({ objectKey }) {
  if (s3Configured()) {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = new S3Client({
      region: process.env.AWS_S3_REGION || process.env.AWS_SES_REGION || 'ap-south-1',
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: process.env.AWS_S3_BACKUP_BUCKET, Key: objectKey }),
      { expiresIn: 30 * 60 }
    );
    return { method: 'GET', url, transport: 's3' };
  }
  const token = crypto.randomBytes(24).toString('hex');
  await fsp.mkdir(ROOT, { recursive: true });
  await fsp.writeFile(path.join(ROOT, `${token}.dl.json`), JSON.stringify({ objectKey, createdAt: Date.now() }));
  return { method: 'GET', url: `/desktop/backup/objects/${token}?dl=1`, transport: 'local', downloadToken: token };
}

export async function readLocalDownload(token) {
  const meta = JSON.parse(await fsp.readFile(path.join(ROOT, `${token}.dl.json`), 'utf8'));
  const dest = path.join(ROOT, meta.objectKey);
  const buf = await fsp.readFile(dest);
  return { buffer: buf, objectKey: meta.objectKey };
}

export async function deleteObject(objectKey) {
  if (!objectKey) return;
  if (s3Configured()) {
    try {
      const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: process.env.AWS_S3_REGION || process.env.AWS_SES_REGION || 'ap-south-1',
        credentials: {
          accessKeyId: process.env.AWS_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
      await client.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BACKUP_BUCKET, Key: objectKey }));
    } catch (err) {
      console.warn('[objectStore] s3 delete skipped', err.message);
    }
    return;
  }
  await fsp.unlink(path.join(ROOT, objectKey)).catch(() => {});
}

export { hashToken };
