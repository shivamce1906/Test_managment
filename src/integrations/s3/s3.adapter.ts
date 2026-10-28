import fs from 'fs';
import path from 'path';
import { logger } from '../../utils';
import { env } from '../../config';

// In-memory cache for fast test and run execution
const memoryCache = new Map<string, { buffer: Buffer; contentType: string }>();

export class S3Adapter {
  private bucket: string;
  private region: string;
  private uploadDir: string;
  private isProduction: boolean;

  constructor() {
    this.bucket = env.S3_BUCKET;
    this.region = env.AWS_REGION;
    this.uploadDir = env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
    this.isProduction = env.NODE_ENV === 'production';

    // Ensure local persistent upload directory exists
    try {
      if (!fs.existsSync(this.uploadDir)) {
        fs.mkdirSync(this.uploadDir, { recursive: true });
      }
    } catch (err) {
      logger.warn({ err, dir: this.uploadDir }, 'Could not initialize uploads directory on disk');
    }

    if (this.isProduction && (env.AWS_ACCESS_KEY_ID === 'mock-access-key' || !env.AWS_ACCESS_KEY_ID)) {
      logger.warn(
        { bucket: this.bucket, uploadDir: this.uploadDir },
        '⚠️ AWS S3 credentials not configured for production. Using persistent local disk storage fallback.'
      );
    }
  }

  /**
   * Generates a presigned URL for client upload.
   */
  async getPresignedUploadUrl(key: string, contentType: string): Promise<{ url: string; key: string }> {
    const url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}?X-Amz-Signature=mock-sig`;
    return { url, key };
  }

  async getPresignedPutUrl(key: string, contentType: string = 'application/octet-stream'): Promise<string> {
    const res = await this.getPresignedUploadUrl(key, contentType);
    return res.url;
  }

  /**
   * Generates a presigned URL for downloading a private file (15 min expiry).
   */
  async getPresignedDownloadUrl(key: string, expiresInSeconds: number = 900): Promise<string> {
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}?expires=${expiresInSeconds}&X-Amz-Signature=mock-sig`;
  }

  /**
   * Directly stores a generated buffer (e.g. PDF or Excel) in memory and persists to disk.
   */
  async uploadBuffer(key: string, buffer: Buffer, contentType: string = 'application/octet-stream'): Promise<string> {
    memoryCache.set(key, { buffer, contentType });

    // Persist to disk so files survive server restarts
    try {
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_\-./]/g, '_');
      const targetFilePath = path.join(this.uploadDir, sanitizedKey);
      const targetDir = path.dirname(targetFilePath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(targetFilePath, buffer);
      logger.debug({ key, path: targetFilePath, size: buffer.length }, 'File persisted to storage');
    } catch (err) {
      logger.warn({ err, key }, 'Failed to persist file buffer to disk');
    }

    return key;
  }

  /**
   * Retrieves a stored buffer from memory cache or persistent disk storage.
   */
  async getBuffer(key: string): Promise<Buffer> {
    const item = memoryCache.get(key);
    if (item) {
      return item.buffer;
    }

    try {
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_\-./]/g, '_');
      const targetFilePath = path.join(this.uploadDir, sanitizedKey);
      if (fs.existsSync(targetFilePath)) {
        const buffer = fs.readFileSync(targetFilePath);
        memoryCache.set(key, { buffer, contentType: 'application/octet-stream' });
        return buffer;
      }
    } catch (err) {
      logger.warn({ err, key }, 'Failed to read file buffer from disk');
    }

    return Buffer.from('');
  }

  putObject = this.uploadBuffer.bind(this);
  getObject = this.getBuffer.bind(this);
}

export const s3Adapter = new S3Adapter();
