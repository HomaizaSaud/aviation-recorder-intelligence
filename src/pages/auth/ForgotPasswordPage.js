import React, { useState } from 'react';
import { Link } from 'react-router-dom';

const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!email) {
      return;
    }

    setSubmitted(true);
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
              <p className="text-gray-600">Enter your email and we'll send you a password reset link.</p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit}>
              <div>
                <label className="block text-sm font-medium mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg"
                  placeholder="Enter your email"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full text-white py-3 rounded-lg font-semibold shadow-md"
                style={{ backgroundColor: '#019348' }}
              >
                Send request
              </button>
            </form>

            {submitted && (
              <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                If an account exists for {email}, a reset link has been sent.
              </div>
            )}

            <div className="mt-6 text-center text-sm">
              <Link to="/login" className="font-semibold hover:underline" style={{ color: '#019348' }}>
                Back to Login
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;
