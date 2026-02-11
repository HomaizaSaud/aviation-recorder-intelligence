// eslint-disable-next-line no-unused-vars
const errorHandler = (error, _req, res, _next) => {
  const status = error.status || 500;
  const isServerError = status >= 500;
  const message = isServerError
    ? 'Unexpected server error. Please try again later.'
    : error.message || 'Invalid request.';

  if (isServerError) {
    // eslint-disable-next-line no-console
    console.error('Unhandled error processing request', error.stack || error);
  }

  const responseBody = { error: message };

  if (isServerError && process.env.NODE_ENV !== 'production') {
    responseBody.details = error.message || 'Unknown error';
  }

  res.status(status).json(responseBody);
};

module.exports = errorHandler;
