const crypto = require('crypto');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const slugify = require('../utils/slugify');

const DEFAULT_BUCKET = 'cvr-fdr-data';
const DEFAULT_REGION = 'us-east-1';
const MAX_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,            // e.g. http://192.168.10.15:9000
  region: process.env.MINIO_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

async function ensureBucketExists(bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    // bucket exists
  } catch (err) {
    // Create if missing (for MinIO this is safe)
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } else {
      throw err;
    }
  }
}

async function initializeStorage() {
  const config = getConfig();       // validates env and builds base URLs
  await ensureBucketExists(config.bucket);
}

const encodeRfc3986 = (value) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, '~');

const hmacSha256 = (key, value, encoding) =>
  crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);

const hashSha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const parseEndpoint = () => {
  const rawEndpoint = (process.env.MINIO_ENDPOINT || '').trim();
  if (!rawEndpoint) {
    throw new Error('MINIO_ENDPOINT environment variable is required for object storage integration.');
  }

  try {
    const withProtocol = rawEndpoint.includes('://') ? rawEndpoint : `http://${rawEndpoint}`;
    const parsed = new URL(withProtocol);
    return {
      protocol: parsed.protocol.replace(':', ''),
      hostname: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
    };
  } catch (error) {
    throw new Error(`Unable to parse MINIO_ENDPOINT value "${rawEndpoint}": ${error.message}`);
  }
};

