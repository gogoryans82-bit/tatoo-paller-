// ═══════════════════════════════════════════════════════════
//  TOAST NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════

function showToast({ title, message = '', type = 'info', duration = 5000 }) {
  const container = document.getElementById('toast-container');
  if (!container) return { dismiss: () => {} };

  const icons = {
    success: '✓',
    error:   '✕',
    info:    'ℹ',
    loading: '◌'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || '•'}</span>
    <div class="toast-body">
      <div class="toast-title"></div>
      ${message ? '<div class="toast-message"></div>' : ''}
    </div>
    <button class="toast-close" aria-label="Dismiss">×</button>
  `;

  // Use textContent to avoid XSS from photo titles
  toast.querySelector('.toast-title').textContent = title;
  if (message) toast.querySelector('.toast-message').textContent = message;

  container.appendChild(toast);

  const dismiss = () => {
    if (!toast.parentNode) return;
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);

  // Auto-dismiss (0 = stay until manually closed)
  let timer = null;
  if (duration > 0) timer = setTimeout(dismiss, duration);

  return {
    dismiss,
    update: ({ title: newTitle, message: newMsg, type: newType, duration: newDuration = 5000 }) => {
      if (timer) clearTimeout(timer);
      toast.className = `toast toast-${newType}`;
      toast.querySelector('.toast-icon').textContent = icons[newType] || '•';
      toast.querySelector('.toast-title').textContent = newTitle;
      let msgEl = toast.querySelector('.toast-message');
      if (newMsg) {
        if (!msgEl) {
          msgEl = document.createElement('div');
          msgEl.className = 'toast-message';
          toast.querySelector('.toast-body').appendChild(msgEl);
        }
        msgEl.textContent = newMsg;
      } else if (msgEl) {
        msgEl.remove();
      }
      if (newDuration > 0) timer = setTimeout(dismiss, newDuration);
    }
  };
}


// ═══════════════════════════════════════════════════════════
//  PAGE ROUTER
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('gallery-grid')) loadGallery();
  if (document.getElementById('booking-form')) setupBookingForm();
  if (document.getElementById('upload-form')) {
    setupUploadForm();
    loadAdminPhotos();
    loadBookings();
  }
});


// ═══════════════════════════════════════════════════════════
//  PUBLIC GALLERY
// ═══════════════════════════════════════════════════════════

async function loadGallery() {
  const grid = document.getElementById('gallery-grid');
  const status = document.getElementById('gallery-status');

  try {
    const res = await fetch('/api/photos');
    const photos = await res.json();

    if (photos.length === 0) {
      status.textContent = 'No photos yet. Check back soon!';
      return;
    }

    status.textContent = '';
    photos.forEach(p => {
      const fig = document.createElement('figure');
      fig.innerHTML = `
        <img src="${p.cloudinary_url}" alt="${escapeHtml(p.title)}" loading="lazy">
        <figcaption>${escapeHtml(p.title)}</figcaption>
      `;
      grid.appendChild(fig);
    });
  } catch {
    status.textContent = 'Could not load gallery.';
  }
}


// ═══════════════════════════════════════════════════════════
//  BOOKING FORM
// ═══════════════════════════════════════════════════════════

function setupBookingForm() {
  const form = document.getElementById('booking-form');
  const status = document.getElementById('booking-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Sending…';

    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (res.ok) {
        status.textContent = '✅ Request sent! We will contact you soon.';
        form.reset();
      } else {
        const err = await res.json().catch(() => ({}));
        status.textContent = '❌ ' + (err.error || 'Something went wrong.');
      }
    } catch {
      status.textContent = '❌ Network error. Please try again.';
    }
  });
}


// ═══════════════════════════════════════════════════════════
//  ADMIN: UPLOAD PHOTO (with full exception handling)
// ═══════════════════════════════════════════════════════════

function setupUploadForm() {
  const form = document.getElementById('upload-form');
  const statusEl = document.getElementById('upload-status');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    const file = formData.get('photo');
    const title = (formData.get('title') || '').trim() || 'Untitled';
    const description = (formData.get('description') || '').trim();

    // ── Client-side validation ─────────────────────────────
    if (!file || !file.size) {
      showToast({
        title: 'No file selected',
        message: 'Please choose an image before uploading.',
        type: 'error',
        duration: 6000
      });
      return;
    }

    if (!file.type.startsWith('image/')) {
      showToast({
        title: 'Invalid file type',
        message: `"${file.name}" is not an image. Please upload JPG, PNG, GIF, or WebP.`,
        type: 'error',
        duration: 7000
      });
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      showToast({
        title: 'File too large',
        message: `"${file.name}" is ${sizeMB} MB. Maximum size is 10 MB.`,
        type: 'error',
        duration: 7000
      });
      return;
    }

    // ── Show loading toast ────────────────────────────────
    const loadingToast = showToast({
      title: `Uploading "${title}"…`,
      message: file.name,
      type: 'loading',
      duration: 0
    });

    // Disable button to prevent double-submits
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = 'Uploading…';
    }
    statusEl.textContent = 'Uploading…';

    // ── Send request ───────────────────────────────────────
    try {
      const res = await fetch('/api/admin/photos', {
        method: 'POST',
        body: formData
      });

      // Try to read JSON — but be defensive if the server sent HTML
      let payload = null;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        payload = await res.json().catch(() => null);
      } else {
        const text = await res.text().catch(() => '');
        payload = { error: text || `Server returned ${res.status}` };
      }

      // ── Handle HTTP error codes ────────────────────────
      if (!res.ok) {
        let reason = payload?.error || `Server error (${res.status})`;

        if (res.status === 401) {
          reason = 'Your admin session has expired. Re-open the /admin/access URL with your key.';
        } else if (res.status === 413) {
          reason = 'File too large. Maximum size is 10 MB.';
        } else if (res.status === 400) {
          reason = payload?.error || 'Invalid request.';
        } else if (res.status === 500) {
          reason = payload?.error || 'Server error while uploading to storage.';
        }

        loadingToast.update({
          title: `Failed to upload "${title}"`,
          message: reason,
          type: 'error',
          duration: 9000
        });

        statusEl.textContent = '❌ ' + reason;
        return;
      }

      // ── Success ────────────────────────────────────────
      loadingToast.update({
        title: `Photo "${title}" uploaded successfully`,
        message: `Saved as ID #${payload.id}`,
        type: 'success',
        duration: 5000
      });

      statusEl.textContent = `✅ "${title}" uploaded successfully.`;

      form.reset();
      loadAdminPhotos();

    } catch (err) {
      // Network failure, CORS, offline, etc.
      loadingToast.update({
        title: `Failed to upload "${title}"`,
        message: err.message || 'Network error. Check your connection and try again.',
        type: 'error',
        duration: 9000
      });

      statusEl.textContent = '❌ Network error. Please try again.';

    } finally {
      // Always re-enable the button
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.originalText || 'Upload';
      }
    }
  });
}


