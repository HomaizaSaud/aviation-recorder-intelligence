const DEFAULT_API_PREFIX = '/api';

const trimTrailingSlashes = (value = '') => value.replace(/\/+$/, '');
const trimLeadingSlashes = (value = '') => value.replace(/^\/+/, '');

const normalizePrefix = (value) => {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed === '/') {
    return '';
  }

  const withoutSlashes = trimLeadingSlashes(trimTrailingSlashes(trimmed));

  return `/${withoutSlashes}`;
};

const resolveApiConfiguration = () => {
  const rawBase = (process.env.REACT_APP_API_BASE_URL || '').trim();
  const rawPrefix = process.env.REACT_APP_API_PREFIX;

  if (!rawBase) {
    return {
      base: '',
      prefix: normalizePrefix(rawPrefix) || DEFAULT_API_PREFIX,
    };
  }

  try {
    const url = new URL(rawBase);
    const base = `${url.protocol}//${url.host}`;
    const inferredPrefix = normalizePrefix(url.pathname);

    return {
      base,
      prefix: normalizePrefix(rawPrefix) || inferredPrefix || DEFAULT_API_PREFIX,
    };
  } catch (_error) {
    return {
      base: '',
      prefix: normalizePrefix(rawPrefix) || normalizePrefix(rawBase),
    };
  }
};

const { base: API_BASE_ORIGIN, prefix: API_PREFIX } = resolveApiConfiguration();

const buildRequestUrl = (path) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (API_BASE_ORIGIN) {
    return `${API_BASE_ORIGIN}${API_PREFIX}${normalizedPath}`;
  }

  return `${API_PREFIX}${normalizedPath}`;
};

const getStoredToken = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem('authToken');
};

export const buildAuthHeaders = (headers = {}) => {
  const nextHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (!nextHeaders.Authorization) {
    const token = getStoredToken();
    if (token) {
      nextHeaders.Authorization = `Bearer ${token}`;
    }
  }

  return nextHeaders;
};

const request = async (path, options = {}) => {
  const response = await fetch(buildRequestUrl(path), {
    ...options,
    headers: buildAuthHeaders(options.headers || {}),
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.message || payload?.details || payload?.error || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
};

export { buildRequestUrl };

export default request;
