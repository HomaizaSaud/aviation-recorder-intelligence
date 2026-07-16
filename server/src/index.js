const express = require('express');
const cors = require('cors');
const casesRouter = require('./routes/cases');
const authRouter = require('./routes/auth');
const accountRouter = require('./routes/account');
const storageRouter = require('./routes/storage');
const errorHandler = require('./middleware/error-handler');
const notFound = require('./middleware/not-found');
const requireAuth = require('./middleware/require-auth');
const initializeDatabase = require('./db/init');
const { initializeStorage } = require('./services/storage');

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/account', requireAuth, accountRouter);
app.use('/api/cases', requireAuth, casesRouter);
app.use('/api/storage', requireAuth, storageRouter);
app.use(notFound);
app.use(errorHandler);

const startServer = async () => {
  try {
    await initializeDatabase();

    try {
      await initializeStorage();
    } catch (storageError) {
      // Keep auth and case APIs available even when local object storage is not configured yet.
      // Storage routes will still report errors when upload/download features are used.
      // eslint-disable-next-line no-console
      console.warn('Object storage initialization failed; continuing without verified storage.', storageError);
    }

    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`API server listening on port ${port}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize API services', error);
    process.exit(1);
  }
};

startServer();
