// ═══════════════════════════════════════════════════════════
//  TOAST NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════
function showToast({ title, message = '', type = 'info', duration = 5000 }) {
  const container = document.getElementById('toast-container');
  if (!container) return { dismiss: () => {}, update: () => {} };

  const icons = { success: '✓', error: '✕', info: 'ℹ', loading: '◌' };

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

  toast.querySelector('.toast-title').textContent = title;
  if (message) toast.querySelector('.toast-message').textContent = message;

  container.appendChild(toast);

  const dismiss = () => {
    if (!toast.parentNode) return;
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);

  let timer = null;
  if (duration > 0) timer = setTimeout(dismiss, duration);

  return {
    dismiss,
    update: ({ title: newTitle, message: newMsg, type: newType, duration: newDur = 5000 }) => {
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
      } else if (msgEl) msgEl.remove();
      if (newDur > 0) timer = setTimeout(dismiss, newDur);
    }
  };
}

// ═══════════════════════════════════════════════════════════
//  PAGE ROUTER
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('gallery-grid')) loadGallery();
  if (document.getElementById('booking-form')) setupBookingForm();
  if (document.getElementById('lookup-form')) setupStatusLookup();
  if (document.getElementById('upload-form')) {
    setupUploadForm();
    loadAdminPhotos();
    loadBookings();
  }
  if (document.getElementById('payment-settings-form')) {
    setupPaymentSettingsForm();
  }
});

