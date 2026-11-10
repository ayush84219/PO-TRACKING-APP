const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { notFound, handler } = require('./middleware/errors');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(morgan('tiny'));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }), require('./routes/auth'));
app.use('/scans', require('./routes/scans'));
app.use('/materials', require('./routes/materials'));
app.use('/pos', require('./routes/pos'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/users', require('./routes/users'));
app.use('/notifications', require('./routes/notifications'));
app.use('/components', require('./routes/components'));
app.use(notFound);
app.use(handler);
module.exports = app;
