import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, Clock } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import MapCases from '../components/MapCases';
import { fetchCases } from '../api/cases';
import { useAuth } from '../hooks/useAuth';

const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const buildFallbackMonths = () => {
  const now = new Date();
  const monthKeys = [];

  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    monthKeys.push({
      key: monthKey,
      label: `${monthLabels[date.getMonth()]} ${date.getFullYear()}`,
    });
  }

  return monthKeys;
};

const buildMonthlyChartData = (casesList) => {
  const dateBuckets = casesList
    .map((caseItem) => caseItem.date || caseItem.lastUpdated || caseItem.updatedAt)
    .map((dateValue) => {
      if (!dateValue) {
        return null;
      }

      const parsedDate = new Date(dateValue);
      if (Number.isNaN(parsedDate.getTime())) {
        return null;
      }

      return parsedDate;
    })
    .filter(Boolean);

  const monthKeys = dateBuckets.length
    ? Array.from(
        new Set(
          dateBuckets.map(
            (parsedDate) =>
              `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}`,
          ),
        ),
      )
        .sort()
        .map((key) => {
          const [year, month] = key.split('-').map(Number);
          return {
            key,
            label: `${monthLabels[month - 1]} ${year}`,
          };
        })
    : buildFallbackMonths();

  const counts = monthKeys.reduce((acc, { key }) => {
    acc[key] = { cases: 0 };
    return acc;
  }, {});

  casesList.forEach((caseItem) => {
    const dateValue = caseItem.date || caseItem.lastUpdated || caseItem.updatedAt;
    if (!dateValue) {
      return;
    }

    const parsedDate = new Date(dateValue);
    if (Number.isNaN(parsedDate.getTime())) {
      return;
    }

    const monthKey = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}`;
    if (!counts[monthKey]) {
      return;
    }

    counts[monthKey].cases += 1;
  });

  return monthKeys.map(({ key, label }) => ({
    month: label,
    ...counts[key],
  }));
};

const actionCards = [
  {
    title: 'Analyze a new case',
    icon: Plus,
    onClickKey: 'startNewCase',
  },
  {
    title: 'Open a previous case',
    icon: FolderOpen,
    onClickKey: 'openCases',
  },
  {
    title: 'Open recent',
    icon: Clock,
    onClickKey: 'openRecent',
  },
];

const Dashboard = () => {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    const loadCases = async () => {
      setLoading(true);
      try {
        const response = await fetchCases();
        const data = Array.isArray(response) ? response : response?.data;
        setCases(Array.isArray(data) ? data : []);
      } catch (error) {
        setCases([]);
      } finally {
        setLoading(false);
      }
    };

    loadCases();
  }, []);

  const recentCases = useMemo(() => {
    const sorted = [...cases].sort((a, b) => {
      const dateA = a.lastUpdated || a.updatedAt;
      const dateB = b.lastUpdated || b.updatedAt;
      return new Date(dateB || 0) - new Date(dateA || 0);
    });

    return sorted.slice(0, 3);
  }, [cases]);

  const monthlyChartData = useMemo(() => buildMonthlyChartData(cases), [cases]);

  const handleAction = (key) => {
    if (key === 'startNewCase') {
      navigate('/cases', { state: { openNewCase: true } });
    }

    if (key === 'openCases') {
      navigate('/cases');
    }

    if (key === 'openRecent' && recentCases[0]) {
      navigate(`/cases/${recentCases[0].caseNumber}`);
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      <h2 className="text-3xl font-bold text-gray-800 mb-8">
        {user?.firstName ? `Welcome back, ${user.firstName}!` : 'Welcome back!'}
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {actionCards.map(({ title, icon: Icon, onClickKey }) => (
          <button
            key={title}
            type="button"
            onClick={() => handleAction(onClickKey)}
            className="text-white p-6 rounded-xl shadow-lg hover:shadow-xl transition-all flex flex-col items-start space-y-3"
            style={{ backgroundColor: '#019348' }}
          >
            <Icon className="w-10 h-10" />
            <h3 className="text-xl font-bold">{title}</h3>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-xl shadow-md p-6">
          <h3 className="text-lg font-bold mb-4">Cases per month</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={monthlyChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="cases" fill="#019348" name="Cases" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <MapCases cases={cases} isLoading={loading} />
      </div>

      <div className="bg-white rounded-xl shadow-md p-6">
        <h3 className="text-lg font-bold mb-4">Recent cases</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Organization</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Examiner</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Case Number</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Case Name</th>
              </tr>
            </thead>
            <tbody>
              {recentCases.map((caseItem) => (
                <tr
                  key={caseItem.caseNumber}
                  className="hover:bg-gray-50 border-b cursor-pointer"
                  onClick={() => navigate(`/cases/${caseItem.caseNumber}`)}
                >
                  <td className="px-4 py-3 text-sm">{caseItem.date || caseItem.lastUpdated || '—'}</td>
                  <td className="px-4 py-3 text-sm">{caseItem.organization || '—'}</td>
                  <td className="px-4 py-3 text-sm">{caseItem.examiner || '—'}</td>
                  <td
                    className="px-4 py-3 text-sm font-medium"
                    style={{ color: '#019348' }}
                  >
                    {caseItem.caseNumber}
                  </td>
                  <td className="px-4 py-3 text-sm">{caseItem.caseName}</td>
                </tr>
              ))}
              {!loading && recentCases.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-500">
                    No recent cases to display.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-500">
                    Loading recent cases…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
