import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

const SignupPage = () => {
  const navigate = useNavigate();
  const { signup, user, isLoading } = useAuth();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    organization: '',
    jobTitle: '',
  });
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
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

    if (!form.email || !form.password || !form.firstName) {
      setError('Please complete all required fields.');
      return;
    }

    if (form.password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (!agreeTerms) {
      setError('Please agree to the terms and conditions.');
      return;
    }

    try {
      setIsSubmitting(true);
      await signup({
        email: form.email,
        password: form.password,
        firstName: form.firstName,
        lastName: form.lastName,
        organization: form.organization,
        jobTitle: form.jobTitle,
      });
      navigate('/');
    } catch (err) {
      setError(err.message || 'Unable to create your account. Please try again.');
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
        <div className="w-full max-w-xl">
          <div className="p-8">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold mb-2" style={{ color: '#019348' }}>
                CVR/FDR Analyzer
              </h1>
              <p className="text-gray-600">Please complete the form to create your account.</p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit}>
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">First name</label>
                  <input
                    type="text"
                    value={form.firstName}
                    onChange={(e) => handleChange('firstName', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg"
                    placeholder="Enter your first name"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Last name</label>
                  <input
                    type="text"
                    value={form.lastName}
                    onChange={(e) => handleChange('lastName', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg"
                    placeholder="Enter your last name"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg"
                  placeholder="Enter your email"
                  autoComplete="email"
                  required
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Organization</label>
                  <input
                    type="text"
                    value={form.organization}
                    onChange={(e) => handleChange('organization', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg"
                    placeholder="Your organization"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Job Title</label>
                  <input
                    type="text"
                    value={form.jobTitle}
                    onChange={(e) => handleChange('jobTitle', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg"
                    placeholder="Your role"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => handleChange('password', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg"
                    placeholder="Create a strong password"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Confirm Password</label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={form.confirmPassword}
                    onChange={(e) => handleChange('confirmPassword', e.target.value)}
                    className="w-full px-4 py-3 border rounded-lg"
                    placeholder="Repeat your password"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2"
                  >
                    {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <label className="flex items-start">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                  className="w-4 h-4 rounded mt-1"
                  style={{ accentColor: '#019348' }}
                />
                <span className="ml-2 text-sm">I agree with terms and conditions</span>
              </label>

              <button
                type="submit"
                className="w-full text-white py-3 rounded-lg font-semibold shadow-md"
                style={{ backgroundColor: '#019348' }}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Creating account…' : 'Sign up'}
              </button>
            </form>

            <div className="mt-6 text-center text-sm">
              <span>Already have an account? </span>
              <Link to="/login" className="font-semibold hover:underline" style={{ color: '#019348' }}>
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignupPage;
