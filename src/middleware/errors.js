class AppError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
// eslint-disable-next-line no-unused-vars
const handler = (err, req, res, next) => {
  if (err.name === 'ZodError') {
    return res.status(400).json({ error: { code: 'validation', message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } });
  }
  if (err.status) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  console.error(err);
  res.status(500).json({ error: { code: 'server', message: 'Something went wrong' } });
};
module.exports = { AppError, wrap, notFound, handler };
