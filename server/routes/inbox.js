const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('./auth');

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const MAIN_PAGE_ID = '111392035105994';
const IG_ACCOUNT_ID = '17841460812475563';

// ---------------------------------------------------------------------------
// Helper: resolve page token + page ID from the stored token in facebook_config
// ---------------------------------------------------------------------------
async function getPageToken() {
  const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
  if (!config || !config.page_access_token) {
    return null;
  }

  // The stored token may be a user token – try /me/accounts first
  try {
    const res = await fetch(
      `${GRAPH_API}/me/accounts?access_token=${config.page_access_token}`
    );
    const data = await res.json();

    if (data.data && data.data.length > 0) {
      const mainPage =
        data.data.find((p) => p.id === MAIN_PAGE_ID) || data.data[0];
      return {
        token: mainPage.access_token,
        pageId: mainPage.id,
        pageName: mainPage.name,
      };
    }
  } catch (_) {
    // fall through
  }

  // Fallback: the stored value is already a page token
  return {
    token: config.page_access_token,
    pageId: MAIN_PAGE_ID,
    pageName: null,
  };
}

// ---------------------------------------------------------------------------
// Helper: fetch JSON from Graph API (GET)
// ---------------------------------------------------------------------------
async function graphGet(path, token, params = {}) {
  const url = new URL(`${GRAPH_API}${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  return res.json();
}

// ---------------------------------------------------------------------------
// Helper: POST JSON to Graph API
// ---------------------------------------------------------------------------
async function graphPost(path, token, body) {
  const res = await fetch(`${GRAPH_API}${path}?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// GET /api/inbox/conversations
// Merged Facebook Messenger + Instagram DM conversations
// ---------------------------------------------------------------------------
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const { token, pageId } = page;
    const targetPageId = pageId || MAIN_PAGE_ID;

    // Fetch FB and IG conversations in parallel
    const [fbData, igData] = await Promise.all([
      graphGet(`/${targetPageId}/conversations`, token, {
        fields: 'participants,updated_time,message_count,unread_count,snippet',
        limit: '20',
      }),
      graphGet(`/${targetPageId}/conversations`, token, {
        fields: 'participants,updated_time,message_count,snippet',
        platform: 'instagram',
        limit: '20',
      }),
    ]);

    // Normalize participants: flatten .data array and filter out the page itself
    function normalizeConv(c, platform) {
      const allParticipants = c.participants?.data || c.participants || [];
      const others = allParticipants.filter(p => p.id !== targetPageId);
      return {
        ...c,
        participants: others.length > 0 ? others : allParticipants,
        platform,
      };
    }

    const fbConversations = (fbData.data || []).map((c) => normalizeConv(c, 'facebook'));
    const igConversations = (igData.data || []).map((c) => normalizeConv(c, 'instagram'));

    // Merge and sort newest first
    const merged = [...fbConversations, ...igConversations].sort(
      (a, b) => new Date(b.updated_time) - new Date(a.updated_time)
    );

    return res.json({ conversations: merged });
  } catch (err) {
    console.error('[inbox] Error fetching conversations:', err);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inbox/conversations/:id/messages
// ---------------------------------------------------------------------------
router.get('/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const data = await graphGet(`/${req.params.id}/messages`, page.token, {
      fields: 'from,message,created_time,attachments{mime_type,size,url,name}',
      limit: '50',
    });

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Graph API error' });
    }

    return res.json({ messages: data.data || [] });
  } catch (err) {
    console.error('[inbox] Error fetching messages:', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inbox/conversations/:id/reply
// Body: { message, platform, recipientId }
// ---------------------------------------------------------------------------
router.post('/conversations/:id/reply', authenticateToken, async (req, res) => {
  try {
    const { message, recipientId } = req.body;

    if (!message || !recipientId) {
      return res.status(400).json({ error: 'message and recipientId are required' });
    }

    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const data = await graphPost('/me/messages', page.token, {
      recipient: { id: recipientId },
      message: { text: message },
    });

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Graph API error' });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[inbox] Error sending reply:', err);
    return res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inbox/unread-count
// Quick badge count from FB conversations
// ---------------------------------------------------------------------------
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const page = await getPageToken();
    if (!page) {
      return res.json({ unread: 0 });
    }

    const targetPageId = page.pageId || MAIN_PAGE_ID;

    const data = await graphGet(`/${targetPageId}/conversations`, page.token, {
      fields: 'unread_count',
      limit: '100',
    });

    const total = (data.data || []).reduce(
      (sum, c) => sum + (c.unread_count || 0),
      0
    );

    return res.json({ unread: total });
  } catch (err) {
    console.error('[inbox] Error fetching unread count:', err);
    return res.json({ unread: 0 });
  }
});

module.exports = router;
