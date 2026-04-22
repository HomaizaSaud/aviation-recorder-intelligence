const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function configureProxy(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:4000',
      changeOrigin: true,
    }),
  );
};
