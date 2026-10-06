const router = require('express').Router();
const db = require('../database');
const store = require('../lib/ab-tests');
const { report } = require('../lib/ab-report');
const { authenticateToken } = require('./auth');
const outcomes = require('../lib/ab-outcomes').createOutcomes(db);
if (outcomes.enabled) {
  setTimeout(() => outcomes.refresh(), 10000).unref();
  setInterval(() => outcomes.refresh(), 5 * 60 * 1000).unref();
}

router.post('/exposure', (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return res.sendStatus(400);
  const row = db.prepare('SELECT r.page_id FROM ab_participants p JOIN ab_runs r ON r.id = p.run_id WHERE p.token = ?').get(token);
  if (!row || req.cookies?.[`ab_session_${row.page_id}`] !== token) return res.sendStatus(400);
  store.expose(token);
  res.sendStatus(204);
});
router.get('/', authenticateToken, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = report(store, req.query);
    if (req.query.source !== 'historical') await outcomes.refresh();
    res.json(outcomes.enrich(result, req.query));
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
module.exports = router;