const resolvePort = (protocol, explicitPort) => {
  if (Number.isInteger(explicitPort) && explicitPort > 0) {
    return explicitPort;
  }

  if (process.env.MINIO_PORT) {
    const parsed = Number.parseInt(process.env.MINIO_PORT, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (protocol === 'https') {
    return 443;
  }

  return 9000;
};

let cachedConfig = null;

const buildConfig = () => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const accessKey = (process.env.MINIO_ACCESS_KEY || '').trim();
  const secretKey = (process.env.MINIO_SECRET_KEY || '').trim();
  if (!accessKey || !secretKey) {
    throw new Error('Both MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be configured for object storage integration.');
  }

  const { protocol: parsedProtocol, hostname, port: endpointPort } = parseEndpoint();
  const useSsl = parseBoolean(process.env.MINIO_USE_SSL, parsedProtocol === 'https');
  const protocol = useSsl ? 'https' : 'http';
  const port = resolvePort(protocol, endpointPort);
  const defaultPort = protocol === 'https' ? 443 : 80;
  const hostHeader = port && port !== defaultPort ? `${hostname}:${port}` : hostname;

  const bucket = (process.env.MINIO_BUCKET || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET;
  const region = (process.env.MINIO_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION;

  const uploadExpiry = Number.parseInt(process.env.MINIO_UPLOAD_EXPIRY_SECONDS || '', 10);
  const downloadExpiry = Number.parseInt(process.env.MINIO_DOWNLOAD_EXPIRY_SECONDS || '', 10);

  const normalizeExpiry = (value, fallback) => {
    if (Number.isNaN(value) || value <= 0) {
      return fallback;
    }

    return Math.min(value, MAX_EXPIRY_SECONDS);
  };

  const baseUrl = `${protocol}://${hostHeader}`;
  const publicBaseUrl = (process.env.MINIO_PUBLIC_BASE_URL || '').trim() || baseUrl;

  cachedConfig = {
    accessKey,
    secretKey,
    protocol,
    hostname,
    port,
    hostHeader,
    bucket,
    region,
    uploadExpiry: normalizeExpiry(uploadExpiry, 900),
    downloadExpiry: normalizeExpiry(downloadExpiry, 3600),
    baseUrl,
    publicBaseUrl,
  };

  return cachedConfig;
};

const getConfig = () => buildConfig();

const canonicalUri = (bucket, objectKey) => {
  const sanitizedKey = objectKey.replace(/^\/+/, '');
  if (!sanitizedKey) {
    return `/${encodeRfc3986(bucket)}`;
  }

  const encodedSegments = sanitizedKey
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');

  return `/${encodeRfc3986(bucket)}/${encodedSegments}`;
};

const buildCredentialScope = (dateStamp, region) => `${dateStamp}/${region}/s3/aws4_request`;

const getSigningKey = (secretKey, dateStamp, region) => {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 's3');
  return hmacSha256(kService, 'aws4_request');
};

const buildQueryString = (params) =>
  Object.keys(params)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(String(params[key]))}`)
    .join('&');

const normalizeHeadersForSigning = (headers = {}) => {
  const normalized = {};

  Object.keys(headers).forEach((key) => {
    if (!key) {
      return;
    }

    const headerName = key.trim().toLowerCase();
    if (!headerName) {
      return;
    }

    const headerValue = headers[key];
    if (headerValue === undefined || headerValue === null) {
      return;
    }

    normalized[headerName] = String(headerValue).trim().replace(/\s+/g, ' ');
  });

  return normalized;
};

const createPresignedUrl = (
  method,
  objectKey,
  expiresInSeconds,
  { extraQuery = {}, extraHeaders = {} } = {},
) => {
  const config = getConfig();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\..+/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = buildCredentialScope(dateStamp, config.region);
  const credential = `${config.accessKey}/${credentialScope}`;

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': Math.min(expiresInSeconds, MAX_EXPIRY_SECONDS),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  };

  const signingHeaders = {
    host: config.hostHeader,
    ...normalizeHeadersForSigning(extraHeaders),
  };

  const sortedHeaderNames = Object.keys(signingHeaders).sort();
  query['X-Amz-SignedHeaders'] = sortedHeaderNames.join(';');

  const canonicalQuery = buildQueryString(query);
  const canonicalHeaders = `${sortedHeaderNames
    .map((header) => `${header}:${signingHeaders[header]}`)
    .join('\n')}\n`;
  const signedHeaders = query['X-Amz-SignedHeaders'];
  const requestPayload = 'UNSIGNED-PAYLOAD';
  const uri = canonicalUri(config.bucket, objectKey);

  const canonicalRequest = [
    method.toUpperCase(),
    uri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    requestPayload,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashSha256(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(config.secretKey, dateStamp, config.region);
  const signature = hmacSha256(signingKey, stringToSign, 'hex');

  const finalQuery = `${canonicalQuery}&X-Amz-Signature=${signature}`;

  return `${config.baseUrl}${uri}?${finalQuery}`;
};

const generateObjectKey = ({ caseNumber, attachmentType, fileName, channel }) => {
  const extension = path.extname(fileName || '').toLowerCase();
  const baseName = path.basename(fileName || 'attachment', extension);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const randomSuffix = crypto.randomBytes(6).toString('hex');

  const safeCase = slugify(caseNumber || 'case');
  const safeType = slugify((attachmentType || 'data').toString());
  const safeName = slugify(baseName || 'attachment');
  const safeChannel = channel ? slugify(channel) : '';

  const channelSegment = safeChannel ? `/${safeChannel}` : '';
  const channelPrefix = safeChannel ? `${safeChannel}-` : '';
  return `cases/${safeCase}/${safeType}${channelSegment}/${timestamp}-${randomSuffix}-${channelPrefix}${safeName}${extension}`;
};

// const initializeStorage = async () => {
//   getConfig();
// };

async function createPresignedUpload({ caseNumber, attachmentType, fileName, contentType, channel }) {
  const config = getConfig();
  const key = generateObjectKey({ caseNumber, attachmentType, fileName, channel });

  const put = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ...(contentType ? { ContentType: contentType } : {})
  });
  const uploadUrl = await getSignedUrl(s3, put, { expiresIn: config.uploadExpiry });

//   const safeFileName = (fileName || 'attachment').replace(/"/g, '');
//   const downloadQuery = {
//     'response-content-disposition': `attachment; filename="${safeFileName}"`,
//   };
const get = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${(fileName || 'attachment').replace(/"/g, '')}"`,
    ...(contentType ? { ResponseContentType: contentType } : {})
  });
  const downloadUrl = await getSignedUrl(s3, get, { expiresIn: config.downloadExpiry });

  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;

  return {
    method: 'PUT',
    bucket: config.bucket,
    objectKey: key,
    uploadUrl,
    downloadUrl,
    expiresIn: config.uploadExpiry,
    headers,                       // usually {}
    storageEndpoint: config.publicBaseUrl,
  };
}

