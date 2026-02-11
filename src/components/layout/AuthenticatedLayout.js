import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, matchPath, useLocation, useNavigate } from 'react-router-dom';
import {
  AudioLines,
  Bell,
  Mic,
  ChevronDown,
  FileBarChart,
  FileText,
  HelpCircle,
  Home,
  PlaneTakeoff,
  Workflow,
} from 'lucide-react';
import { fetchCases } from '../../api/cases';
import { createDownloadTarget } from '../../api/storage';
import { useAuth } from '../../hooks/useAuth';
import { normalizeCaseRecord } from '../../utils/statuses';

const NOTIFICATION_TYPES = new Set([
  'report_export',
  'fdr_detection_completed',
  'fdr_upload',
  'case_updated',
  'cvr_analysis_started',
  'cvr_step_completed',
  'cvr_step_failed',
  'cvr_analysis_completed',
]);

const isSuccessTimelineEntry = (entry) => {
  if (entry?.kind !== 'fdr_detection_completed') {
    return true;
  }

  const statusEntry = Array.isArray(entry.metadata)
    ? entry.metadata.find((item) => item?.label === 'Status')
    : null;

  if (!statusEntry) {
    return true;
  }

  return statusEntry.value === 'Success';
};

const buildNotificationAction = (caseNumber, entry) => {
  if (entry?.kind === 'report_export' && entry?.links?.download?.objectKey) {
    return {
      type: 'download',
      label: 'Download report',
      download: entry.links.download,
    };
  }

  if (entry?.kind === 'case_updated') {
    return {
      type: 'navigate',
      label: 'View case',
      url: entry?.links?.caseUrl || `/cases/${caseNumber}`,
    };
  }

  const resultsUrl =
    entry?.links?.resultsUrl ||
    (entry?.kind === 'fdr_upload' || entry?.kind === 'fdr_detection_completed'
      ? `/cases/${caseNumber}/fdr`
      : entry?.kind?.startsWith('cvr_')
        ? `/cases/${caseNumber}/cvr`
        : `/cases/${caseNumber}`);

  return {
    type: 'navigate',
    label: 'Open results',
    url: resultsUrl,
  };
};

const buildNotificationsFromCases = (caseList) => {
  if (!Array.isArray(caseList)) {
    return [];
  }

  const items = [];

  caseList.forEach((caseItem) => {
    const timeline = Array.isArray(caseItem?.timeline) ? caseItem.timeline : [];
    const caseNumber = caseItem?.caseNumber || 'Unknown case';
    const caseName = caseItem?.caseName ? ` · ${caseItem.caseName}` : '';

    timeline
      .filter((entry) => entry?.kind && NOTIFICATION_TYPES.has(entry.kind))
      .filter((entry) => isSuccessTimelineEntry(entry))
      .forEach((entry) => {
        const action = buildNotificationAction(caseNumber, entry);
        let title = entry.action || 'Update recorded';
        let description = `${caseNumber}${caseName}`;

        if (entry.kind === 'report_export') {
          title = 'New report generated';
          description = `Report exported for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'fdr_detection_completed') {
          title = 'FDR analysis completed';
          description = `Behavioral analysis finished for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'fdr_upload') {
          title = 'FDR upload completed';
          description = `New FDR data uploaded for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'case_updated') {
          title = 'Case updated';
          description = `Details updated for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'cvr_analysis_started') {
          title = 'CVR analysis started';
          description = `CVR pipeline started for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'cvr_step_completed') {
          title = 'CVR step completed';
          description = entry.action || `CVR step completed for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'cvr_step_failed') {
          title = 'CVR step failed';
          description = entry.action || `CVR step failed for ${caseNumber}${caseName}`;
        } else if (entry.kind === 'cvr_analysis_completed') {
          title = 'CVR analysis completed';
          description = `CVR analysis completed for ${caseNumber}${caseName}`;
        }

        items.push({
          id: `${caseNumber}-${entry.id}`,
          title,
          description,
          timestamp: entry.timestamp,
          action,
          module: entry?.kind?.startsWith('cvr_') ? 'CVR' : 'FDR',
        });
      });
  });

  return items
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, 6);
};

