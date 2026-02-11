import {
  createDownloadTarget,
  createUploadTarget,
  deleteObjectFromStorage,
} from '../api/storage';
import { calculateFileChecksum, inferContentType } from './files';

const SUPPORTED_ATTACHMENT_TYPES = new Set(['FDR', 'CVR']);

const normalizeAttachmentType = (attachmentType) =>
  typeof attachmentType === 'string' ? attachmentType.trim().toUpperCase() : '';

const buildUploadHeaders = (responseHeaders = {}, fallbackContentType) => {
  const normalized = { ...responseHeaders };
  const hasContentType = Object.keys(normalized).some(
    (key) => key.toLowerCase() === 'content-type',
  );

  if (!hasContentType && fallbackContentType) {
    normalized['Content-Type'] = fallbackContentType;
  }

  return normalized;
};

export const uploadAttachmentToObjectStore = async ({
  caseNumber,
  attachmentType,
  channel,
  file,
  signal,
  existingAttachments = [],
}) => {
  if (!file) {
    throw new Error('A file must be provided to upload to object storage.');
  }

  if (!caseNumber) {
    throw new Error('A case number is required before uploading attachments.');
  }

  const normalizedAttachmentType = normalizeAttachmentType(attachmentType);
  if (!SUPPORTED_ATTACHMENT_TYPES.has(normalizedAttachmentType)) {
    throw new Error('Attachment type must be either "FDR" or "CVR".');
  }

  const contentType = inferContentType(file);
  const checksum = await calculateFileChecksum(file);

  const hasDuplicate = existingAttachments.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }

    const existingChecksum = item.checksum || item.sha256 || item.hash;
    if (existingChecksum && existingChecksum === checksum) {
      return true;
    }

    const existingSize = Number(item.sizeBytes ?? item.size);
    const matchesNameAndSize =
      Number.isFinite(existingSize) &&
      existingSize === file.size &&
      typeof item.name === 'string' &&
      item.name === file.name;

    return matchesNameAndSize;
  });

  if (hasDuplicate) {
    const error = new Error('This file appears to have already been uploaded for this case.');
    error.code = 'DUPLICATE_ATTACHMENT';
    throw error;
  }
  const uploadTarget = await createUploadTarget({
    caseNumber,
    attachmentType: normalizedAttachmentType,
    fileName: file.name,
    contentType,
    channel,
  });

  const headers = buildUploadHeaders(uploadTarget.headers || {}, contentType);

  const response = await fetch(uploadTarget.uploadUrl, {
    method: uploadTarget.method || 'PUT',
    headers,
    body: file,
    signal,
  });

  if (!response.ok) {
    const message = `Object storage upload failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return {
    storage: {
      provider: 'minio',
      bucket: uploadTarget.bucket,
      objectKey: uploadTarget.objectKey,
      endpoint: uploadTarget.storageEndpoint || null,
    },
    contentType,
    uploadedAt: new Date().toISOString(),
    checksum,
  };
};

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

export const fetchAttachmentFromObjectStore = async ({
  bucket,
  objectKey,
  fileName,
  contentType,
  signal,
}) => {
  if (!objectKey) {
    throw new Error('An objectKey is required to download from object storage.');
  }

  const candidates = normalizeObjectKeyCandidates(objectKey, bucket);
  const errors = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidateKey = candidates[i];
    try {
      const downloadTarget = await createDownloadTarget({
        bucket,
        objectKey: candidateKey,
        fileName,
        contentType,
      });

      const response = await fetch(downloadTarget.downloadUrl, { signal });
      if (!response.ok) {
        const message = `Object storage download failed with status ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }

      return response.text();
    } catch (error) {
      errors.push(error);
      if (signal?.aborted) {
        break;
      }
    }
  }

  const lastError = errors[errors.length - 1];
  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to download attachment from object storage.');
};

export const deleteAttachmentFromObjectStore = async ({ bucket, objectKey }) => {
  if (!objectKey) {
    throw new Error('An objectKey is required to delete from object storage.');
  }

  await deleteObjectFromStorage({ bucket, objectKey });
};

export default {
  uploadAttachmentToObjectStore,
  fetchAttachmentFromObjectStore,
  deleteAttachmentFromObjectStore,
};
