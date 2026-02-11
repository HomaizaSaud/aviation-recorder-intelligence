const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

export const formatFileSize = (bytes) => {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) {
    return '';
  }

  let size = Number(bytes);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${SIZE_UNITS[unitIndex]}`;
};

const EXTENSION_CONTENT_TYPES = {
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  txt: 'text/plain',
};

const bufferToHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const calculateFileChecksum = async (file) => {
  if (!file || typeof file.arrayBuffer !== 'function' || !crypto?.subtle?.digest) {
    throw new Error('Unable to calculate checksum for the selected file.');
  }

  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hashBuffer);
};

export const inferContentType = (file) => {
  if (!file) {
    return 'application/octet-stream';
  }

  if (file.type && typeof file.type === 'string' && file.type.trim()) {
    return file.type;
  }

  const name = typeof file.name === 'string' ? file.name : '';
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (extension && EXTENSION_CONTENT_TYPES[extension]) {
    return EXTENSION_CONTENT_TYPES[extension];
  }

  return 'application/octet-stream';
};

export default {
  formatFileSize,
  calculateFileChecksum,
  inferContentType,
};