const MODULE_KEYS = new Set(['fdr', 'cvr', 'correlate']);

export const isCasesNavActive = (pathname) => {
  if (matchPath({ path: '/cases', end: true }, pathname)) {
    return true;
  }

  const caseMatch = matchPath({ path: '/cases/:caseNumber', end: true }, pathname);
  if (!caseMatch) {
    return false;
  }

  const { caseNumber } = caseMatch.params;
  return !MODULE_KEYS.has(caseNumber);
};

export const isModuleNavActive = (pathname, moduleKey) => {
  if (matchPath({ path: `/cases/${moduleKey}`, end: true }, pathname)) {
    return true;
  }

  return Boolean(matchPath({ path: `/cases/:caseNumber/${moduleKey}`, end: false }, pathname));
};

const navigationLinks = [
  {
    to: '/',
    icon: Home,
    label: 'Home',
    isActive: (pathname) => matchPath({ path: '/', end: true }, pathname),
  },
  {
    to: '/cases',
    icon: FileText,
    label: 'Cases',
    isActive: isCasesNavActive,
  },
  {
    to: '/cases/fdr',
    icon: PlaneTakeoff,
    label: 'FDR Module',
    isActive: (pathname) => isModuleNavActive(pathname, 'fdr'),
  },
  {
    to: '/cases/cvr',
    icon: AudioLines,
    label: 'CVR Module',
    isActive: (pathname) => isModuleNavActive(pathname, 'cvr'),
  },
  {
    to: '/cases/correlate',
    icon: Workflow,
    label: 'Correlate FDR & CVR',
    isActive: (pathname) => isModuleNavActive(pathname, 'correlate'),
  },
  {
    to: '/reports',
    icon: FileBarChart,
    label: 'Generate Reports',
    isActive: (pathname) => matchPath({ path: '/reports', end: false }, pathname),
  },
];

const AuthenticatedLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notificationsError, setNotificationsError] = useState('');
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [downloadingNotificationId, setDownloadingNotificationId] = useState('');

  const initials = (user?.firstName || user?.email || '?').charAt(0).toUpperCase();
  const displayName = user?.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : user?.email;

  const formatNotificationTimestamp = (value) => {
    if (!value) {
      return '—';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return typeof value === 'string' ? value : '—';
    }

    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed);
  };

  const loadNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    setNotificationsError('');
    try {
      const response = await fetchCases();
      const data = Array.isArray(response) ? response : response?.data;
      const normalized = Array.isArray(data) ? data.map(normalizeCaseRecord) : [];
      setNotifications(buildNotificationsFromCases(normalized));
    } catch (error) {
      setNotificationsError(error.message || 'Unable to load notifications.');
      setNotifications([]);
    } finally {
      setNotificationsLoading(false);
    }
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleAccountSettings = () => {
    navigate('/account');
    setShowUserMenu(false);
  };

  const handleNotificationAction = async (notification) => {
    if (!notification?.action) {
      return;
    }

    if (notification.action.type === 'download') {
      const download = notification.action.download;
      if (!download?.objectKey) {
        setNotificationsError('No download is available for this report.');
        return;
      }

      setDownloadingNotificationId(notification.id);
      setNotificationsError('');
      try {
        const target = await createDownloadTarget({
          bucket: download.bucket,
          objectKey: download.objectKey,
          fileName: download.fileName,
          contentType: download.contentType,
        });
        window.open(target.downloadUrl, '_blank', 'noopener,noreferrer');
      } catch (error) {
        setNotificationsError(error.message || 'Unable to download the report.');
      } finally {
        setDownloadingNotificationId('');
      }
      return;
    }

    if (notification.action.type === 'navigate' && notification.action.url) {
      navigate(notification.action.url);
      setShowNotifications(false);
    }
  };

  useEffect(() => {
    if (showNotifications) {
      loadNotifications();
    }
  }, [loadNotifications, showNotifications]);

  const notificationCount = useMemo(
    () => (notificationsLoading ? 0 : notifications.length),
    [notifications.length, notificationsLoading],
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="px-6 py-4">
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex items-center gap-3 shrink-0 focus:outline-none bg-transparent border-0 p-0"
            >
              <img src="/toplogo.png" alt="CVR/FDR Analyzer logo" className="h-10 w-auto" />
              <h1 className="text-2xl font-bold" style={{ color: '#019348' }}>
                CVR/FDR Analyzer
              </h1>
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-4 ml-auto">
              <button
                type="button"
                onClick={() => navigate('/help')}
                className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:text-emerald-600"
              >
                <HelpCircle className="w-5 h-5" /> Help Center
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowNotifications((prev) => !prev)}
                  className="relative p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  <Bell className="w-6 h-6" />
                  {notificationCount > 0 && (
                    <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
                  )}
                </button>
                {showNotifications && (
                  <div className="absolute right-0 mt-2 w-96 bg-white rounded-lg shadow-xl border py-2">
                    <div className="px-4 py-2 border-b font-semibold">Notifications</div>
                    {notificationsError && (
                      <div className="px-4 py-3 text-xs text-rose-600 border-b bg-rose-50">
                        {notificationsError}
                      </div>
                    )}
                    {notificationsLoading ? (
                      <div className="px-4 py-6 text-sm text-gray-500">Loading updates…</div>
                    ) : notifications.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-gray-500">No recent activity yet.</div>
                    ) : (
                      notifications.map((notification) => (
                        <button
                          key={notification.id}
                          type="button"
                          onClick={() => handleNotificationAction(notification)}
                          className="w-full px-4 py-3 text-left hover:bg-gray-50 border-b last:border-b-0"
                          disabled={downloadingNotificationId === notification.id}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="font-medium text-sm text-gray-900">
                                {notification.title}
                                {notification.module && (
                                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                                    {notification.module === "CVR" ? <Mic className="h-3 w-3" /> : <PlaneTakeoff className="h-3 w-3" />}
                                    {notification.module}
                                  </span>
                                )}
                              </div>
                              <div className="text-gray-600 text-xs mt-1">
                                {notification.description}
                              </div>
                              <div className="text-gray-400 text-xs mt-1">
                                {formatNotificationTimestamp(notification.timestamp)}
                              </div>
                            </div>
                            {notification.action?.label && (
                              <span className="text-[11px] font-semibold uppercase text-emerald-600 mt-0.5">
                                {downloadingNotificationId === notification.id
                                  ? 'Preparing…'
                                  : notification.action.label}
                              </span>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowUserMenu((prev) => !prev)}
                  className="flex items-center space-x-2 p-2 hover:bg-gray-100 rounded-lg"
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold"
                    style={{ backgroundColor: '#019348' }}
                  >
                    {initials}
                  </div>
                  <span className="text-gray-700 font-medium truncate max-w-[140px]">{displayName}</span>
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                </button>
                {showUserMenu && (
                  <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-xl border py-2">
                    <button
                      type="button"
                      onClick={handleAccountSettings}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50"
                    >
                      Account settings
                    </button>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-50"
                    >
                      Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="w-64 bg-white border-r min-h-screen">
          <nav className="p-4 space-y-2">
            {navigationLinks.map(({ to, icon: Icon, label, isActive }) => {
              const active = isActive(location.pathname);
              return (
                <Link
                  key={to}
                  to={to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex w-full items-center space-x-3 px-4 py-3 rounded-lg font-medium transition-colors ${
                    active ? 'text-white shadow' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                  style={active ? { backgroundColor: '#019348' } : undefined}
                >
                  <Icon className="w-5 h-5" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="flex-1 p-8">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default AuthenticatedLayout;
