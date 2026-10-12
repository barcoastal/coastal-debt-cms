const express = require('express');
const fs = require('fs');
const path = require('path');
const scheduleModel = require('../../public/assets/phone-schedule');
const runtime = ['phone-schedule.js', 'phone-visibility.js'].map(file =>
  fs.readFileSync(path.join(__dirname, '../../public/assets', file), 'utf8')).join('\n');

module.exports = function phoneScheduleRoutes(db, authenticateToken) {
  const router = express.Router();
  function payload() {
    const saved = db.prepare("SELECT value FROM settings WHERE key = 'phone_schedule'").get();
    const schedule = saved ? scheduleModel.normalize(JSON.parse(saved.value)) : scheduleModel.defaults();
    return {schedule, serverTime: Date.now()};
  }
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('CDN-Cache-Control', 'no-store');
    next();
  });
  // Only the phone schedule is public, never the rest of the platform settings.
  router.get('/public', (_req, res) => res.json(payload()));
  router.get('/runtime.js', (_req, res) => {
    const data = JSON.stringify(payload()).replace(/</g, '\\u003c');
    res.type('js').send(runtime + '\nstartCoastalPhoneVisibility(' + data + ');');
  });
  router.get('/', authenticateToken, (_req, res) => res.json(payload()));
  router.put('/', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({error: 'Admin access required'});
    let schedule;
    try { schedule = scheduleModel.normalize(req.body); }
    catch (error) { return res.status(400).json({error: error.message}); }
    const save = db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('phone_schedule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(schedule));
      db.prepare('INSERT INTO activity_logs (user_id, user_name, action, entity_type, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, req.user.name || req.user.email, 'updated', 'settings', 'Updated landing-page phone schedule: ' + schedule.mode + ' (' + schedule.timezone + ')', req.ip);
    });
    save();
    res.json(payload());
  });
  return router;
};
