const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../database');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'coastal-debt-cms-encryption-key-32';
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

function getSmtpConfig() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'").all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  return config;
}

function createTransporter() {
  const config = getSmtpConfig();
  if (!config.smtp_host || !config.smtp_user) return null;

  const password = config.smtp_pass ? decrypt(config.smtp_pass) : '';

  return nodemailer.createTransport({
    host: config.smtp_host,
    port: parseInt(config.smtp_port) || 587,
    secure: parseInt(config.smtp_port) === 465,
    auth: {
      user: config.smtp_user,
      pass: password || ''
    }
  });
}

module.exports = { encrypt, decrypt, getSmtpConfig, createTransporter };