// ═══════════════════════════════════════════════════════════
//  ADMIN: LIST & DELETE PHOTOS
// ═══════════════════════════════════════════════════════════

async function loadAdminPhotos() {
  const container = document.getElementById('admin-gallery');
  if (!container) return;

  try {
    const res = await fetch('/api/photos');
    const photos = await res.json();
    container.innerHTML = '';

    if (photos.length === 0) {
      container.textContent = 'No photos yet.';
      return;
    }

    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Preview</th><th>Title</th><th>Actions</th></tr>';
    photos.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><img src="${p.cloudinary_url}" alt="${escapeHtml(p.title)}"></td>
        <td>${escapeHtml(p.title)}</td>
        <td><button class="del-btn" data-id="${p.id}" data-title="${escapeHtml(p.title)}">Delete</button></td>
      `;
      table.appendChild(tr);
    });
    container.appendChild(table);

    container.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const photoTitle = btn.dataset.title;
        if (!confirm(`Delete "${photoTitle}"? This cannot be undone.`)) return;

        try {
          const res = await fetch(`/api/admin/photos/${btn.dataset.id}`, { method: 'DELETE' });

          if (res.status === 401) {
            showToast({
              title: 'Session expired',
              message: 'Re-authenticate via the /admin/access URL.',
              type: 'error',
              duration: 8000
            });
            return;
          }

          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            showToast({
              title: `Failed to delete "${photoTitle}"`,
              message: payload.error || `Server error (${res.status})`,
              type: 'error',
              duration: 7000
            });
            return;
          }

          showToast({
            title: `Photo "${photoTitle}" deleted`,
            type: 'success',
            duration: 4000
          });
          loadAdminPhotos();

        } catch {
          showToast({
            title: `Failed to delete "${photoTitle}"`,
            message: 'Network error.',
            type: 'error',
            duration: 7000
          });
        }
      });
    });
  } catch {
    container.textContent = 'Could not load photos.';
  }
}


// ═══════════════════════════════════════════════════════════
//  ADMIN: LIST & UPDATE BOOKINGS
// ═══════════════════════════════════════════════════════════

async function loadBookings() {
  const container = document.getElementById('bookings-list');
  if (!container) return;

  let res;
  try {
    res = await fetch('/api/admin/bookings');
  } catch {
    container.textContent = 'Network error loading bookings.';
    return;
  }

  if (res.status === 401) {
    container.textContent = 'Session expired. Re-authenticate via the access URL.';
    return;
  }

  const bookings = await res.json();

  if (bookings.length === 0) {
    container.textContent = 'No bookings yet.';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = '<tr><th>Name</th><th>Email</th><th>Date</th><th>Status</th><th>Update</th></tr>';
  bookings.forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(b.name)}</td>
      <td>${escapeHtml(b.email)}</td>
      <td>${b.preferred_date ? b.preferred_date.slice(0,10) : '—'}</td>
      <td><span class="badge badge-${b.status}">${b.status}</span></td>
      <td>
        <select data-id="${b.id}">
          <option value="pending" ${b.status==='pending'?'selected':''}>Pending</option>
          <option value="confirmed" ${b.status==='confirmed'?'selected':''}>Confirmed</option>
          <option value="completed" ${b.status==='completed'?'selected':''}>Completed</option>
          <option value="cancelled" ${b.status==='cancelled'?'selected':''}>Cancelled</option>
        </select>
      </td>
    `;
    table.appendChild(tr);
  });
  container.appendChild(table);

  container.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', async () => {
      try {
        const res = await fetch(`/api/admin/bookings/${sel.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: sel.value })
        });
        if (!res.ok) throw new Error();
        showToast({
          title: 'Booking updated',
          message: `Status changed to "${sel.value}".`,
          type: 'success',
          duration: 3000
        });
        loadBookings();
      } catch {
        showToast({
          title: 'Update failed',
          message: 'Could not update booking status.',
          type: 'error',
          duration: 5000
        });
      }
    });
  });
}


// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