async function createPresignedDownload({ bucket, objectKey, fileName, contentType }) {
  const config = getConfig();
  const bucketName = (bucket || '').trim() || config.bucket;
  const safeFileName = (fileName || 'attachment').replace(/"/g, '');
  const trimmedKey = (objectKey || '').replace(/^\/+/, '');
  const normalizedKey = trimmedKey.startsWith(`${bucketName}/`) ? trimmedKey.slice(bucketName.length + 1) : trimmedKey;

  const get = new GetObjectCommand({
    Bucket: bucketName,
    Key: normalizedKey,
    ResponseContentDisposition: `attachment; filename="${safeFileName}"`,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });

  const downloadUrl = await getSignedUrl(s3, get, { expiresIn: config.downloadExpiry });

  return {
    method: 'GET',
    bucket: bucketName,
    objectKey,
    downloadUrl,
    expiresIn: config.downloadExpiry,
    storageEndpoint: config.publicBaseUrl,
  };
}

async function uploadReportBuffer({ caseNumber, fileName, contentType, body }) {
  if (!body) {
    const error = new Error('Report content is required for upload.');
    error.status = 400;
    throw error;
  }

  const config = getConfig();
  const objectKey = generateObjectKey({ caseNumber, attachmentType: 'report', fileName });

  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );

  const download = await createPresignedDownload({
    bucket: config.bucket,
    objectKey,
    fileName,
    contentType,
  });

  return {
    bucket: config.bucket,
    objectKey,
    storageUrl: config.publicBaseUrl,
    downloadUrl: download.downloadUrl,
  };
}

async function deleteObject({ bucket, objectKey }) {
  if (!objectKey) {
    const error = new Error('objectKey is required to delete from object storage.');
    error.status = 400;
    throw error;
  }

  const config = getConfig();
  const bucketName = (bucket || '').trim() || config.bucket;

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: objectKey.replace(/^\/+/, ''),
      }),
    );
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || status === 403) {
      return;
    }

    throw error;
  }
}

async function objectExists({ bucket, objectKey }) {
  if (!objectKey) {
    return false;
  }

  const config = getConfig();
  const bucketName = (bucket || '').trim() || config.bucket;

  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      }),
    );
    return true;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    const code = (error?.Code || error?.name || '').toLowerCase();
    if (status === 404 || status === 403 || code === 'notfound' || code === 'nosuchkey') {
      return false;
    }

    throw error;
  }
}

const normalizeObjectKeyCandidates = (objectKey, bucket) => {
  const candidates = new Set();
  const trimmed = (objectKey || '').replace(/^\/+/, '');

  if (trimmed) {
    candidates.add(trimmed);

    if (bucket && trimmed.startsWith(`${bucket}/`)) {
      candidates.add(trimmed.slice(bucket.length + 1));
    }

    try {
      const decoded = decodeURIComponent(trimmed);
      candidates.add(decoded);

      if (bucket && decoded.startsWith(`${bucket}/`)) {
        candidates.add(decoded.slice(bucket.length + 1));
      }
    } catch (_error) {
      // ignore decode failures and fall back to original values
    }
  }

  return Array.from(candidates).filter(Boolean);
};

const readObjectBodyAsBuffer = async (body) => {
  if (!body) {
    throw new Error('Unable to read object body from storage response.');
  }

  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (typeof body.transformToString === 'function') {
    const text = await body.transformToString();
    return Buffer.from(text, 'utf-8');
  }

  const chunks = [];
  for await (const chunk of body) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
};

async function downloadObjectAsBuffer({ bucket, objectKey }) {
  if (!objectKey) {
    const error = new Error('objectKey is required to download from object storage.');
    error.status = 400;
    throw error;
  }

  const config = getConfig();
  const bucketName = (bucket || '').trim() || config.bucket;
  const candidates = normalizeObjectKeyCandidates(objectKey, bucketName);
  const errors = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidateKey = candidates[i];
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: candidateKey,
        }),
      );

      return await readObjectBodyAsBuffer(response?.Body);
    } catch (error) {
      errors.push(error);
    }
  }

  const lastError = errors[errors.length - 1];
  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to download object from storage.');
}

async function downloadObjectAsString({ bucket, objectKey }) {
  const buffer = await downloadObjectAsBuffer({ bucket, objectKey });
  return buffer.toString('utf-8');
}

async function uploadObjectBuffer({ bucket, objectKey, body, contentType }) {
  if (!objectKey) {
    const error = new Error('objectKey is required to upload to object storage.');
    error.status = 400;
    throw error;
  }

  const config = getConfig();
  const bucketName = (bucket || '').trim() || config.bucket;
  await ensureBucketExists(bucketName);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  );

  return { bucket: bucketName, objectKey };
}

module.exports = {
  initializeStorage,
  createPresignedUpload,
  createPresignedDownload,
  uploadReportBuffer,
  objectExists,
  deleteObject,
  downloadObjectAsString,
  downloadObjectAsBuffer,
  uploadObjectBuffer,
};
