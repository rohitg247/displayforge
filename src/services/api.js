const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function getToken() {
  // localStorage (shared across same-origin tabs) so a preview popup inherits the token; the httpOnly
  // session cookie (sent via credentials:'include') is the primary auth, this is the Bearer fallback.
  return localStorage.getItem('actis_token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });

  if (res.status === 401) {
    let detail = 'Unauthorized';
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // Response wasn't JSON
    }
    console.error('[auth] 401 on', options.method || 'GET', path, '-', detail);
    localStorage.removeItem('actis_token');
    window.location.href = '/admin/login';
    throw new Error(detail);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      message = err.detail || message;
    } catch {
      // Response wasn't JSON
    }
    throw new Error(message);
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Auth
  login: (email, password) =>
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    request('/api/auth/logout', { method: 'POST' }).catch(() => {}),

  // Tree (full nested data)
  getBranchesTree: () => request('/api/branches/tree'),

  // Branches
  getBranches: () => request('/api/branches'),
  createBranch: (name) =>
    request('/api/branches', { method: 'POST', body: JSON.stringify({ name }) }),
  updateBranch: (id, name) =>
    request(`/api/branches/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteBranch: (id) =>
    request(`/api/branches/${id}`, { method: 'DELETE' }),

  // Displays
  getDisplays: (branchId) =>
    request(`/api/displays${branchId ? `?branch_id=${branchId}` : ''}`),
  getDisplay: (id, admin = false) => {
    const params = admin ? '?admin=true' : '';
    return fetch(`${API_BASE}/api/displays/${id}${params}`).then((r) => {
      if (!r.ok) throw new Error('Failed to fetch display');
      return r.json();
    });
  },
  createDisplay: (branchId, name) =>
    request('/api/displays', {
      method: 'POST',
      body: JSON.stringify({ branch_id: branchId, name }),
    }),
  updateDisplay: (id, name) =>
    request(`/api/displays/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteDisplay: (id) =>
    request(`/api/displays/${id}`, { method: 'DELETE' }),

  // Case Studies
  getCaseStudies: (displayId) =>
    request(`/api/case-studies${displayId ? `?display_id=${displayId}` : ''}`),
  createCaseStudy: (displayId, data) =>
    request('/api/case-studies', {
      method: 'POST',
      body: JSON.stringify({ display_id: displayId, ...data }),
    }),
  updateCaseStudy: (id, data) =>
    request(`/api/case-studies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCaseStudy: (id) =>
    request(`/api/case-studies/${id}`, { method: 'DELETE' }),
  publishCaseStudy: (id) =>
    request(`/api/case-studies/${id}/publish`, { method: 'POST' }),
  unpublishCaseStudy: (id) =>
    request(`/api/case-studies/${id}/unpublish`, { method: 'POST' }),

  // Image uploads
  uploadThumbnails: (caseStudyId, files) => {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    return request(`/api/uploads/case-study/${caseStudyId}/thumbnails`, {
      method: 'POST',
      body: formData,
    });
  },
  deleteThumbnail: (caseStudyId, index) =>
    request(`/api/uploads/case-study/${caseStudyId}/thumbnails/${index}`, {
      method: 'DELETE',
    }),

  // Ambient Displays
  getAmbientDisplays: () => request('/api/ambient'),
  getAmbientDisplay: (id, playlist, admin = false) => {
    const params = new URLSearchParams();
    if (playlist) params.append('playlist', playlist);
    if (admin) params.append('admin', 'true');
    return fetch(`${API_BASE}/api/ambient/${id}?${params}`).then((r) => {
      if (!r.ok) throw new Error('Failed to fetch ambient display');
      return r.json();
    });
  },

  createAmbientDisplay: (branchId, name, orientation) =>
    request('/api/ambient', {
      method: 'POST',
      body: JSON.stringify({ branch_id: branchId, name, orientation }),
    }),
  updateAmbientDisplay: (id, data) =>
    request(`/api/ambient/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAmbientDisplay: (id) =>
    request(`/api/ambient/${id}`, { method: 'DELETE' }),
  setActivePlaylist: (id, playlist) =>
    request(`/api/ambient/${id}/active-playlist`, {
      method: 'PUT',
      body: JSON.stringify({ playlist }),
    }),
  publishPlaylist: (id, playlist) =>
  request(`/api/ambient/${id}/publish-playlist`, {
    method: 'POST',
    body: JSON.stringify({ playlist }),
  }),  
  uploadAmbientMedia: (displayId, files, playlist = 'A') => {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    formData.append('playlist', playlist);
    return request(`/api/ambient/${displayId}/media`, {
      method: 'POST',
      body: formData,
    });
  },
  reorderAmbientMedia: (displayId, mediaIds) =>
    request(`/api/ambient/${displayId}/media/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ media_ids: mediaIds }),
    }),
  deleteAmbientMedia: (mediaId) =>
    request(`/api/ambient/media/${mediaId}`, { method: 'DELETE' }),

  // Capture of the on-panel ?debug log. Sent as a plain string body (no JSON Content-Type) so the TV
  // browser treats it as a "simple" request and skips the CORS preflight; the backend reads the raw
  // body. Returns the fetch promise so the caller can confirm delivery (res.ok) and retry the batch
  // on failure — no `keepalive` (its 64 kB cap would truncate large catch-up batches).
  postAmbientDebugLog: (id, payload) =>
    fetch(`${API_BASE}/api/ambient/${id}/debug-log`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // Plain-text transcript (not JSON, so it bypasses the JSON `request()` helper). Reuses the same
  // API_BASE as every other call, so the host/port stays env-driven (VITE_API_URL), never hardcoded.
  getAmbientDebugLog: (id, date) => {
    const qs = date ? `?date=${encodeURIComponent(date)}` : '';
    return fetch(`${API_BASE}/api/ambient/${id}/debug-log/latest${qs}`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
  },
};
