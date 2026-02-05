// Check authentication
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/admin/login.html';
      return null;
    }
    const user = await res.json();

    // Update sidebar user info
    const avatar = document.getElementById('userAvatar');
    const name = document.getElementById('userName');
    const email = document.getElementById('userEmail');

    if (avatar) avatar.textContent = user.name.charAt(0).toUpperCase();
    if (name) name.textContent = user.name;
    if (email) email.textContent = user.email;

    return user;
  } catch (err) {
    window.location.href = '/admin/login.html';
    return null;
  }
}

// Logout
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/admin/login.html';
}

// Format date
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Show modal
function showModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

// Hide modal
function hideModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// API helper
async function api(endpoint, options = {}) {
  const res = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'API Error');
  }

  return data;
}

// Run auth check on page load
checkAuth();
