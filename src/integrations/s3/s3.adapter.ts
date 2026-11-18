import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../../utils';
import { env } from '../../config';

// In-memory cache for fast test and run execution
const memoryCache = new Map<string, { buffer: Buffer; contentType: string }>();

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

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

    if (this.isProduction && !this.hasAwsCredentials()) {
      logger.warn(
        { bucket: this.bucket, uploadDir: this.uploadDir },
        '⚠️ AWS S3 credentials not configured for production. Using signed local disk storage fallback.'
      );
    }
  }

  private hasAwsCredentials(): boolean {
    return Boolean(
      env.AWS_ACCESS_KEY_ID &&
        env.AWS_ACCESS_KEY_ID !== 'mock-access-key' &&
        env.AWS_SECRET_ACCESS_KEY &&
        env.AWS_SECRET_ACCESS_KEY !== 'mock-secret-key'
    );
  }

  private buildAwsSigV4Url(
    method: 'PUT' | 'GET',
    key: string,
    expiresInSeconds: number,
    contentType?: string
  ): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = `${this.bucket}.s3.${this.region}.amazonaws.com`;
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const encodedKey = key
      .split('/')
      .map((seg) => encodeRfc3986(seg))
      .join('/');

    const signedHeadersList = method === 'PUT' && contentType ? ['content-type', 'host'] : ['host'];
    const signedHeaders = signedHeadersList.join(';');

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${env.AWS_ACCESS_KEY_ID}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
    };

    const canonicalQuery = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
      .join('&');

    const canonicalHeaders =
      method === 'PUT' && contentType
        ? `content-type:${contentType}\nhost:${host}\n`
        : `host:${host}\n`;

    const canonicalRequest = [
      method,
      `/${encodedKey}`,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmacSha256(`AWS4${env.AWS_SECRET_ACCESS_KEY}`, dateStamp);
    const kRegion = hmacSha256(kDate, this.region);
    const kService = hmacSha256(kRegion, 's3');
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `https://${host}/${encodedKey}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  private signLocalUrl(method: 'PUT' | 'GET', key: string, expiresInSeconds: number, contentType?: string): string {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = `${method}:${key}:${expires}:${contentType || ''}`;
    const sig = crypto.createHmac('sha256', env.ENCRYPTION_SECRET).update(payload).digest('hex');
    const params = new URLSearchParams({
      key,
      expires: String(expires),
      sig,
    });
    if (contentType) params.set('contentType', contentType);
    return `/uploads/local?${params.toString()}`;
  }

  verifyLocalSignature(method: 'PUT' | 'GET', key: string, expires: string, sig: string, contentType?: string): boolean {
    const expNum = Number(expires);
    if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) {
      return false;
    }
    const payload = `${method}:${key}:${expNum}:${contentType || ''}`;
    const expected = crypto.createHmac('sha256', env.ENCRYPTION_SECRET).update(payload).digest('hex');
    if (expected.length !== sig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }

  /**
   * Generates a presigned URL for client upload.
   */
  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds: number = 900
  ): Promise<{ url: string; key: string }> {
    const url = this.hasAwsCredentials()
      ? this.buildAwsSigV4Url('PUT', key, expiresInSeconds, contentType)
      : this.signLocalUrl('PUT', key, expiresInSeconds, contentType);
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
    if (this.hasAwsCredentials()) {
      return this.buildAwsSigV4Url('GET', key, expiresInSeconds);
    }
    return this.signLocalUrl('GET', key, expiresInSeconds);
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
