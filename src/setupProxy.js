const { createProxyMiddleware } = require('http-proxy-middleware');
module.exports = function configureProxy(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: process.env.REACT_APP_BACKEND_URL || 'http://localhost:4000',
      changeOrigin: true
    }),
  );
};