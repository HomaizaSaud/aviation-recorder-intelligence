import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { changePassword, fetchCurrentUser, login as loginRequest, signup as signupRequest, updateProfile } from '../api/auth';

const AuthContext = createContext(null);

const getStoredToken = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem('authToken');
};

const persistToken = (token) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (token) {
    window.localStorage.setItem('authToken', token);
  } else {
    window.localStorage.removeItem('authToken');
  }
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(getStoredToken);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const bootstrap = async () => {
      const storedToken = getStoredToken();
      if (!storedToken) {
        setLoading(false);
        return;
      }

      try {
        const profile = await fetchCurrentUser();
        setUser(profile);
        setError('');
      } catch (err) {
        persistToken(null);
        setToken(null);
        setUser(null);
        setError('');
      } finally {
        setLoading(false);
      }
    };

    bootstrap();
  }, []);

  const applySession = useCallback((sessionToken, sessionUser) => {
    persistToken(sessionToken);
    setToken(sessionToken);
    setUser(sessionUser);
  }, []);

  const login = useCallback(async (credentials) => {
    const { token: sessionToken, user: sessionUser } = await loginRequest(credentials);
    applySession(sessionToken, sessionUser);
    setError('');
    return sessionUser;
  }, [applySession]);

  const signup = useCallback(async (payload) => {
    const { token: sessionToken, user: sessionUser } = await signupRequest(payload);
    applySession(sessionToken, sessionUser);
    setError('');
    return sessionUser;
  }, [applySession]);

  const logout = useCallback(() => {
    persistToken(null);
    setToken(null);
    setUser(null);
    setError('');
  }, []);

  const refreshProfile = useCallback(async () => {
    const profile = await fetchCurrentUser();
    setUser(profile);
    return profile;
  }, []);

  const saveProfile = useCallback(async (updates) => {
    const updated = await updateProfile(updates);
    setUser(updated);
    return updated;
  }, []);

  const updatePassword = useCallback(async (payload) => {
    await changePassword(payload);
  }, []);

  const value = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: Boolean(user),
      isLoading: loading,
      error,
      login,
      signup,
      logout,
      refreshProfile,
      saveProfile,
      updatePassword,
    }),
    [error, loading, login, logout, refreshProfile, saveProfile, signup, token, updatePassword, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
};
