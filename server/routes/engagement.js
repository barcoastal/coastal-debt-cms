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
// GET /api/engagement/posts
// Fetch recent posts from both Facebook page and Instagram account
// ---------------------------------------------------------------------------
router.get('/posts', authenticateToken, async (req, res) => {
  try {
    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const { token, pageId } = page;
    const targetPageId = pageId || MAIN_PAGE_ID;

    // Get ad account ID from config for fetching ads
    const config = db.prepare('SELECT ad_account_id FROM facebook_config WHERE id = 1').get();
    const adAccountId = config?.ad_account_id || '';

    // Fetch FB posts, IG posts, and FB ads in parallel
    const fetches = [
      graphGet(`/${targetPageId}/posts`, token, {
        fields: 'message,created_time,full_picture,permalink_url,comments.summary(true),likes.summary(true)',
        limit: '20',
      }),
      graphGet(`/${IG_ACCOUNT_ID}/media`, token, {
        fields: 'caption,timestamp,media_url,permalink,thumbnail_url,media_type,comments_count,like_count',
        limit: '20',
      }),
    ];

    // Fetch ads if ad account is configured — need user token for ads API
    const userConfig = db.prepare('SELECT page_access_token FROM facebook_config WHERE id = 1').get();
    const userToken = userConfig?.page_access_token || token;
    if (adAccountId) {
      const actId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
      fetches.push(
        graphGet(`/${actId}/ads`, userToken, {
          fields: 'name,creative{title,body,image_url,thumbnail_url,effective_object_story_id,asset_feed_spec{images,videos}},created_time,effective_status,insights.date_preset(last_7d){impressions,clicks,spend,actions}',
          limit: '20',
          filtering: JSON.stringify([{field:'effective_status',operator:'IN',value:['ACTIVE','PAUSED']}]),
        })
      );
    }

    const [fbData, igData, adsData] = await Promise.all(fetches);

    // Normalize FB posts
    const fbPosts = (fbData.data || []).map((p) => ({
      id: p.id,
      message: p.message || '',
      created_time: p.created_time,
      image: p.full_picture || null,
      permalink: p.permalink_url || null,
      comments_count: p.comments?.summary?.total_count || 0,
      likes_count: p.likes?.summary?.total_count || 0,
      platform: 'facebook',
      type: 'post',
    }));

    // Normalize IG posts
    const igPosts = (igData.data || []).map((p) => ({
      id: p.id,
      message: p.caption || '',
      created_time: p.timestamp,
      image: (p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url) || p.thumbnail_url || null,
      permalink: p.permalink || null,
      media_type: p.media_type || null,
      comments_count: p.comments_count || 0,
      likes_count: p.like_count || 0,
      platform: 'instagram',
      type: 'post',
    }));

    // Helper: upscale FB thumbnail URL from 64x64 to 480x480
    function upscaleThumb(url) {
      if (!url) return null;
      return url.replace(/p64x64/g, 'p480x480').replace(/q75/g, 'q90');
    }

    // Normalize FB ads
    const fbAds = (adsData?.data || []).map((ad) => {
      const creative = ad.creative || {};
      const insights = ad.insights?.data?.[0] || {};
      const storyId = creative.effective_object_story_id || creative.object_story_id || '';
      // Extract image: asset_feed_spec images/videos → creative image_url → upscaled thumbnail
      const feedSpec = creative.asset_feed_spec || {};
      const feedImage = feedSpec.images?.[0]?.url || feedSpec.images?.[0]?.hash || null;
      const feedVideoThumb = feedSpec.videos?.[0]?.thumbnail_url || null;
      const adImage = creative.image_url || feedVideoThumb || feedImage || upscaleThumb(creative.thumbnail_url) || null;
      return {
        id: storyId || ad.id,
        ad_id: ad.id,
        message: creative.body || creative.title || ad.name || '',
        created_time: ad.created_time,
        image: adImage,
        permalink: storyId ? `https://www.facebook.com/${storyId}` : null,
        comments_count: 0,
        likes_count: 0,
        platform: 'facebook',
        type: 'ad',
        status: ad.effective_status,
        insights: {
          impressions: insights.impressions || '0',
          clicks: insights.clicks || '0',
          spend: insights.spend || '0',
          leads: (insights.actions || []).find(a => a.action_type === 'lead')?.value || '0',
        },
      };
    });

    // For ads with object_story_id, fetch the actual post to get image + comment/like counts
    await Promise.all(fbAds.map(async (ad) => {
      if (ad.id && ad.id.includes('_')) {
        try {
          const postData = await graphGet(`/${ad.id}`, token, {
            fields: 'full_picture,message,comments.summary(true),likes.summary(true)',
          });
          if (postData.full_picture) ad.image = postData.full_picture;
          if (postData.message && !ad.message) ad.message = postData.message;
          ad.comments_count = postData.comments?.summary?.total_count || 0;
          ad.likes_count = postData.likes?.summary?.total_count || 0;
        } catch (_) {}
      }
    }));

    // Merge and sort by date descending
    const posts = [...fbPosts, ...igPosts, ...fbAds].sort(
      (a, b) => new Date(b.created_time) - new Date(a.created_time)
    );

    // Debug: log image status
    const withImg = posts.filter(p => p.image).length;
    const withoutImg = posts.filter(p => !p.image).length;
    console.log(`[engagement] Posts: ${posts.length} total, ${withImg} with image, ${withoutImg} without`);
    if (posts.length > 0 && !posts[0].image) {
      console.log('[engagement] First post raw:', JSON.stringify(posts[0]).substring(0, 300));
    }

    return res.json({ posts });
  } catch (err) {
    console.error('[engagement] Error fetching posts:', err);
    return res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/engagement/posts/:id/comments
// Fetch comments on a specific post
// ---------------------------------------------------------------------------
router.get('/posts/:id/comments', authenticateToken, async (req, res) => {
  try {
    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const { platform } = req.query;
    const postId = req.params.id;

    let comments = [];

    if (platform === 'instagram') {
      const data = await graphGet(`/${postId}/comments`, page.token, {
        fields: 'from,text,timestamp,like_count,replies{from,text,timestamp,like_count}',
        limit: '50',
      });

      if (data.error) {
        return res.status(400).json({ error: data.error.message || 'Graph API error' });
      }

      // Normalize IG comments: text -> message, timestamp -> created_time
      comments = (data.data || []).map((c) => ({
        id: c.id,
        from: c.from || { name: 'Unknown', id: null },
        message: c.text || '',
        created_time: c.timestamp,
        like_count: c.like_count || 0,
        replies: (c.replies?.data || []).map((r) => ({
          id: r.id,
          from: r.from || { name: 'Unknown', id: null },
          message: r.text || '',
          created_time: r.timestamp,
          like_count: r.like_count || 0,
        })),
        platform: 'instagram',
      }));
    } else {
      // Default to Facebook
      const data = await graphGet(`/${postId}/comments`, page.token, {
        fields: 'from,message,created_time,like_count,comments{from,message,created_time,like_count}',
        limit: '50',
      });

      if (data.error) {
        return res.status(400).json({ error: data.error.message || 'Graph API error' });
      }

      comments = (data.data || []).map((c) => ({
        id: c.id,
        from: c.from || { name: 'Unknown', id: null },
        message: c.message || '',
        created_time: c.created_time,
        like_count: c.like_count || 0,
        replies: (c.comments?.data || []).map((r) => ({
          id: r.id,
          from: r.from || { name: 'Unknown', id: null },
          message: r.message || '',
          created_time: r.created_time,
          like_count: r.like_count || 0,
        })),
        platform: 'facebook',
      }));
    }

    return res.json({ comments });
  } catch (err) {
    console.error('[engagement] Error fetching comments:', err);
    return res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/engagement/comments/:id/like
// Like a comment
// ---------------------------------------------------------------------------
router.post('/comments/:id/like', authenticateToken, async (req, res) => {
  try {
    const { platform } = req.body;
    const commentId = req.params.id;

    if (platform === 'instagram') {
      return res.json({ success: false, error: 'Instagram comment likes not supported via API' });
    }

    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const data = await graphPost(`/${commentId}/likes`, page.token, {});

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Graph API error' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[engagement] Error liking comment:', err);
    return res.status(500).json({ error: 'Failed to like comment' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/engagement/comments/:id/reply
// Reply to a comment
// ---------------------------------------------------------------------------
router.post('/comments/:id/reply', authenticateToken, async (req, res) => {
  try {
    const { message, platform } = req.body;
    const commentId = req.params.id;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    let data;

    if (platform === 'instagram') {
      data = await graphPost(`/${commentId}/replies`, page.token, { message });
    } else {
      data = await graphPost(`/${commentId}/comments`, page.token, { message });
    }

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Graph API error' });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[engagement] Error replying to comment:', err);
    return res.status(500).json({ error: 'Failed to reply to comment' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/engagement/posts/:id/like-comment
// Like a specific comment (alternative endpoint)
// ---------------------------------------------------------------------------
router.post('/posts/:id/like-comment', authenticateToken, async (req, res) => {
  try {
    const { platform } = req.body;
    const commentId = req.params.id;

    if (platform === 'instagram') {
      return res.json({ success: false, error: 'Instagram comment likes not supported via API' });
    }

    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const data = await graphPost(`/${commentId}/likes`, page.token, {});

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Graph API error' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[engagement] Error liking comment:', err);
    return res.status(500).json({ error: 'Failed to like comment' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/engagement/stats
// Quick stats: total comments today, total likes, unanswered comments
// ---------------------------------------------------------------------------
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const page = await getPageToken();
    if (!page) {
      return res.status(400).json({ error: 'Facebook config not found or missing page_access_token' });
    }

    const { token, pageId } = page;
    const targetPageId = pageId || MAIN_PAGE_ID;

    // Fetch recent posts from both platforms to calculate stats
    const [fbData, igData] = await Promise.all([
      graphGet(`/${targetPageId}/posts`, token, {
        fields: 'comments.summary(true),likes.summary(true),created_time',
        limit: '20',
      }),
      graphGet(`/${IG_ACCOUNT_ID}/media`, token, {
        fields: 'comments_count,like_count,timestamp',
        limit: '20',
      }),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totalComments = 0;
    let totalLikes = 0;
    let commentsToday = 0;

    // Aggregate FB stats
    for (const post of (fbData.data || [])) {
      const commentCount = post.comments?.summary?.total_count || 0;
      const likeCount = post.likes?.summary?.total_count || 0;
      totalComments += commentCount;
      totalLikes += likeCount;

      if (new Date(post.created_time) >= today) {
        commentsToday += commentCount;
      }
    }

    // Aggregate IG stats
    for (const post of (igData.data || [])) {
      totalComments += post.comments_count || 0;
      totalLikes += post.like_count || 0;

      if (new Date(post.timestamp) >= today) {
        commentsToday += post.comments_count || 0;
      }
    }

    return res.json({
      stats: {
        comments_today: commentsToday,
        total_comments: totalComments,
        total_likes: totalLikes,
      },
    });
  } catch (err) {
    console.error('[engagement] Error fetching stats:', err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/engagement/image-proxy
// Proxy Facebook/Instagram CDN images to avoid CORS/referrer blocks
// ---------------------------------------------------------------------------
router.get('/image-proxy', authenticateToken, async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || (!url.includes('fbcdn.net') && !url.includes('instagram.') && !url.includes('facebook.'))) {
      return res.status(400).send('Invalid URL');
    }
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).send('Image fetch failed');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send('Proxy error');
  }
});

module.exports = router;
