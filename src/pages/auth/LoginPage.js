import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

const LoginPage = () => {
  const navigate = useNavigate();
  const { login, user, isLoading } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user) {
      navigate('/');
    }
  }, [isLoading, navigate, user]);

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.email || !form.password) {
      setError('Please provide both email and password.');
      return;
    }

    try {
      setIsSubmitting(true);
      await login(form);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Unable to login. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      <div
        className="w-1/2 relative flex flex-col justify-center items-center overflow-hidden"
        style={{
          minHeight: '100vh',
          backgroundImage: "url('/bg-pattern.png')",
          backgroundSize: '180%',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
        }}
      >
        <img src="/gcaa-logo.png" alt="GCAA Logo" className="h-40 object-contain" />
      </div>

      <div className="w-1/2 flex items-center justify-center p-8 bg-white">
        <div className="w-full max-w-md">
          <div className="p-8">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold mb-2" style={{ color: '#019348' }}>
                CVR/FDR Analyzer
              </h1>
              <p className="text-gray-600">Welcome back! Please login to your account.</p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit}>
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {error}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2"
                  placeholder="Enter your email"
                  autoComplete="email"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => handleChange('password', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2"
                    placeholder="Enter your password"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded"
                    style={{ accentColor: '#019348' }}
                  />
                  <span className="ml-2 text-sm">Remember me</span>
                </label>
                <Link to="/forgot-password" className="text-sm hover:underline" style={{ color: '#019348' }}>
                  Forgot Password
                </Link>
              </div>

              <button
                type="submit"
                className="w-full text-white py-3 rounded-lg font-semibold shadow-md"
                style={{ backgroundColor: '#019348' }}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Logging in…' : 'Login'}
              </button>
            </form>

            <div className="mt-6 text-center text-sm">
              <span>Don't have an account? </span>
              <Link to="/signup" className="font-semibold hover:underline" style={{ color: '#019348' }}>
                Sign up
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
