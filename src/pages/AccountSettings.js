import React, { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';

const AccountSettings = () => {
  const { user, saveProfile, updatePassword } = useAuth();
  const [profileForm, setProfileForm] = useState({
    firstName: '',
    lastName: '',
    organization: '',
    jobTitle: '',
    phone: '',
  });
  const [profileStatus, setProfileStatus] = useState('');
  const [profileError, setProfileError] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordStatus, setPasswordStatus] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  useEffect(() => {
    if (user) {
      setProfileForm({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        organization: user.organization || '',
        jobTitle: user.jobTitle || '',
        phone: user.phone || '',
      });
    }
  }, [user]);

  const handleProfileChange = (field, value) => {
    setProfileForm((prev) => ({ ...prev, [field]: value }));
  };

  const handlePasswordChange = (field, value) => {
    setPasswordForm((prev) => ({ ...prev, [field]: value }));
  };

  const submitProfile = async (event) => {
    event.preventDefault();
    setProfileStatus('');
    setProfileError('');

    try {
      setIsSavingProfile(true);
      await saveProfile(profileForm);
      setProfileStatus('Profile updated successfully.');
    } catch (err) {
      setProfileError(err.message || 'Unable to update profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const submitPassword = async (event) => {
    event.preventDefault();
    setPasswordStatus('');
    setPasswordError('');

    if (!passwordForm.currentPassword || !passwordForm.newPassword) {
      setPasswordError('Please fill out all password fields.');
      return;
    }

    if (passwordForm.newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters long.');
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }

    try {
      setIsUpdatingPassword(true);
      await updatePassword({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      setPasswordStatus('Password updated successfully.');
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setPasswordError(err.message || 'Unable to update password.');
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Account Settings</h1>
        <p className="text-gray-600 mt-2">Manage your personal information and security preferences.</p>
      </div>

      <section className="bg-white rounded-xl shadow-md p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Profile information</h2>
          <p className="text-sm text-gray-500 mt-1">Update the details associated with your account.</p>
        </div>

        {profileStatus && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {profileStatus}
          </div>
        )}

        {profileError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {profileError}
          </div>
        )}

        <form className="space-y-5" onSubmit={submitProfile}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">First name</label>
              <input
                type="text"
                value={profileForm.firstName}
                onChange={(e) => handleProfileChange('firstName', e.target.value)}
                className="w-full px-4 py-2 border rounded-lg"
                placeholder="Enter your first name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Last name</label>
              <input
                type="text"
                value={profileForm.lastName}
                onChange={(e) => handleProfileChange('lastName', e.target.value)}
                className="w-full px-4 py-2 border rounded-lg"
                placeholder="Enter your last name"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Organization</label>
              <input
                type="text"
                value={profileForm.organization}
                onChange={(e) => handleProfileChange('organization', e.target.value)}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Job Title</label>
              <input
                type="text"
                value={profileForm.jobTitle}
                onChange={(e) => handleProfileChange('jobTitle', e.target.value)}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
            <input
              type="tel"
              value={profileForm.phone}
              onChange={(e) => handleProfileChange('phone', e.target.value)}
              className="w-full px-4 py-2 border rounded-lg"
            />
          </div>

          <button
            type="submit"
            className="px-6 py-2 rounded-lg text-white font-semibold"
            style={{ backgroundColor: '#019348' }}
            disabled={isSavingProfile}
          >
            {isSavingProfile ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </section>

      <section className="bg-white rounded-xl shadow-md p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Security</h2>
          <p className="text-sm text-gray-500 mt-1">Change your password to keep your account secure.</p>
        </div>

        {passwordStatus && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {passwordStatus}
          </div>
        )}

        {passwordError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {passwordError}
          </div>
        )}

        <form className="space-y-4" onSubmit={submitPassword}>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Current password</label>
            <input
              type="password"
              value={passwordForm.currentPassword}
              onChange={(e) => handlePasswordChange('currentPassword', e.target.value)}
              className="w-full px-4 py-2 border rounded-lg"
              autoComplete="current-password"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">New password</label>
              <input
                type="password"
                value={passwordForm.newPassword}
                onChange={(e) => handlePasswordChange('newPassword', e.target.value)}
                className="w-full px-4 py-2 border rounded-lg"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Confirm new password</label>
              <input
                type="password"
                value={passwordForm.confirmPassword}
                onChange={(e) => handlePasswordChange('confirmPassword', e.target.value)}
                className="w-full px-4 py-2 border rounded-lg"
                autoComplete="new-password"
              />
            </div>
          </div>

          <button
            type="submit"
            className="px-6 py-2 rounded-lg text-white font-semibold"
            style={{ backgroundColor: '#019348' }}
            disabled={isUpdatingPassword}
          >
            {isUpdatingPassword ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </section>
    </div>
  );
};

export default AccountSettings;
