import request from './client';

export const createUploadTarget = async ({ caseNumber, attachmentType, fileName, contentType, channel }) =>
  request('/storage/presign', {
    method: 'POST',
    body: JSON.stringify({ caseNumber, attachmentType, fileName, contentType, channel }),
  });

export const createDownloadTarget = async ({ bucket, objectKey, fileName, contentType }) =>
  request('/storage/download', {
    method: 'POST',
    body: JSON.stringify({ bucket, objectKey, fileName, contentType }),
  });

export const deleteObjectFromStorage = async ({ bucket, objectKey }) =>
  request('/storage/delete', {
    method: 'POST',
    body: JSON.stringify({ bucket, objectKey }),
  });

export default {
  createUploadTarget,
  createDownloadTarget,
  deleteObjectFromStorage,
};
