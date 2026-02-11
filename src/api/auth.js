import request from './client';

export const login = async (credentials) =>
  request('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });

export const signup = async (payload) =>
  request('/auth/signup', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const fetchCurrentUser = async () => {
  const result = await request('/account/me');
  return result?.user || null;
};

export const updateProfile = async (updates) => {
  const result = await request('/account/me', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

  return result?.user || null;
};

export const changePassword = async (payload) =>
  request('/account/password', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
