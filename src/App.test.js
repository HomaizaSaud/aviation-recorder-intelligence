import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('react-router-dom', () => {
  const React = require('react');

  const RouterContext = React.createContext({ path: '/', setPath: () => {} });

  const BrowserRouter = ({ children }) => {
    const [path, setPath] = React.useState('/');
    const value = React.useMemo(() => ({ path, setPath }), [path]);
    return React.createElement(RouterContext.Provider, { value }, children);
  };

  const Routes = ({ children }) => {
    const { path } = React.useContext(RouterContext);
    const routeChildren = React.Children.toArray(children);
    let match = null;

    for (const child of routeChildren) {
      if (!React.isValidElement(child)) {
        continue;
      }

      const { path: childPath, index, element, children: nested } = child.props;
      if (childPath === path || (index && (path === '/' || path === ''))) {
        match = element ?? null;
        if (nested) {
          match = React.cloneElement(element, {}, nested);
        }
        break;
      }

      if (childPath === '*') {
        match = element ?? null;
      }
    }

    return match;
  };

  const Route = () => null;

  const Navigate = ({ to }) => {
    const { setPath } = React.useContext(RouterContext);
    React.useEffect(() => {
      setPath(typeof to === 'string' ? to : to?.pathname || '/');
    }, [setPath, to]);
    return null;
  };

  const useNavigate = () => {
    const { setPath } = React.useContext(RouterContext);
    return React.useCallback(
      (to) => {
        setPath(typeof to === 'string' ? to : to?.pathname || '/');
      },
      [setPath],
    );
  };

  const useLocation = () => {
    const { path } = React.useContext(RouterContext);
    return { pathname: path };
  };

  const useParams = () => ({ });

  const renderLinkContent = (children, isActive) =>
    typeof children === 'function' ? children({ isActive }) : children;

  const resolveValue = (value, isActive) =>
    typeof value === 'function' ? value({ isActive }) : value;

  const NavLink = ({ children, className, style, to = '#', onClick }) => {
    const { path } = React.useContext(RouterContext);
    const isActive = path === to || (to === '/' && path === '/');
    const resolvedClass = resolveValue(className, isActive);
    const resolvedStyle = resolveValue(style, isActive);

    return React.createElement(
      'a',
      { href: to, className: resolvedClass, style: resolvedStyle, onClick },
      renderLinkContent(children, isActive),
    );
  };

  const Link = ({ children, to = '#', onClick }) =>
    React.createElement('a', { href: to, onClick }, children);

  const Outlet = () => null;

  return {
    BrowserRouter,
    Routes,
    Route,
    Navigate,
    useNavigate,
    useLocation,
    useParams,
    NavLink,
    Link,
    Outlet,
  };
}, { virtual: true });

jest.mock('recharts', () => {
  const React = require('react');
  const Placeholder = ({ children }) => React.createElement(React.Fragment, null, children);
  const NullComponent = () => null;

  return {
    ResponsiveContainer: Placeholder,
    BarChart: Placeholder,
    Bar: NullComponent,
    CartesianGrid: NullComponent,
    XAxis: NullComponent,
    YAxis: NullComponent,
    Tooltip: NullComponent,
    Legend: NullComponent,
  };
}, { virtual: true });

jest.mock('./pages/Dashboard', () => () => null);
jest.mock('./pages/Cases', () => () => null);
jest.mock('./pages/CaseDetails', () => () => null);
jest.mock('./pages/FDR', () => () => null);
jest.mock('./pages/CVR', () => () => null);
jest.mock('./pages/CorrelationComingSoon', () => () => null);
jest.mock('./pages/Report', () => () => null);
jest.mock('./pages/HelpCenter', () => () => null);
jest.mock('./pages/AccountSettings', () => () => null);

jest.mock('./hooks/useAuth', () => {
  const React = require('react');
  const authValue = {
    user: null,
    token: null,
    isLoading: false,
    error: '',
    login: jest.fn(),
    signup: jest.fn(),
    logout: jest.fn(),
    refreshProfile: jest.fn(),
    saveProfile: jest.fn(),
    updatePassword: jest.fn(),
  };

  const AuthContext = React.createContext(authValue);

  const AuthProvider = ({ children }) =>
    React.createElement(AuthContext.Provider, { value: authValue }, children);

  return {
    AuthProvider,
    useAuth: () => React.useContext(AuthContext),
  };
});

import App from './App';

describe('App authentication routing', () => {
  test('redirects unauthenticated users to the login page', async () => {
    render(<App />);

    const heading = await screen.findByRole('heading', { name: /CVR\/FDR Analyzer/i });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/please login to your account/i)).toBeInTheDocument();
  });
});