// ═══════════════════════════════════════════════════════════
//  PUBLIC GALLERY
// ═══════════════════════════════════════════════════════════
async function loadGallery() {
  const grid = document.getElementById('gallery-grid');
  const status = document.getElementById('gallery-status');
  if (!grid) return;

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
async function setupBookingForm() {
  const form = document.getElementById('booking-form');
  const status = document.getElementById('booking-status');
  const methodSelect = document.getElementById('payment-method-select');
  const preview = document.getElementById('payment-preview');
  const depositInput = form.querySelector('input[name="payment_amount"]');
  const paymentPanel = document.getElementById('payment-panel');
  const instructions = document.getElementById('payment-instructions');
  const receiptForm = document.getElementById('receipt-form');
  const receiptStatus = document.getElementById('receipt-status');

  let currentBookingId = null;
  let PAYMENT_METHODS = [];
  let DEPOSIT_AMOUNT = 0;

  try {
    const res = await fetch('/api/payment-methods');
    const data = await res.json();
    PAYMENT_METHODS = data.methods || [];
    DEPOSIT_AMOUNT = data.depositAmount || 0;

    methodSelect.innerHTML = '<option value="">— Select —</option>' +
      PAYMENT_METHODS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');

    if (depositInput && DEPOSIT_AMOUNT > 0) {
      depositInput.value = DEPOSIT_AMOUNT.toFixed(2);
    }
  } catch {
    methodSelect.innerHTML = '<option value="">Failed to load</option>';
  }

  methodSelect.addEventListener('change', () => {
    const method = PAYMENT_METHODS.find(m => m.id === methodSelect.value);
    if (!method) { preview.style.display = 'none'; return; }
    preview.style.display = 'block';
    preview.innerHTML = `
      <div style="background:#161616;border:1px solid #242424;border-left:3px solid #c9a227;border-radius:6px;padding:1.25rem;">
        <p style="margin:0 0 0.5rem;"><strong>Send to:</strong>
          <code style="background:#0a0a0a;padding:0.2rem 0.5rem;border-radius:3px;color:#c9a227;">${escapeHtml(method.handle)}</code>
        </p>
        ${method.link ? `<a href="${method.link}" target="_blank" rel="noopener" class="btn" style="margin-top:0.5rem;font-size:0.85rem;padding:0.6rem 1.25rem;">Open ${method.label}</a>` : ''}
        <p style="margin:0.75rem 0 0;color:#9a9a9a;font-size:0.85rem;">${method.note}</p>
      </div>
    `;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Submitting…';

    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const payload = await res.json();
      if (!res.ok) {
        status.textContent = '❌ ' + (payload.error || 'Something went wrong.');
        return;
      }

      currentBookingId = payload.bookingId;
      const method = PAYMENT_METHODS.find(m => m.id === data.payment_method);

      instructions.innerHTML = `
        <div style="background:#161616;border:1px solid #242424;border-left:3px solid #c9a227;border-radius:6px;padding:1.5rem;max-width:560px;">
          <p style="margin:0 0 0.75rem;"><strong>Method:</strong> ${escapeHtml(method.label)}</p>
          <p style="margin:0 0 0.75rem;"><strong>Reference:</strong>
            <span style="color:#c9a227;font-family:monospace;letter-spacing:2px;">${escapeHtml(payload.referenceCode)}</span>
          </p>
          <p style="margin:0 0 0.75rem;"><strong>Send to:</strong>
            <code style="background:#0a0a0a;padding:0.2rem 0.5rem;border-radius:3px;color:#c9a227;">${escapeHtml(method.handle)}</code>
          </p>
          ${data.payment_amount ? `<p style="margin:0 0 0.75rem;"><strong>Amount:</strong> $${escapeHtml(data.payment_amount)}</p>` : ''}
          ${method.link ? `<a href="${method.link}" target="_blank" rel="noopener" class="btn" style="font-size:0.85rem;padding:0.6rem 1.25rem;">Open ${method.label}</a>` : ''}
          <p style="margin:0.75rem 0 0;color:#9a9a9a;font-size:0.9rem;">${method.note}</p>
        </div>
        <p style="margin-top:1rem;color:#9a9a9a;font-size:0.9rem;">
          After sending, take a screenshot of the confirmation and upload it below.
        </p>
      `;

      status.textContent = `✅ Booking ${payload.referenceCode} created.`;
      paymentPanel.style.display = 'block';
      paymentPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch {
      status.textContent = '❌ Network error. Please try again.';
    }
  });

  receiptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentBookingId) {
      receiptStatus.textContent = '❌ No active booking. Please submit the form first.';
      return;
    }

    const formData = new FormData(receiptForm);
    const file = formData.get('receipt');
    if (!file || !file.size) {
      receiptStatus.textContent = '❌ Please choose a file.';
      return;
    }

    receiptStatus.textContent = 'Uploading receipt…';

    try {
      const res = await fetch(`/api/bookings/${currentBookingId}/receipt`, {
        method: 'POST',
        body: formData
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        receiptStatus.textContent = '❌ ' + (payload.error || 'Upload failed.');
        return;
      }

      receiptStatus.textContent = '✅ Receipt uploaded. We will confirm within 24 hours.';
      receiptForm.reset();
    } catch {
      receiptStatus.textContent = '❌ Network error. Please try again.';
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  STATUS LOOKUP
// ═══════════════════════════════════════════════════════════
function setupStatusLookup() {
  const form = document.getElementById('lookup-form');
  const statusEl = document.getElementById('lookup-status');
  const panel = document.getElementById('result-panel');
  const card = document.getElementById('appointment-card');

  const params = new URLSearchParams(location.search);
  if (params.get('code')) form.reference_code.value = params.get('code').toUpperCase();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.textContent = 'Looking up…';
    panel.style.display = 'none';

    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/appointments/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const payload = await res.json();
      if (!res.ok) {
        statusEl.textContent = '❌ ' + (payload.error || 'Not found.');
        return;
      }

      statusEl.textContent = '';
      renderAppointment(payload);
      panel.style.display = 'block';
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch {
      statusEl.textContent = '❌ Network error. Please try again.';
    }
  });

  function renderAppointment({ appointment: a, accessToken, canDownloadReceipt }) {
    const statusLabel = {
      pending_payment:  { text: 'Awaiting payment',  color: '#b8b8b8' },
      pending_approval: { text: 'Verifying payment', color: '#e0b73a' },
      confirmed:        { text: 'Confirmed',         color: '#5fd88a' },
      cancelled:        { text: 'Cancelled',         color: '#ff8080' }
    }[a.status] || { text: a.status, color: '#999' };

    const dateStr = a.preferred_date
      ? new Date(a.preferred_date).toLocaleDateString('en-US',
          { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : 'To be confirmed';

    card.innerHTML = `
      <div style="background:#161616;border:1px solid #242424;border-radius:10px;padding:2rem;max-width:640px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:1.25rem;border-bottom:1px solid #242424;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem;">
          <div>
            <p style="margin:0;color:#999;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.1em;">Reference</p>
            <p style="margin:0.35rem 0 0;color:#c9a227;font-family:monospace;font-size:1.5rem;letter-spacing:3px;">${escapeHtml(a.reference_code)}</p>
          </div>
          <span style="background:${statusLabel.color}22;color:${statusLabel.color};padding:0.4rem 0.9rem;border-radius:100px;font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">
            ${statusLabel.text}
          </span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem 2rem;">
          <div>
            <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Name</p>
            <p style="margin:0.3rem 0 0;color:#f0ede8;">${escapeHtml(a.name)}</p>
          </div>
          <div>
            <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Email</p>
            <p style="margin:0.3rem 0 0;color:#f0ede8;">${escapeHtml(a.email)}</p>
          </div>
          <div>
            <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Date</p>
            <p style="margin:0.3rem 0 0;color:#f0ede8;">${dateStr}</p>
          </div>
          <div>
            <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Method</p>
            <p style="margin:0.3rem 0 0;color:#f0ede8;text-transform:capitalize;">${escapeHtml(a.payment_method || '—')}</p>
          </div>
          <div>
            <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Amount</p>
            <p style="margin:0.3rem 0 0;color:#f0ede8;">${a.payment_amount ? '$' + parseFloat(a.payment_amount).toFixed(2) : '—'}</p>
          </div>
          ${a.receipt_number ? `<div>
            <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Receipt #</p>
            <p style="margin:0.3rem 0 0;color:#f0ede8;font-family:monospace;">${escapeHtml(a.receipt_number)}</p>
          </div>` : ''}
        </div>

        ${a.description ? `<div style="margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid #242424;">
          <p style="margin:0;color:#999;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;">Your idea</p>
          <p style="margin:0.5rem 0 0;color:#c8c8c8;white-space:pre-wrap;">${escapeHtml(a.description)}</p>
        </div>` : ''}

        ${a.rejection_reason ? `<div style="margin-top:1.5rem;padding:1rem;background:rgba(168,58,58,0.1);border-left:3px solid #a83a3a;border-radius:6px;">
          <p style="margin:0;color:#ff8080;font-size:0.85rem;"><strong>Reason:</strong> ${escapeHtml(a.rejection_reason)}</p>
        </div>` : ''}

        ${canDownloadReceipt ? `<div style="margin-top:2rem;padding-top:1.5rem;border-top:1px solid #242424;">
          <a href="/api/appointments/receipt.pdf?token=${encodeURIComponent(accessToken)}" class="btn" style="text-decoration:none;">⬇ Download Receipt (PDF)</a>
        </div>` : `<p style="margin-top:2rem;color:#999;font-size:0.85rem;padding-top:1.5rem;border-top:1px solid #242424;">
          ${a.status === 'pending_payment' ? 'Upload your payment receipt on the booking page to proceed.' : 'Receipt will be available once your payment is verified.'}
        </p>`}
      </div>
    `;
  }
}

// ═══════════════════════════════════════════════════════════
//  ADMIN: UPLOAD PHOTO
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

    if (!file || !file.size) {
      showToast({ title: 'No file selected', message: 'Please choose an image.', type: 'error', duration: 6000 });
      return;
    }
    if (!file.type.startsWith('image/')) {
      showToast({ title: 'Invalid file type', message: `"${file.name}" is not an image.`, type: 'error', duration: 7000 });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      showToast({ title: 'File too large', message: `"${file.name}" is ${sizeMB} MB. Max 10 MB.`, type: 'error', duration: 7000 });
      return;
    }

    const loadingToast = showToast({ title: `Uploading "${title}"…`, message: file.name, type: 'loading', duration: 0 });

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = 'Uploading…';
    }
    statusEl.textContent = 'Uploading…';

    try {
      const res = await fetch('/api/admin/photos', { method: 'POST', body: formData });

      let payload = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) payload = await res.json().catch(() => null);
      else payload = { error: `Server returned ${res.status}` };

      if (!res.ok) {
        let reason = payload?.error || `Server error (${res.status})`;
        if (res.status === 401) reason = 'Session expired. Re-open the /admin/access URL.';
        else if (res.status === 413) reason = 'File too large. Max 10 MB.';

        loadingToast.update({ title: `Failed to upload "${title}"`, message: reason, type: 'error', duration: 9000 });
        statusEl.textContent = '❌ ' + reason;
        return;
      }

      loadingToast.update({ title: `Photo "${title}" uploaded successfully`, message: `Saved as ID #${payload.id}`, type: 'success', duration: 5000 });
      statusEl.textContent = `✅ "${title}" uploaded successfully.`;
      form.reset();
      loadAdminPhotos();

    } catch (err) {
      loadingToast.update({ title: `Failed to upload "${title}"`, message: err.message || 'Network error.', type: 'error', duration: 9000 });
      statusEl.textContent = '❌ Network error.';
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.originalText || 'Upload';
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN: MANAGE PHOTOS
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
        if (!confirm(`Delete "${photoTitle}"?`)) return;

        try {
          const res = await fetch(`/api/admin/photos/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.status === 401) {
            showToast({ title: 'Session expired', message: 'Re-authenticate via the access URL.', type: 'error', duration: 8000 });
            return;
          }
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            showToast({ title: `Failed to delete`, message: payload.error || 'Server error', type: 'error', duration: 7000 });
            return;
          }
          showToast({ title: `Photo "${photoTitle}" deleted`, type: 'success', duration: 4000 });
          loadAdminPhotos();
        } catch {
          showToast({ title: 'Delete failed', message: 'Network error.', type: 'error', duration: 7000 });
        }
      });
    });
  } catch {
    container.textContent = 'Could not load photos.';
  }
}

// ═══════════════════════════════════════════════════════════
//  ADMIN: BOOKINGS
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

  const methodBadge = (m) => {
    if (!m) return '<span style="color:#6a6a6a;">—</span>';
    const labels = {
      paypal:  { text: 'PayPal',   cls: 'badge-paypal'  },
      venmo:   { text: 'Venmo',    cls: 'badge-venmo'   },
      zelle:   { text: 'Zelle',    cls: 'badge-zelle'   },
      cashapp: { text: 'Cash App', cls: 'badge-cashapp' }
    };
    const info = labels[m.toLowerCase()] || { text: m, cls: 'badge-pending' };
    return `<span class="method-badge ${info.cls}">${info.text}</span>`;
  };

  const table = document.createElement('table');
  table.innerHTML = `
    <tr>
      <th>Name</th>
      <th>Email</th>
      <th>Date</th>
      <th>Method</th>
      <th>Amount</th>
      <th>Receipt</th>
      <th>Status</th>
      <th>Actions</th>
    </tr>`;

  bookings.forEach(b => {
    const tr = document.createElement('tr');

    const receiptCell = b.receipt_url
      ? `<div style="display:flex;align-items:center;gap:0.5rem;">
           <a href="${b.receipt_url}" target="_blank" rel="noopener">
             <img src="${b.receipt_url}" alt="Receipt"
                  style="width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #242424;">
           </a>
           <a href="${b.receipt_url}" target="_blank" rel="noopener"
              style="font-size:0.8rem;color:#c9a227;text-decoration:none;">↓</a>
         </div>`
      : '<span style="color:#6a6a6a;">—</span>';

    const actions = b.status === 'pending_approval'
      ? `<button class="approve-btn" data-id="${b.id}" data-name="${escapeHtml(b.name)}">Approve</button>
         <button class="reject-btn" data-id="${b.id}" data-name="${escapeHtml(b.name)}">Reject</button>`
      : b.status === 'pending_payment'
        ? '<span style="color:#9a9a9a;font-size:0.8rem;">Awaiting receipt</span>'
        : '<span style="color:#6a6a6a;font-size:0.8rem;">—</span>';

    tr.innerHTML = `
      <td>${escapeHtml(b.name)}</td>
      <td><a href="mailto:${escapeHtml(b.email)}" style="color:#c9a227;text-decoration:none;">${escapeHtml(b.email)}</a></td>
      <td>${b.preferred_date ? b.preferred_date.slice(0,10) : '—'}</td>
      <td>${methodBadge(b.payment_method)}</td>
      <td>${b.payment_amount ? '$' + parseFloat(b.payment_amount).toFixed(2) : '—'}</td>
      <td>${receiptCell}</td>
      <td><span class="badge badge-${b.status}">${b.status.replace('_',' ')}</span></td>
      <td style="white-space:nowrap;">${actions}</td>
    `;
    table.appendChild(tr);
  });
  container.appendChild(table);

  container.querySelectorAll('.approve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Approve booking for "${btn.dataset.name}"?`)) return;
      try {
        const res = await fetch(`/api/admin/bookings/${btn.dataset.id}/approve`, { method: 'POST' });
        if (!res.ok) throw new Error();
        showToast({ title: `Booking confirmed for ${btn.dataset.name}`, message: 'Confirmation email sent.', type: 'success', duration: 5000 });
        loadBookings();
      } catch {
        showToast({ title: 'Approval failed', message: 'Could not approve booking.', type: 'error', duration: 6000 });
      }
    });
  });

  container.querySelectorAll('.reject-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const reason = prompt(`Rejection reason for "${btn.dataset.name}":`, 'Payment could not be verified');
      if (reason === null) return;
      try {
        const res = await fetch(`/api/admin/bookings/${btn.dataset.id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        if (!res.ok) throw new Error();
        showToast({ title: `Booking rejected`, message: 'Customer notified.', type: 'info', duration: 5000 });
        loadBookings();
      } catch {
        showToast({ title: 'Rejection failed', message: 'Could not reject booking.', type: 'error', duration: 6000 });
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN: PAYMENT SETTINGS
// ═══════════════════════════════════════════════════════════
async function setupPaymentSettingsForm() {
  const form = document.getElementById('payment-settings-form');
  const status = document.getElementById('payment-settings-status');
  const reloadBtn = document.getElementById('reload-settings');

  async function loadSettings() {
    try {
      const res = await fetch('/api/admin/settings');
      if (res.status === 401) {
        status.textContent = 'Session expired. Re-authenticate via the access URL.';
        return;
      }
      const settings = await res.json();
      Object.entries(settings).forEach(([key, value]) => {
        const field = form.elements[key];
        if (!field) return;
        if (field.type === 'checkbox') field.checked = value === 'true';
        else field.value = value;
      });
    } catch {
      status.textContent = 'Failed to load settings.';
    }
  }

  await loadSettings();

  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      status.textContent = 'Reloading…';
      await loadSettings();
      status.textContent = 'Changes discarded.';
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Saving…';

    const formData = new FormData(form);
    const payload = {};
    for (const [key, value] of formData.entries()) payload[key] = value;
    form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      payload[cb.name] = cb.checked ? 'true' : 'false';
    });

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        status.textContent = '❌ ' + (err.error || 'Save failed.');
        return;
      }

      status.textContent = '✅ Payment settings saved.';
      showToast({ title: 'Payment settings updated', message: 'Live on booking page.', type: 'success', duration: 4000 });
    } catch {
      status.textContent = '❌ Network error.';
    }
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
